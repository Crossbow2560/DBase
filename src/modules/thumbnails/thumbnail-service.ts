import { db } from "../../db.js";
import * as storage from "../storage/client.js";
import { checkPermission } from "../access/permission-check.js";
import { fileNotFound } from "../filesystem/errors.js";
import { generateThumbnailBuffer } from "./generate.js";

// DESIGN.md §3.13: lower-stakes than DELETION_QUEUE, so a smaller bounded-retry cap — a missing
// preview is cosmetic, not a resource leak or security concern.
const MAX_ATTEMPTS = 3;
const CLAIM_BATCH_SIZE = 10;

const THUMBNAILABLE_PREFIXES = ["image/", "video/"];

/** REQUIREMENTS.md §5.9: only these general categories get a thumbnail attempt. */
export function isThumbnailable(mimeType: string): boolean {
  return THUMBNAILABLE_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || mimeType === "application/pdf";
}

/**
 * REQUIREMENTS.md §5.9: triggered post-upload-completion (or post-restore), never blocking the
 * caller — this only performs a fast DB insert; actual generation happens on the worker's own
 * timer. DESIGN.md §3.13's partial unique index makes a second enqueue while one is already
 * `pending` a no-op.
 */
export async function enqueueThumbnail(fileId: string, mimeType: string): Promise<void> {
  if (!isThumbnailable(mimeType)) return;
  await db.$transaction([
    db.files.updateMany({ where: { id: fileId, deleted_at: null }, data: { thumbnail_status: "pending" } }),
    db.$executeRaw`
      INSERT INTO thumbnail_queue (file_id) VALUES (${fileId}::uuid)
      ON CONFLICT (file_id) WHERE status = 'pending' DO NOTHING
    `,
  ]);
}

/**
 * REQUIREMENTS.md §5.9: a thumbnail must never be generated or served once a file is trashed or
 * deleted. Returns a presigned URL when a ready thumbnail exists, or `null` for the normal
 * "no preview available" state (not thumbnailable, still generating, or generation failed) —
 * the caller surfaces `null` as a plain unavailable state, never an error.
 */
export async function getThumbnailUrl(userId: string, fileId: string): Promise<string | null> {
  if (!(await checkPermission(userId, "file", fileId, "viewer"))) throw fileNotFound();
  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file) throw fileNotFound();
  if (file.thumbnail_status !== "ready" || !file.thumbnail_key) return null;
  return storage.getPresignedDownloadUrl(file.thumbnail_key);
}

type ThumbnailQueueRow = { id: string; file_id: string; attempts: number };

async function claimBatch(limit: number): Promise<ThumbnailQueueRow[]> {
  return db.$queryRaw<ThumbnailQueueRow[]>`
    UPDATE thumbnail_queue
    SET status = 'processing'
    WHERE id IN (
      SELECT id FROM thumbnail_queue
      WHERE status = 'pending'
      ORDER BY enqueued_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, file_id, attempts
  `;
}

async function processRow(row: ThumbnailQueueRow): Promise<void> {
  const file = await db.files.findUnique({ where: { id: row.file_id } });
  if (!file || file.deleted_at !== null) {
    // Trashed (or already purged, though ON DELETE CASCADE would have removed this row in that
    // case) since enqueue — nothing to generate. Not a generation failure, so mark done, not
    // failed; restoring the file later re-triggers a fresh attempt (restore-service.ts).
    await db.thumbnail_queue.update({ where: { id: row.id }, data: { status: "done", processed_at: new Date() } });
    return;
  }

  const source = await storage.getObjectBuffer(file.storage_key);
  const thumbnail = await generateThumbnailBuffer(file.mime_type, source);

  // DESIGN.md §3.13 (Pass 4): re-check immediately before writing the blob, not only at claim
  // time — closes the race where the file is trashed while generation was in flight.
  const stillLive = await db.files.findFirst({ where: { id: row.file_id, deleted_at: null } });
  if (!stillLive) {
    await db.thumbnail_queue.update({ where: { id: row.id }, data: { status: "done", processed_at: new Date() } });
    return;
  }

  const thumbnailKey = storage.generateThumbnailKey();
  await storage.putThumbnail(thumbnailKey, thumbnail);

  await db.$transaction(
    async (tx) => {
      await tx.files.update({
        where: { id: row.file_id },
        data: { thumbnail_status: "ready", thumbnail_key: thumbnailKey },
      });
      await tx.thumbnail_queue.update({ where: { id: row.id }, data: { status: "done", processed_at: new Date() } });
    },
    { timeout: 15000 },
  );
}

export async function runThumbnailQueueTick(): Promise<{ processed: number; failed: number }> {
  const batch = await claimBatch(CLAIM_BATCH_SIZE);
  let processed = 0;
  let failed = 0;

  for (const row of batch) {
    try {
      await processRow(row);
      processed++;
    } catch (err) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await db.thumbnail_queue.update({
          where: { id: row.id },
          data: { status: "failed", attempts, processed_at: new Date() },
        });
        // No further escalation for a failed thumbnail (DESIGN.md §3.10/§3.13) — just leave
        // FILES.thumbnail_status reflecting it; not deleted_at-scoped since a file trashed
        // between claim and here should still end up correctly marked once restored.
        await db.files.update({ where: { id: row.file_id }, data: { thumbnail_status: "failed" } }).catch(() => undefined);
        failed++;
        console.error(`[thumbnail-queue] file ${row.file_id} permanently failed after ${attempts} attempts:`, err);
      } else {
        await db.thumbnail_queue.update({ where: { id: row.id }, data: { status: "pending", attempts } });
        console.error(`[thumbnail-queue] file ${row.file_id} attempt ${attempts} failed, will retry:`, err);
      }
    }
  }

  return { processed, failed };
}
