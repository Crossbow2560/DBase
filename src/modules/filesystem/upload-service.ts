import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { config } from "../../config.js";
import * as storage from "../storage/client.js";
import { normalizeName, assertPathLengthOk } from "./normalize.js";
import {
  nameCollision,
  folderNotFound,
  quotaExceeded,
  systemStorageLimitExceeded,
  uploadSessionNotFound,
  uploadSessionInvalid,
  partNumberOutOfRange,
  partTooSmall,
  uploadIncomplete,
} from "./errors.js";
import { checkPermission } from "../access/permission-check.js";
import { createOwnerPermission } from "../access/permission-service.js";
import { enqueueThumbnail, isThumbnailable } from "../thumbnails/thumbnail-service.js";
import { logActivity } from "../admin/audit-service.js";

const POSTGRES_UNIQUE_VIOLATION = "P2002";

export async function initUploadSession(
  userId: string,
  input: { targetFolderId: string | null; targetName: string; totalParts: number },
) {
  const name = normalizeName(input.targetName);

  if (input.targetFolderId) {
    if (!(await checkPermission(userId, "folder", input.targetFolderId, "editor"))) throw folderNotFound();
    const folder = await db.folders.findFirst({ where: { id: input.targetFolderId, deleted_at: null } });
    if (!folder) throw folderNotFound();
  }
  await assertPathLengthOk(input.targetFolderId, name);
  await assertNoLiveNameCollision(userId, input.targetFolderId, name);

  const id = randomUUID();
  const expiresAt = new Date(Date.now() + config.uploadSessionTtlMinutes * 60 * 1000);

  await db.upload_sessions.create({
    data: {
      id,
      user_id: userId,
      target_folder_id: input.targetFolderId,
      target_name: name,
      minio_upload_id: id, // no real S3 multipart upload — this storage layer composes temp
      // part objects keyed by this session id (src/modules/storage/client.ts) rather than using
      // MinIO's low-level multipart API, so there's no separate provider-issued id to store.
      total_parts: Math.max(1, input.totalParts),
      expires_at: expiresAt,
    },
  });

  return { uploadSessionId: id, expiresAt };
}

/**
 * REQUIREMENTS.md §5.3/§5.6: each part is checked against quota as it completes, rejected at
 * the point the excess would occur — not allowed to complete and roll back after. Idempotent: a
 * retried part number that already succeeded is a no-op, not a double charge.
 */
