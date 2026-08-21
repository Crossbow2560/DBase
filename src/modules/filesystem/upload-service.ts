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
  uploadSessionNotFound,
  uploadSessionInvalid,
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

  const existingPart = await db.upload_session_parts.findUnique({
    where: { upload_session_id_part_number: { upload_session_id: sessionId, part_number: partNumber } },
  });
  if (existingPart) {
    return; // already recorded — idempotent retry, no re-charge, no re-upload.
  }

  // Concurrent-mutation guard (REQUIREMENTS.md §5.3): re-verify the destination is still valid
  // before accepting more bytes, not just once at init.
  await assertUploadDestinationStillValid(session);

  const delta = BigInt(data.byteLength);
  const credited = await tryCreditQuota(userId, delta);
  if (!credited) {
    throw quotaExceeded();
  }

  try {
    await storage.putPart(sessionId, partNumber, data);
  } catch (err) {
    // Storage write failed after quota was already credited — credit it back so a transient
    // MinIO error doesn't leave the user's quota worse off than before this part attempt.
    await tryCreditQuota(userId, -delta);
    throw err;
  }

  await db.upload_session_parts.create({
    data: { upload_session_id: sessionId, part_number: partNumber, size_bytes: delta },
  });
}

export async function completeUpload(userId: string, sessionId: string, mimeType: string) {
  const session = await db.upload_sessions.findFirst({ where: { id: sessionId, user_id: userId } });
  if (!session || session.status !== "pending") throw uploadSessionNotFound();

  const parts = await db.upload_session_parts.findMany({ where: { upload_session_id: sessionId } });
  if (parts.length !== session.total_parts) {
    throw uploadSessionInvalid();
  }

  try {
    await assertUploadDestinationStillValid(session);
  } catch (err) {
    await abortSession(userId, session);
    throw err;
  }

  const totalBytes = parts.reduce((sum, p) => sum + p.size_bytes, 0n);
  const storageKey = storage.generateStorageKey();

  let file;
  try {
    file = await db.files.create({
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
  } catch (err) {
    await abortSession(userId, session);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw nameCollision();
    }
    throw err;
  }

  await storage.completeMultipartUpload(sessionId, session.total_parts, storageKey);

  // DESIGN.md §3.6: exactly one owner PERMISSIONS row, inserted immediately — same requirement
  // as folder-service.ts's createFolder. A file created via a completed upload is no exception.
  await createOwnerPermission("file", file.id, userId);

  // REQUIREMENTS.md §5.9: background, best-effort, never blocking this response — enqueueThumbnail
  // only performs a fast DB insert; actual generation happens on the worker's own timer. The
  // in-memory `file` object predates that DB update, so it's patched here too — otherwise this
  // function's return value (serialized straight into the completion response) would report
  // thumbnail_status: "none" even though the DB row was just set to "pending".
  if (isThumbnailable(mimeType)) {
    file.thumbnail_status = "pending";
  }
  await enqueueThumbnail(file.id, mimeType);

  await db.upload_sessions.update({
    where: { id: sessionId },
    data: { status: "complete", file_id: file.id },
  });

  // REQUIREMENTS.md §5.13: always self-owned at creation (uploads never create an item owned by
  // anyone but the uploader, matching folder-service.ts's createFolder) — subject === actor.
  await logActivity({ actorId: userId, subjectUserId: userId, itemType: "file", itemId: file.id, action: "upload" });

  return file;
}

export async function cancelUpload(userId: string, sessionId: string) {
  const session = await db.upload_sessions.findFirst({ where: { id: sessionId, user_id: userId } });
  if (!session || session.status !== "pending") throw uploadSessionNotFound();
  await abortSession(userId, session);
}

/**
 * DESIGN.md §3.5: a session not resumed before expires_at is automatically abandoned and
 * cleaned up — its bytes removed from storage and not counted against quota. Called by
 * src/workers/upload-session-cleanup.ts on a timer; reuses the exact same abortSession() path
 * an explicit client cancel uses, per that section's "follows the identical procedure, just
 * triggered immediately vs. by the scheduled job" requirement.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const expired = await db.upload_sessions.findMany({
    where: { status: "pending", expires_at: { lt: new Date() } },
  });
  for (const session of expired) {
    await abortSession(session.user_id, session);
  }
  return expired.length;
}

async function abortSession(
  userId: string,
  session: { id: string; total_parts: number },
): Promise<void> {
  const parts = await db.upload_session_parts.findMany({ where: { upload_session_id: session.id } });
  const totalBytes = parts.reduce((sum, p) => sum + p.size_bytes, 0n);

  if (totalBytes > 0n) {
    await tryCreditQuota(userId, -totalBytes);
  }
  await storage.removeUploadParts(session.id, session.total_parts);
  await db.upload_sessions.update({ where: { id: session.id }, data: { status: "aborted" } });
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

async function assertNoLiveNameCollision(userId: string, folderId: string | null, name: string): Promise<void> {
  const existing = await db.files.findFirst({
    where: { owner_id: userId, folder_id: folderId, name, deleted_at: null },
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
 */
async function tryCreditQuota(userId: string, delta: bigint): Promise<boolean> {
  const rows = await db.$queryRaw<{ storage_used_bytes: bigint }[]>`
    UPDATE users
    SET storage_used_bytes = storage_used_bytes + ${delta}
    WHERE id = ${userId}::uuid
      AND storage_used_bytes + ${delta} <= storage_quota_bytes
    RETURNING storage_used_bytes
  `;
  return rows.length > 0;
}
