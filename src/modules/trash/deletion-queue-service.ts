import { db } from "../../db.js";
import { config } from "../../config.js";
import * as storage from "../storage/client.js";
import { checkPermission } from "../access/permission-check.js";
import type { ItemType } from "../access/permission-check.js";
import { logActivity } from "../admin/audit-service.js";
import { itemNotFound, notInTrash } from "./errors.js";

// DESIGN.md §3.10: a fixed maximum number of retry attempts before a row is parked in a
// terminal `failed` state rather than retried forever — an application-level constant, not a
// schema field.
const MAX_ATTEMPTS = 5;
const CLAIM_BATCH_SIZE = 20;

type DeletionQueueRow = {
  id: string;
  item_type: ItemType;
  item_id: string;
  storage_key: string | null;
  thumbnail_key: string | null;
  owner_id: string | null;
  size_bytes: bigint;
  attempts: number;
  blob_only: boolean;
};

/**
 * DESIGN.md §5.4: user-facing trash listing, owner-scoped. Whether a row is already mid-purge
 * (an in-flight DELETION_QUEUE row) isn't filtered out here — restoreItem/purgeNow each make
 * their own authoritative check at the moment of action, per §5.2's restore-eligibility rule.
 */
export async function listTrash(userId: string) {
  const [folders, files] = await Promise.all([
    db.folders.findMany({ where: { owner_id: userId, deleted_at: { not: null } } }),
    db.files.findMany({ where: { owner_id: userId, deleted_at: { not: null } } }),
  ]);

  return [
    ...folders.map((f) => ({ id: f.id, name: f.name, type: "folder" as const, deletedAt: f.deleted_at!.toISOString() })),
    ...files.map((f) => ({ id: f.id, name: f.name, type: "file" as const, deletedAt: f.deleted_at!.toISOString() })),
  ].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/**
 * REQUIREMENTS.md §5.4: "delete forever" — bypasses the 30-day retention window and starts the
 * same enqueue path the scheduled job uses, via the idempotent-enqueue guard (§3.10/§5.2) so a
 * concurrent scheduled-job enqueue for the same item is a no-op rather than a duplicate.
 */
export async function purgeNow(userId: string, itemType: ItemType, itemId: string): Promise<void> {
  if (!(await checkPermission(userId, itemType, itemId, "editor"))) throw itemNotFound();

  let ownerId: string;
  if (itemType === "file") {
    const file = await db.files.findUnique({ where: { id: itemId } });
    if (!file) throw itemNotFound();
    if (file.deleted_at === null) throw notInTrash();
    await enqueueFileForPurge(file);
    ownerId = file.owner_id;
  } else {
    const folder = await db.folders.findUnique({ where: { id: itemId } });
    if (!folder) throw itemNotFound();
    if (folder.deleted_at === null) throw notInTrash();
    await enqueueFolderSubtreeForPurge(folder.id, folder.materialized_path);
    ownerId = folder.owner_id;
  }

  // REQUIREMENTS.md §5.13: logged at the moment permanent deletion is requested/enqueued, same
  // as every other soft/async action here being logged at request time rather than at eventual
  // worker completion.
  await logActivity({ actorId: userId, subjectUserId: ownerId, itemType, itemId, action: "purge" });
}

/**
 * DESIGN.md §5.2 (Pass 6): scans every item, at any depth, whose own `deleted_at` has aged past
 * the retention window — each item's 30-day clock is independent of any ancestor's, so this is
 * NOT restricted to top-level trashed roots. The idempotent-enqueue guard (partial unique index
 * on deletion_queue.item_id) means an item already covered by an in-flight ancestor-folder
 * subtree enqueue just no-ops here rather than double-enqueueing.
 */
export async function scanAndEnqueueExpired(): Promise<number> {
  const expiredFolders = await db.$queryRaw<{ id: string; materialized_path: string }[]>`
    SELECT id, materialized_path FROM folders
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - (${config.trashRetentionDays} * interval '1 day')
      AND NOT EXISTS (
        SELECT 1 FROM deletion_queue dq WHERE dq.item_id = folders.id AND dq.status IN ('pending', 'processing')
      )
  `;
  for (const folder of expiredFolders) {
    await enqueueFolderSubtreeForPurge(folder.id, folder.materialized_path);
  }

  const expiredFiles = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM files
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - (${config.trashRetentionDays} * interval '1 day')
      AND NOT EXISTS (
        SELECT 1 FROM deletion_queue dq WHERE dq.item_id = files.id AND dq.status IN ('pending', 'processing')
      )
  `;
  for (const { id } of expiredFiles) {
    const file = await db.files.findUnique({ where: { id } });
    if (file) await enqueueFileForPurge(file);
  }

  return expiredFolders.length + expiredFiles.length;
}

async function enqueueFileForPurge(file: {
  id: string;
  owner_id: string;
  storage_key: string;
  thumbnail_key: string | null;
  size_bytes: bigint;
}): Promise<void> {
  await db.$executeRaw`
    INSERT INTO deletion_queue (item_type, item_id, storage_key, thumbnail_key, owner_id, size_bytes)
    VALUES ('file'::item_type, ${file.id}::uuid, ${file.storage_key}, ${file.thumbnail_key}, ${file.owner_id}::uuid, ${file.size_bytes})
    ON CONFLICT (item_id) WHERE status IN ('pending', 'processing') DO NOTHING
  `;
}

/**
 * DESIGN.md §3.10 (Pass 2): a folder purge must enumerate every descendant file individually,
 * each with its own queue row carrying its real size_bytes — not just one row for the folder
 * itself, or descendant blobs are permanently orphaned. The folder's own row (and every
 * descendant folder's own row) always carries size_bytes = 0 and a null storage_key, since
 * folders hold no blob.
 */
async function enqueueFolderSubtreeForPurge(rootFolderId: string, materializedPath: string): Promise<void> {
  // Explicit timeout: same reasoning as restore-service.ts's restoreFolderSubtree — this loops
  // one INSERT per descendant folder/file over Supabase's hosted network latency, which can
  // exceed Prisma's 5s interactive-transaction default well before anything is actually wrong.
  await db.$transaction(async (tx) => {
    const descendantFolders = await tx.$queryRaw<{ id: string; owner_id: string }[]>`
      SELECT id, owner_id FROM folders
      WHERE id = ${rootFolderId}::uuid OR materialized_path LIKE ${materializedPath + "%"}
    `;
    for (const folder of descendantFolders) {
      await tx.$executeRaw`
        INSERT INTO deletion_queue (item_type, item_id, storage_key, thumbnail_key, owner_id, size_bytes)
        VALUES ('folder'::item_type, ${folder.id}::uuid, NULL, NULL, ${folder.owner_id}::uuid, 0)
        ON CONFLICT (item_id) WHERE status IN ('pending', 'processing') DO NOTHING
      `;
    }

    const folderIds = descendantFolders.map((f) => f.id);
    const files = await tx.files.findMany({ where: { folder_id: { in: folderIds } } });
    for (const file of files) {
      await tx.$executeRaw`
        INSERT INTO deletion_queue (item_type, item_id, storage_key, thumbnail_key, owner_id, size_bytes)
        VALUES ('file'::item_type, ${file.id}::uuid, ${file.storage_key}, ${file.thumbnail_key}, ${file.owner_id}::uuid, ${file.size_bytes})
        ON CONFLICT (item_id) WHERE status IN ('pending', 'processing') DO NOTHING
      `;
    }
  }, { timeout: 15000 });
}

/** Claims up to `limit` pending rows for this process, atomically, via SKIP LOCKED. */
async function claimBatch(limit: number): Promise<DeletionQueueRow[]> {
  return db.$queryRaw<DeletionQueueRow[]>`
    UPDATE deletion_queue
    SET status = 'processing'
    WHERE id IN (
      SELECT id FROM deletion_queue
      WHERE status = 'pending'
      ORDER BY enqueued_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, item_type, item_id, storage_key, thumbnail_key, owner_id, size_bytes, attempts, blob_only
  `;
}

/**
 * DESIGN.md §3.10's worker order: delete the blob(s) from the object store, THEN purge the DB
 * row and cascade-clean polymorphic references, THEN credit quota back — all inside one
 * transaction for the DB-side steps, so a crash between blob deletion and the transaction
 * leaves the row `processing` (re-claimable, and storage.removeObject is safe to retry against
 * an already-gone key) rather than silently losing track of it.
 */
async function processRow(row: DeletionQueueRow): Promise<void> {
  if (row.storage_key) {
    await storage.removeObject(row.storage_key);
  }
  if (row.thumbnail_key) {
    await storage.removeObject(row.thumbnail_key);
  }

  // An old object left behind by a content replace (upload-service.ts completeReplace): the FILES
  // row lives on and quota was already settled, so removing the blobs is the whole job.
  if (row.blob_only) {
    await db.deletion_queue.update({ where: { id: row.id }, data: { status: "done", processed_at: new Date() } });
    return;
  }

  await db.$transaction(async (tx) => {
    // Polymorphic references, no real FK — nothing else cleans these up (DESIGN.md §3.10).
    // ACTIVITY_LOG belongs in this same cascade once that table exists (Subcomponent 6) — it
    // doesn't yet, so there's nothing to clean up there today.
    await tx.permissions.deleteMany({ where: { item_type: row.item_type, item_id: row.item_id } });
    await tx.share_links.deleteMany({ where: { item_type: row.item_type, item_id: row.item_id } });
    await tx.favorites.deleteMany({ where: { item_type: row.item_type, item_id: row.item_id } });
    await tx.item_tags.deleteMany({ where: { item_type: row.item_type, item_id: row.item_id } });

    if (row.item_type === "file") {
      await tx.files.deleteMany({ where: { id: row.item_id } });
    } else {
      await tx.folders.deleteMany({ where: { id: row.item_id } });
    }

    // owner_id is nullable (account deleted while this item was still mid-purge) — the credit
    // step is skipped in that case, matching migration 0004's column comment.
    if (row.owner_id && row.size_bytes > 0n) {
      await tx.$executeRaw`
        UPDATE users SET storage_used_bytes = storage_used_bytes - ${row.size_bytes} WHERE id = ${row.owner_id}::uuid
      `;
    }

    await tx.deletion_queue.update({
      where: { id: row.id },
      data: { status: "done", processed_at: new Date() },
    });
  }, { timeout: 15000 });
}

/**
 * One tick of the worker: claim a batch, process each row, and apply the bounded-retry policy
 * on failure (DESIGN.md §3.10) — back to `pending` with attempts incremented while under the
 * cap, or a terminal `failed` once the cap is exceeded, surfaced via a log line since there's no
 * admin "failed deletions" view yet (Subcomponent 6).
 */
export async function runDeletionQueueTick(): Promise<{ processed: number; failed: number }> {
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
        await db.deletion_queue.update({
          where: { id: row.id },
          data: { status: "failed", attempts, processed_at: new Date() },
        });
        failed++;
        console.error(`[deletion-queue] item ${row.item_id} permanently failed after ${attempts} attempts:`, err);
      } else {
        await db.deletion_queue.update({ where: { id: row.id }, data: { status: "pending", attempts } });
        console.error(`[deletion-queue] item ${row.item_id} attempt ${attempts} failed, will retry:`, err);
      }
    }
  }

  return { processed, failed };
}