export async function uploadPart(userId: string, sessionId: string, partNumber: number, data: Buffer) {
  const session = await db.upload_sessions.findFirst({ where: { id: sessionId, user_id: userId } });
  if (!session || session.status !== "pending") throw uploadSessionNotFound();
  if (session.expires_at < new Date()) throw uploadSessionNotFound();
  // Parts are 0-indexed (web/lib/uploads.tsx) and storage.completeMultipartUpload composes exactly
  // 0..total_parts-1 — any other number would be charged against quota yet never composed or
  // cleaned up.
  if (!Number.isInteger(partNumber) || partNumber < 0 || partNumber >= session.total_parts) {
    throw partNumberOutOfRange(session.total_parts);
  }
  if (partNumber < session.total_parts - 1 && data.byteLength < storage.MIN_PART_SIZE_BYTES) {
    throw partTooSmall(storage.MIN_PART_SIZE_BYTES);
  }

  // Concurrent-mutation guard (REQUIREMENTS.md §5.3): re-verify the destination is still valid
  // before accepting more bytes, not just once at init.
  await assertUploadDestinationStillValid(session);

  // Recording the part and charging quota happen in ONE transaction that holds the session row's
  // lock (a real bug, fixed). Previously this was read-then-write — look for an existing part row,
  // charge, upload, then insert — so two simultaneous retries of the same part both saw "not
  // recorded yet" and both charged; the loser's insert then failed with its charge never refunded.
  // Holding the lock also serializes against abortClaimedSession(): an abort either waits and then
  // sees (and refunds) this part, or wins first and this part is rejected before being charged.
  const delta = BigInt(data.byteLength);
  const outcome = await db.$transaction(async (tx) => {
    await lockPendingSession(tx, sessionId);
    const existing = await tx.upload_session_parts.findUnique({
      where: { upload_session_id_part_number: { upload_session_id: sessionId, part_number: partNumber } },
    });
    if (existing) return "duplicate" as const; // idempotent retry, no re-charge, no re-upload.
    await tx.upload_session_parts.create({
      data: { upload_session_id: sessionId, part_number: partNumber, size_bytes: delta },
    });
    if (!(await tryCreditQuota(userId, delta, tx))) throw quotaExceeded(); // rolls back the row too
    return "claimed" as const;
  });
  if (outcome === "duplicate") return;

  try {
    await storage.putPart(sessionId, partNumber, data);
  } catch (err) {
    // Storage write failed after the charge — undo both so a retry starts clean. Skipped if the
    // session is no longer pending: an abort has already refunded this part with the rest.
    await db.$transaction(async (tx) => {
      if (!(await lockPendingSession(tx, sessionId, { throwIfMissing: false }))) return;
      await tx.upload_session_parts.deleteMany({ where: { upload_session_id: sessionId, part_number: partNumber } });
      await tryCreditQuota(userId, -delta, tx);
    });
    throw err;
  }

  // Aborted while the bytes were in flight: the abort refunded this part already, but may have
  // removed the temp objects before this one landed — clean up the straggler.
  const current = await db.upload_sessions.findUnique({ where: { id: sessionId }, select: { status: true } });
  if (current?.status === "aborted") {
    await storage.removeUploadParts(sessionId, session.total_parts);
    throw uploadSessionNotFound();
  }
}

