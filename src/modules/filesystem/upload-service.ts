import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { config } from "../../config.js";
import * as storage from "../storage/client.js";
import { normalizeName, assertPathLengthOk } from "./normalize.js";
import { contentVersion } from "./content-version.js";
import {
  nameCollision,
  folderNotFound,
  quotaExceeded,
  systemStorageLimitExceeded,
  uploadSessionNotFound,
  uploadSessionInvalid,
  partNumberOutOfRange,
  partTooSmall,
  partTooLarge,
  uploadIncomplete,
  uploadCompleting,
  fileNotFound,
  contentConflict,
} from "./errors.js";
import { checkPermission } from "../access/permission-check.js";
import { createOwnerPermission } from "../access/permission-service.js";
import { enqueueThumbnail, isThumbnailable } from "../thumbnails/thumbnail-service.js";
import { logActivity } from "../admin/audit-service.js";

const POSTGRES_UNIQUE_VIOLATION = "P2002";

export async function initUploadSession(
  userId: string,
  input: {
    targetFolderId: string | null;
    targetName: string;
    totalParts: number;
    /** Replace this file's content instead of creating a new file (supabase/migrations/0029). */
    replaceFileId?: string;
    /** Compare-and-swap for a replace: the file's content version the client last saw. */
    expectedVersion?: string;
    /** The client's SHA-256 of the whole upload, stored as files.checksum. */
    checksum?: string;
  },
) {
  if (input.replaceFileId) return initReplaceSession(userId, { ...input, replaceFileId: input.replaceFileId });

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
      checksum: input.checksum ?? null,
    },
  });

  return { uploadSessionId: id, expiresAt };
}

/**
 * A session that replaces an existing file's content (sync clients pushing a local edit). The
 * destination is the file itself, so there's no name/path check; the target folder and name are
 * recorded only for display. The compare-and-swap is checked here too, so a client that's already
 * behind finds out before sending any bytes — and again at completion, where it actually counts.
 */
async function initReplaceSession(
  userId: string,
  input: { replaceFileId: string; totalParts: number; expectedVersion?: string; checksum?: string },
) {
  if (!(await checkPermission(userId, "file", input.replaceFileId, "editor"))) throw fileNotFound();
  const file = await db.files.findFirst({
    where: { id: input.replaceFileId, deleted_at: null, upload_status: "complete" },
  });
  if (!file) throw fileNotFound();
  if (input.expectedVersion !== undefined && contentVersion(file.storage_key) !== input.expectedVersion) {
    throw contentConflict();
  }

  const id = randomUUID();
  const expiresAt = new Date(Date.now() + config.uploadSessionTtlMinutes * 60 * 1000);
  await db.upload_sessions.create({
    data: {
      id,
      user_id: userId,
      target_folder_id: file.folder_id,
      target_name: file.name,
      minio_upload_id: id,
      total_parts: Math.max(1, input.totalParts),
      expires_at: expiresAt,
      replace_file_id: file.id,
      expected_version: input.expectedVersion ?? null,
      checksum: input.checksum ?? null,
    },
  });
  return { uploadSessionId: id, expiresAt };
}

type RecordOutcome =
  | "recorded"
  | "duplicate"
  | "session_gone"
  | "part_out_of_range"
  | "part_too_small"
  | "part_too_large";

/**
 * REQUIREMENTS.md §5.3/§5.6: each part is checked against quota before its bytes are stored,
 * rejected at the point the excess would occur. Idempotent: a retried part number that was already
 * recorded is a no-op, not a double charge.
 *
 * Built for throughput (uploads of large files were bound by per-part overhead, not bandwidth):
 *   - Validation, the duplicate check and the quota charge are ONE database round trip —
 *     record_upload_part() (supabase/migrations/0025), which holds the session row's lock while it
 *     inserts the part row and charges, preserving the race guarantees of the old transaction
 *     (concurrent retries charge once; an abort either sees this part or rejects it uncharged).
 *   - The quota is charged for the client's declared Content-Length, and the body then streams
 *     straight to MinIO (storage.putPartStream), which enforces that the length matches exactly.
 *   - The destination isn't re-validated per part; init and completion both check it, and nothing a
 *     part does depends on it.
 * Parts may arrive in any order and concurrently; completion composes them by number.
 */
