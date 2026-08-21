import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { checkPermission } from "../access/permission-check.js";
import type { ItemType } from "../access/permission-check.js";
import { nameCollision } from "../filesystem/errors.js";
import { enqueueThumbnail } from "../thumbnails/thumbnail-service.js";
import { logActivity } from "../admin/audit-service.js";
import { itemNotFound, notInTrash, purgeInFlight } from "./errors.js";

const POSTGRES_UNIQUE_VIOLATION = "P2002";

export async function restoreItem(userId: string, itemType: ItemType, itemId: string): Promise<void> {
  if (!(await checkPermission(userId, itemType, itemId, "editor"))) throw itemNotFound();

  // DESIGN.md §5.2 (Pass 5): restore-eligibility must check for an in-flight DELETION_QUEUE row,
  // not just deleted_at — otherwise a user could restore an item that's already mid-purge.
  const inFlight = await db.deletion_queue.findFirst({
    where: { item_id: itemId, status: { in: ["pending", "processing"] } },
  });
  if (inFlight) throw purgeInFlight();

  try {
    if (itemType === "file") {
      await restoreFile(itemId);
    } else {
      await restoreFolderSubtree(itemId);
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw nameCollision();
    }
    throw err;
  }

  const ownerId =
    itemType === "file"
      ? (await db.files.findUnique({ where: { id: itemId }, select: { owner_id: true } }))?.owner_id
      : (await db.folders.findUnique({ where: { id: itemId }, select: { owner_id: true } }))?.owner_id;
  await logActivity({ actorId: userId, subjectUserId: ownerId ?? null, itemType, itemId, action: "restore" });
}

async function restoreFile(fileId: string): Promise<void> {
  const file = await db.files.findUnique({ where: { id: fileId } });
  if (!file || file.deleted_at === null) throw notInTrash();

  const destinationFolderId = await resolveRestoreDestination(file.folder_id);
  await db.files.update({ where: { id: fileId }, data: { deleted_at: null, folder_id: destinationFolderId } });

  // REQUIREMENTS.md §5.9: a ready thumbnail just resumes being served automatically (nothing to
  // do here); anything else — never generated, still pending, or failed — gets a fresh
  // best-effort attempt rather than being left permanently without one.
  if (file.thumbnail_status !== "ready") {
    await enqueueThumbnail(fileId, file.mime_type);
  }
}

/**
 * Restores the folder itself plus every descendant still trashed and not already mid-purge, in
 * one transaction — mirroring trashFolder's cascade (folder-service.ts) in reverse. A descendant
 * that was independently force-deleted (or already hit its own 30-day deadline) stays purged;
 * restoring the ancestor around it doesn't resurrect it (DESIGN.md §5.2's per-item independent
 * retention clock cuts both ways).
 */
async function restoreFolderSubtree(folderId: string): Promise<void> {
  const folder = await db.folders.findUnique({ where: { id: folderId } });
  if (!folder || folder.deleted_at === null) throw notInTrash();

  const destinationParentId = await resolveRestoreDestination(folder.parent_folder_id);

  // Snapshot which descendant files will need a fresh thumbnail attempt (REQUIREMENTS.md
  // §5.9) — read before the restore transaction, using the exact same eligibility condition as
  // that transaction's own file-restoring UPDATE below, since thumbnail_status itself doesn't
  // change as part of restoring.
  const filesNeedingThumbnails = await db.$queryRaw<{ id: string; mime_type: string }[]>`
    SELECT id, mime_type FROM files
    WHERE deleted_at IS NOT NULL
      AND thumbnail_status <> 'ready'
      AND folder_id IN (
        SELECT id FROM folders WHERE id = ${folderId}::uuid OR materialized_path LIKE ${folder.materialized_path + "%"}
      )
      AND NOT EXISTS (
        SELECT 1 FROM deletion_queue dq WHERE dq.item_id = files.id AND dq.status IN ('pending', 'processing')
      )
  `;

  // Explicit timeout: this transaction makes several sequential round trips (root update, two
  // subtree-wide raw UPDATEs), and Supabase's hosted network latency from this deployment
  // (observed ~1-3s per query) means Prisma's 5s interactive-transaction default can genuinely
  // be exceeded here even with nothing wrong — found as a real 500 (P2028 "transaction not
  // found") while testing a multi-descendant folder restore, not a hypothetical concern.
  await db.$transaction(async (tx) => {
    await tx.folders.update({
      where: { id: folderId },
      data: { deleted_at: null, parent_folder_id: destinationParentId },
    });

    // Only the root's own parent can have changed (destinationParentId) — no live sibling could
    // have appeared inside a still-trashed descendant folder in the meantime, since every write
    // path that creates a new item requires its target folder to be live. So no collision risk
    // for descendants; only the root update above can throw a unique violation.
    await tx.$executeRaw`
      UPDATE folders
      SET deleted_at = NULL
      WHERE deleted_at IS NOT NULL
        AND id <> ${folderId}::uuid
        AND materialized_path LIKE ${folder.materialized_path + "%"}
        AND NOT EXISTS (
          SELECT 1 FROM deletion_queue dq WHERE dq.item_id = folders.id AND dq.status IN ('pending', 'processing')
        )
    `;
    await tx.$executeRaw`
      UPDATE files
      SET deleted_at = NULL
      WHERE deleted_at IS NOT NULL
        AND folder_id IN (
          SELECT id FROM folders WHERE id = ${folderId}::uuid OR materialized_path LIKE ${folder.materialized_path + "%"}
        )
        AND NOT EXISTS (
          SELECT 1 FROM deletion_queue dq WHERE dq.item_id = files.id AND dq.status IN ('pending', 'processing')
        )
    `;
  }, { timeout: 15000 });

  for (const file of filesNeedingThumbnails) {
    await enqueueThumbnail(file.id, file.mime_type);
  }
}

/**
 * Restore back into the original parent if it's still live; if the parent has since been purged
 * or is itself still trashed, redirect to root rather than failing the restore outright.
 */
async function resolveRestoreDestination(originalParentId: string | null): Promise<string | null> {
  if (!originalParentId) return null;
  const parent = await db.folders.findUnique({ where: { id: originalParentId } });
  if (!parent || parent.deleted_at !== null) return null;
  return originalParentId;
}