/** SELECT … FOR UPDATE on a still-pending session; the lock lives until `tx` commits. */
async function lockPendingSession(
  tx: Prisma.TransactionClient,
  sessionId: string,
  opts: { throwIfMissing?: boolean } = {},
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM upload_sessions WHERE id = ${sessionId}::uuid AND status = 'pending' FOR UPDATE
  `;
  if (rows.length === 0 && (opts.throwIfMissing ?? true)) throw uploadSessionNotFound();
  return rows.length > 0;
}

/**
 * Order matters here (a real bug, fixed): the FILES row used to be created before the parts were
 * composed in MinIO, so a compose failure left a file row pointing at an object that never
 * existed, with the session still `pending` — the cleanup worker would later abort it and refund
 * the bytes, leaving a dead file that no longer counted against quota.
 *
 * Now: (1) atomically claim the session (pending → complete) so cancel/cleanup can't race this,
 * (2) compose the object, (3) create the file row, owner permission and session link in one DB
 * transaction. A compose failure releases the claim back to `pending` (parts are untouched, so
 * the client can retry or cancel); a DB failure removes the composed object and aborts the
 * session with a refund.
 */
export async function completeUpload(userId: string, sessionId: string, mimeType: string) {
  const claimed = await db.upload_sessions.updateMany({
    where: { id: sessionId, user_id: userId, status: "pending" },
    data: { status: "complete" },
  });
  if (claimed.count === 0) throw uploadSessionNotFound();
  const session = await db.upload_sessions.findUniqueOrThrow({ where: { id: sessionId } });

  const releaseClaim = () =>
    db.upload_sessions.updateMany({
      where: { id: sessionId, status: "complete", file_id: null },
      data: { status: "pending" },
    });

  const parts = await db.upload_session_parts.findMany({ where: { upload_session_id: sessionId } });
  // Exactly 0..total_parts-1, not just the right count — uploadPart rejects out-of-range numbers,
  // but this is the check composition actually depends on.
  const received = new Set(parts.map((p) => p.part_number));
  for (let i = 0; i < session.total_parts; i++) {
    if (!received.has(i)) {
      await releaseClaim();
      throw uploadIncomplete();
    }
  }

  try {
    await assertUploadDestinationStillValid(session);
  } catch (err) {
    await abortClaimedSession(userId, session, "complete");
    throw err;
  }

  const totalBytes = parts.reduce((sum, p) => sum + p.size_bytes, 0n);
  const storageKey = storage.generateStorageKey();

  try {
    await storage.completeMultipartUpload(sessionId, session.total_parts, storageKey);
  } catch (err) {
    await storage.removeObject(storageKey).catch(() => undefined);
    await releaseClaim();
    throw err;
  }

  let file;
  try {
    file = await db.$transaction(async (tx) => {
      const created = await tx.files.create({
        data: {
          owner_id: userId,
          folder_id: session.target_folder_id,
          name: session.target_name,
          size_bytes: totalBytes,
          mime_type: mimeType,
          storage_key: storageKey,
          upload_status: "complete",
        },
      });
      // DESIGN.md §3.6: exactly one owner PERMISSIONS row, inserted with the file itself — same
      // requirement as folder-service.ts's createFolder.
      await createOwnerPermission("file", created.id, userId, tx);
      await tx.upload_sessions.update({ where: { id: sessionId }, data: { file_id: created.id } });
      return created;
    });
  } catch (err) {
    await storage.removeObject(storageKey).catch(() => undefined);
    await abortClaimedSession(userId, session, "complete");
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw nameCollision();
    }
    throw err;
  }

  // REQUIREMENTS.md §5.9: background, best-effort, never blocking this response — enqueueThumbnail
  // only performs a fast DB insert; actual generation happens on the worker's own timer. The
  // in-memory `file` object predates that DB update, so it's patched here too — otherwise this
  // function's return value (serialized straight into the completion response) would report
  // thumbnail_status: "none" even though the DB row was just set to "pending".
  if (isThumbnailable(mimeType)) {
    file.thumbnail_status = "pending";
  }
  await enqueueThumbnail(file.id, mimeType);

  // REQUIREMENTS.md §5.13: always self-owned at creation (uploads never create an item owned by
  // anyone but the uploader, matching folder-service.ts's createFolder) — subject === actor.
  await logActivity({ actorId: userId, subjectUserId: userId, itemType: "file", itemId: file.id, action: "upload" });

  return file;
}

export async function cancelUpload(userId: string, sessionId: string) {
  const session = await db.upload_sessions.findFirst({ where: { id: sessionId, user_id: userId } });
  if (!session || session.status !== "pending") throw uploadSessionNotFound();
  const aborted = await abortClaimedSession(userId, session, "pending");
  if (!aborted) throw uploadSessionNotFound(); // lost a race with completion/cleanup
}

/**
 * DESIGN.md §3.5: a session not resumed before expires_at is automatically abandoned and
 * cleaned up — its bytes removed from storage and not counted against quota. Called by
 * src/workers/upload-session-cleanup.ts on a timer; reuses the exact same abort path an explicit
 * client cancel uses, per that section's "follows the identical procedure, just triggered
 * immediately vs. by the scheduled job" requirement.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const expired = await db.upload_sessions.findMany({
    where: { status: "pending", expires_at: { lt: new Date() } },
  });
  let count = 0;
  for (const session of expired) {
    if (await abortClaimedSession(session.user_id, session, "pending")) count++;
  }
  return count;
}

/**
 * Moves the session from `fromStatus` to `aborted` with a single conditional UPDATE, and only the
 * caller that wins that transition refunds the bytes and removes the parts. Cancel, the cleanup
 * worker and a failing completion can all target the same session concurrently; before this
 * guard each of them refunded independently (a double refund, caught only by the
 * storage_used_bytes >= 0 CHECK as a 500). Returns whether this call performed the abort.
 */
async function abortClaimedSession(
  userId: string,
  session: { id: string; total_parts: number },
  fromStatus: "pending" | "complete",
): Promise<boolean> {
  const claimed = await db.upload_sessions.updateMany({
    where: { id: session.id, status: fromStatus, file_id: null },
    data: { status: "aborted" },
  });
  if (claimed.count === 0) return false;

  const parts = await db.upload_session_parts.findMany({ where: { upload_session_id: session.id } });
  const totalBytes = parts.reduce((sum, p) => sum + p.size_bytes, 0n);
  if (totalBytes > 0n) {
    await tryCreditQuota(userId, -totalBytes);
  }
  await storage.removeUploadParts(session.id, session.total_parts);
  return true;
}

/** REQUIREMENTS.md §5.3: destination folder must still be live, and the target name still free. */
async function assertUploadDestinationStillValid(session: {
  target_folder_id: string | null;
  target_name: string;
  user_id: string;
}): Promise<void> {
  if (session.target_folder_id) {
    const authorized = await checkPermission(session.user_id, "folder", session.target_folder_id, "editor");
    if (!authorized) throw uploadSessionInvalid();
    const folder = await db.folders.findFirst({ where: { id: session.target_folder_id, deleted_at: null } });
    if (!folder) throw uploadSessionInvalid();
  }
  await assertNoLiveNameCollision(session.user_id, session.target_folder_id, session.target_name).catch(() => {
    throw uploadSessionInvalid();
  });
}

// Mirrors the unique indexes (supabase/migrations/0023): inside a folder a name is unique among
// all live files regardless of owner (an editor uploading into a shared folder collides with the
// owner's files too); at the root it's unique within this user's own root.
async function assertNoLiveNameCollision(userId: string, folderId: string | null, name: string): Promise<void> {
  const existing = await db.files.findFirst({
    where: folderId ? { folder_id: folderId, name, deleted_at: null } : { owner_id: userId, folder_id: null, name, deleted_at: null },
  });
  if (existing) throw nameCollision();
}

/**
 * Atomic conditional update (APPLICATION_DESIGN.md §5.2): a single UPDATE ... WHERE ...
 * RETURNING, never read-then-write, so two concurrent part uploads can't both check a stale
 * storage_used_bytes and together exceed quota. Returns false (no row updated) if the increase
 * would exceed the quota — the caller must not treat that as an error to retry, only to reject.
 * A negative delta (credit-back) is deliberately NOT separately guarded against going below
 * zero here — the `users_storage_used_bytes_non_negative` CHECK constraint (0001) is left to
 * catch that case and raise a real error. A credit-back that would go negative means some
 * earlier accounting step double-counted or under-counted; masking that by silently no-op'ing
 * would hide the bug instead of surfacing it.
 *
 * The system-wide cap (supabase/migrations/0015_system_storage_limit.sql) is a separate
 * BEFORE UPDATE trigger on this same UPDATE, not something this function's own WHERE clause
 * checks — it can't be folded into the WHERE clause the way the per-user quota is, since it
 * depends on every OTHER user's row too, not just this one. When it fires, Postgres raises
 * rather than just omitting a row from RETURNING, so it surfaces here as a thrown error, not a
 * false return — translated into the distinct SYSTEM_STORAGE_LIMIT_EXCEEDED error rather than
 * left to read as an unexplained 500, or worse, conflated with QUOTA_EXCEEDED (this account's
 * own quota is not the problem in this case).
 */
async function tryCreditQuota(
  userId: string,
  delta: bigint,
  client: Prisma.TransactionClient = db,
): Promise<boolean> {
  try {
    const rows = await client.$queryRaw<{ storage_used_bytes: bigint }[]>`
      UPDATE users
      SET storage_used_bytes = storage_used_bytes + ${delta}
      WHERE id = ${userId}::uuid
        AND storage_used_bytes + ${delta} <= storage_quota_bytes
      RETURNING storage_used_bytes
    `;
    return rows.length > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("SYSTEM_STORAGE_LIMIT_EXCEEDED")) {
      throw systemStorageLimitExceeded();
    }
    throw err;
  }
}