export async function uploadPart(
  userId: string,
  sessionId: string,
  partNumber: number,
  body: Readable,
  sizeBytes: number,
) {
  let outcome: RecordOutcome;
  let totalParts: number | null;
  try {
    const rows = await db.$queryRaw<{ outcome: RecordOutcome; total_parts: number | null }[]>`
      SELECT outcome, total_parts FROM record_upload_part(
        ${sessionId}::uuid, ${userId}::uuid, ${partNumber}::int, ${BigInt(sizeBytes)}::bigint,
        ${BigInt(storage.MIN_PART_SIZE_BYTES)}::bigint, ${BigInt(storage.MAX_PART_SIZE_BYTES)}::bigint
      )
    `;
    outcome = rows[0]!.outcome;
    totalParts = rows[0]!.total_parts;
  } catch (err) {
    if (err instanceof Error && err.message.includes("SYSTEM_STORAGE_LIMIT_EXCEEDED")) throw systemStorageLimitExceeded();
    if (err instanceof Error && err.message.includes("QUOTA_EXCEEDED")) throw quotaExceeded();
    throw err;
  }

  switch (outcome) {
    case "session_gone":
      throw uploadSessionNotFound();
    case "part_out_of_range":
      throw partNumberOutOfRange(totalParts!);
    case "part_too_small":
      throw partTooSmall(storage.MIN_PART_SIZE_BYTES);
    case "part_too_large":
      throw partTooLarge(storage.MAX_PART_SIZE_BYTES);
    case "duplicate":
      return; // already recorded — idempotent retry, no re-charge, no re-upload.
    case "recorded":
      break;
  }

  try {
    await storage.putPartStream(sessionId, partNumber, body, sizeBytes);
  } catch (err) {
    // The bytes never fully reached storage (client disconnected, length mismatch, MinIO error):
    // undo the record and the charge so a retry starts clean. A no-op if the session was aborted
    // meanwhile — that abort already refunded this part along with the rest.
    await db.$queryRaw`SELECT release_upload_part(${sessionId}::uuid, ${userId}::uuid, ${partNumber}::int)`;
    throw err;
  }

  // Aborted while the bytes were in flight: the abort refunded this part already, but may have
  // removed the temp objects before this one landed — clean up the straggler.
  const current = await db.upload_sessions.findUnique({ where: { id: sessionId }, select: { status: true } });
  if (current?.status === "aborted") {
    await storage.removeUploadParts(sessionId, totalParts!);
    throw uploadSessionNotFound();
  }
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
export async function completeUpload(userId: string, sessionId: string, requestedMimeType?: string) {
  const claimed = await db.upload_sessions.updateMany({
    where: { id: sessionId, user_id: userId, status: "pending" },
    data: { status: "complete" },
  });
  if (claimed.count === 0) {
    // Idempotent: a client retrying a completion whose response it never received (dropped
    // connection) gets the file that was already created, instead of a 404 for an upload that in
    // fact succeeded. If the first completion is still running, the retry is told to try again.
    const existing = await db.upload_sessions.findFirst({
      where: { id: sessionId, user_id: userId, status: "complete" },
      select: { file_id: true },
    });
    if (existing && existing.file_id === null) throw uploadCompleting();
    if (existing?.file_id) {
      const file = await db.files.findFirst({ where: { id: existing.file_id, deleted_at: null } });
      if (file) return file;
    }
    throw uploadSessionNotFound();
  }
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

  if (session.replace_file_id) {
    return completeReplace(userId, session, parts, requestedMimeType, releaseClaim);
  }
  const mimeType = requestedMimeType ?? "application/octet-stream";

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
          checksum: session.checksum,
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

type ClaimedSession = Awaited<ReturnType<typeof db.upload_sessions.findUniqueOrThrow>>;

/**
 * completeUpload for a replace session: compose the new object, then in ONE transaction swap it
 * into the existing FILES row (compare-and-swap on the content version), settle quota, and queue the old
 * object (and its thumbnail) for removal. The row keeps its id, name, folder, owner, shares,
 * tags and favorites — only the content changes.
 *
 * Quota: storage_used_bytes counts the bytes of the files a user owns, and the parts were charged
 * to the uploader as they arrived. When the uploader owns the file, the old size is simply
 * credited back now (supabase/migrations/0029: no version history, so the old bytes stop counting
 * immediately). When an editor replaces someone else's file, the editor is refunded the new size
 * and the owner is charged the difference — checked against the owner's quota.
 */
async function completeReplace(
  userId: string,
  session: ClaimedSession,
  parts: { size_bytes: bigint }[],
  requestedMimeType: string | undefined,
  releaseClaim: () => Promise<unknown>,
) {
  const fileId = session.replace_file_id!;
  if (!(await checkPermission(userId, "file", fileId, "editor"))) {
    await abortClaimedSession(userId, session, "complete");
    throw uploadSessionInvalid();
  }

  const newSize = parts.reduce((sum, p) => sum + p.size_bytes, 0n);
  const storageKey = storage.generateStorageKey();
  try {
    await storage.completeMultipartUpload(session.id, session.total_parts, storageKey);
  } catch (err) {
    await storage.removeObject(storageKey).catch(() => undefined);
    await releaseClaim();
    throw err;
  }

  let file;
  try {
    file = await db.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<
        {
          owner_id: string;
          size_bytes: bigint;
          storage_key: string;
          thumbnail_key: string | null;
          checksum: string | null;
          mime_type: string;
          deleted_at: Date | null;
        }[]
      >`
        SELECT owner_id, size_bytes, storage_key, thumbnail_key, checksum, mime_type, deleted_at
        FROM files WHERE id = ${fileId}::uuid FOR UPDATE
      `;
      if (!current || current.deleted_at !== null) throw contentConflict();
      if (session.expected_version !== null && contentVersion(current.storage_key) !== session.expected_version) {
        throw contentConflict();
      }

      if (current.owner_id === userId) {
        await adjustUsage(tx, userId, -current.size_bytes);
      } else {
        await adjustUsage(tx, userId, -newSize);
        const ownerDelta = newSize - current.size_bytes;
        if (ownerDelta > 0n) {
          if (!(await tryCreditQuota(current.owner_id, ownerDelta, tx))) throw quotaExceeded();
        } else if (ownerDelta < 0n) {
          await adjustUsage(tx, current.owner_id, ownerDelta);
        }
      }

      const updated = await tx.files.update({
        where: { id: fileId },
        data: {
          storage_key: storageKey,
          size_bytes: newSize,
          checksum: session.checksum,
          mime_type: requestedMimeType ?? current.mime_type,
          thumbnail_status: "none",
          thumbnail_key: null,
        },
      });

      await tx.deletion_queue.create({
        data: {
          item_type: "file",
          item_id: randomUUID(),
          storage_key: current.storage_key,
          thumbnail_key: current.thumbnail_key,
          owner_id: null,
          size_bytes: 0n,
          blob_only: true,
        },
      });
      await tx.upload_sessions.update({ where: { id: session.id }, data: { file_id: fileId } });
      return updated;
    });
  } catch (err) {
    await storage.removeObject(storageKey).catch(() => undefined);
    await abortClaimedSession(userId, session, "complete");
    throw err;
  }

  if (isThumbnailable(file.mime_type)) {
    file.thumbnail_status = "pending";
  }
  await enqueueThumbnail(file.id, file.mime_type);

  await logActivity({
    actorId: userId,
    subjectUserId: file.owner_id,
    itemType: "file",
    itemId: file.id,
    action: "upload",
    metadata: { replaced: true },
  });

  return file;
}

/**
 * Unconditional usage adjustment, for credits and for moving an already-paid-for charge between
 * users. Unlike tryCreditQuota there's no quota condition: a credit must land even for a user who
 * is over quota (an admin lowered it), or it would be silently lost.
 */
async function adjustUsage(client: Prisma.TransactionClient, userId: string, delta: bigint) {
  if (delta === 0n) return;
  await client.$executeRaw`
    UPDATE users SET storage_used_bytes = storage_used_bytes + ${delta} WHERE id = ${userId}::uuid
  `;
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
