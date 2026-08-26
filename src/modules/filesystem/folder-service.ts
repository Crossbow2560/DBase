import { randomUUID } from "node:crypto";
import { ZipArchive } from "archiver";
import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import * as storage from "../storage/client.js";
import { normalizeName, assertPathLengthOk } from "./normalize.js";
import { nameCollision, folderNotFound, cycleDetected } from "./errors.js";
import { checkPermission } from "../access/permission-check.js";
import { createOwnerPermission } from "../access/permission-service.js";
import { insufficientPermission } from "../access/errors.js";
import { logActivity } from "../admin/audit-service.js";

const POSTGRES_UNIQUE_VIOLATION = "P2002";

export async function createFolder(ownerId: string, parentFolderId: string | null, rawName: string) {
  const name = normalizeName(rawName);
  await assertPathLengthOk(parentFolderId, name);

  let parentPath = "/";
  if (parentFolderId) {
    // Creating inside someone else's folder requires editor-or-above there, same as any other
    // write (DESIGN.md §3.6's granting-authority pattern applies to writes generally, not just
    // PERMISSIONS grants).
    const authorized = await checkPermission(ownerId, "folder", parentFolderId, "editor");
    if (!authorized) throw folderNotFound(); // 404, not 403 — APPLICATION_DESIGN.md §4.1: don't leak existence to a user with zero access
    const parent = await db.folders.findFirst({ where: { id: parentFolderId, deleted_at: null } });
    if (!parent) throw folderNotFound();
    parentPath = parent.materialized_path;
  }

  const id = randomUUID();
  const materializedPath = `${parentPath}${id}/`;

  try {
    const folder = await db.folders.create({
      data: { id, name, owner_id: ownerId, parent_folder_id: parentFolderId, materialized_path: materializedPath },
    });
    // DESIGN.md §3.6: exactly one owner PERMISSIONS row, inserted immediately — every access
    // check (checkPermission) depends on this row existing, including for the item's own owner.
    await createOwnerPermission("folder", folder.id, ownerId);
    return folder;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw nameCollision();
    }
    throw err;
  }
}

export async function getFolderContents(userId: string, folderId: string | null) {
  if (folderId) {
    const authorized = await checkPermission(userId, "folder", folderId, "viewer");
    if (!authorized) throw folderNotFound();

    // Fetched alongside the listing so the frontend can render a "back to parent" link/breadcrumb
    // without a second round trip — found missing entirely by clicking into a folder in a real
    // browser and having no way back out except editing the URL.
    const folder = await db.folders.findFirst({ where: { id: folderId, deleted_at: null } });
    if (!folder) throw folderNotFound();

    // Not owner_id-scoped: DESIGN.md's "folder sharing is dynamic" means everything currently
    // inside an authorized folder is visible, regardless of who owns each individual child —
    // access to the PARENT is what was just checked; the children inherit it structurally.
    const [folders, files] = await Promise.all([
      db.folders.findMany({
        where: { parent_folder_id: folderId, deleted_at: null },
        orderBy: { name: "asc" },
        select: { id: true, name: true, updated_at: true },
      }),
      db.files.findMany({
        where: { folder_id: folderId, deleted_at: null },
        orderBy: { name: "asc" },
        select: { id: true, name: true, size_bytes: true, mime_type: true, updated_at: true },
      }),
    ]);
    const sizes = await getRecursiveFolderSizes(folders.map((f) => f.id));
    return {
      folder: { id: folder.id, name: folder.name, parentFolderId: folder.parent_folder_id },
      items: serializeItems(folders, files, sizes),
    };
  }

  // Root has no PERMISSIONS row to check — it isn't an item, it's "this user's own top-level
  // space." REQUIREMENTS.md's "Shared with me" (access.listSharedWithMe) is the separate
  // listing for items shared with this user; root never merges the two.
  const [folders, files] = await Promise.all([
    db.folders.findMany({
      where: { owner_id: userId, parent_folder_id: null, deleted_at: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, updated_at: true },
    }),
    db.files.findMany({
      where: { owner_id: userId, folder_id: null, deleted_at: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, size_bytes: true, mime_type: true, updated_at: true },
    }),
  ]);
  const sizes = await getRecursiveFolderSizes(folders.map((f) => f.id));
  return { folder: null, items: serializeItems(folders, files, sizes) };
}

/**
 * A folder's own row carries no size — only its files (and descendants') do. Sums, per given
 * folder id, every non-deleted file anywhere in that folder's subtree (itself included), via
 * FOLDERS.materialized_path prefix matching: a folder's own materialized_path is exactly the
 * prefix every descendant's path (and the folder's own direct files' containing-folder path)
 * starts with — see createFolder above for how that path is built. One query for the whole
 * batch of sibling folders being listed, not N+1 per row.
 */
async function getRecursiveFolderSizes(folderIds: string[]): Promise<Map<string, bigint>> {
  if (folderIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ folder_id: string; total: bigint }[]>`
    SELECT child.id as folder_id, COALESCE(SUM(f.size_bytes), 0)::bigint as total
    FROM folders child
    LEFT JOIN folders descendant
      ON descendant.materialized_path LIKE child.materialized_path || '%'
      AND descendant.deleted_at IS NULL
    LEFT JOIN files f
      ON f.folder_id = descendant.id
      AND f.deleted_at IS NULL
    WHERE child.id = ANY(${folderIds}::uuid[])
    GROUP BY child.id
  `;
  return new Map(rows.map((r) => [r.folder_id, r.total]));
}

function serializeItems(
  folders: { id: string; name: string; updated_at: Date }[],
  files: { id: string; name: string; size_bytes: bigint; mime_type: string; updated_at: Date }[],
  folderSizes: Map<string, bigint>,
) {
  return [
    ...folders.map((f) => ({
      id: f.id,
      name: f.name,
      type: "folder" as const,
      sizeBytes: (folderSizes.get(f.id) ?? 0n).toString(),
      updatedAt: f.updated_at.toISOString(),
    })),
    ...files.map((f) => ({
      id: f.id,
      name: f.name,
      type: "file" as const,
      sizeBytes: f.size_bytes.toString(),
      mimeType: f.mime_type,
      updatedAt: f.updated_at.toISOString(),
    })),
  ];
}

/**
 * Rename and/or move (reparent) a folder. The reparenting path is DESIGN.md §3.3's
 * single-highest-risk item: a pg_advisory_xact_lock on (subtree root, target parent) in
 * canonical sorted order, an ancestor-walk cycle check re-read fresh inside that lock, and a
 * full-subtree materialized_path rewrite — all in one transaction.
 */
export async function moveOrRenameFolder(
  userId: string,
  folderId: string,
  updates: { name?: string; parentFolderId?: string | null },
) {
  const folder = await db.folders.findFirst({ where: { id: folderId, deleted_at: null } });
  if (!folder) throw folderNotFound();
  if (!(await checkPermission(userId, "folder", folderId, "editor"))) throw folderNotFound();

  const newName = updates.name !== undefined ? normalizeName(updates.name) : folder.name;
  const newParentId = updates.parentFolderId !== undefined ? updates.parentFolderId : folder.parent_folder_id;
  const isReparenting = newParentId !== folder.parent_folder_id;

  if (isReparenting && newParentId === folderId) {
    throw cycleDetected();
  }

  // REQUIREMENTS.md §5.3's move-authorization rule has two parts: (1) editor-or-above on both
  // the item and the destination — implemented here; (2) if the move would cause anyone OTHER
  // than the mover to lose access they currently hold, the mover must be the item's owner —
  // NOT implemented yet. That check requires comparing the resolved user-set at the current
  // location against what the destination would resolve to, for every other user, which needs
  // machinery (EFFECTIVE_PERMISSIONS or an equivalent resolved-set computation) this pass
  // doesn't build. Flagged here explicitly rather than silently omitted: a non-owner editor can
  // currently move a shared item in a way that strips other users' access, which REQUIREMENTS.md
  // requires to be blocked.
  if (isReparenting && newParentId) {
    if (!(await checkPermission(userId, "folder", newParentId, "editor"))) throw folderNotFound();
  }

  await assertPathLengthOk(newParentId, newName);

  let result;
  try {
    result = await db.$transaction(async (tx) => {
      if (!isReparenting) {
        // Plain rename — no cycle risk, no lock needed.
        return tx.folders.update({ where: { id: folderId }, data: { name: newName } });
      }

      if (newParentId) {
        // Lock both the moved subtree's root and the target parent's own node id, in canonical
        // (sorted) order — locking only one side fails to prevent two folders being moved into
        // each other's subtrees simultaneously (DESIGN.md §3.3, Pass 5/6).
        const [a, b] = [folderId, newParentId].sort();
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${a}), hashtext(${b}))`;
      } else {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${folderId}))`;
      }

      // Re-read fresh, inside the lock — a concurrent move could have committed between this
      // function's initial read (above) and the lock actually being acquired.
      const freshFolder = await tx.folders.findFirstOrThrow({ where: { id: folderId } });

      let newPrefix: string;

      if (newParentId) {
        const targetParent = await tx.folders.findFirst({
          where: { id: newParentId, deleted_at: null },
        });
        if (!targetParent) throw folderNotFound();

        // Ancestor-walk cycle check: if the target parent's own materialized_path already
        // contains the moved folder's id, the target is that folder or one of its descendants —
        // moving there would make the folder its own ancestor.
        if (targetParent.id === freshFolder.id || targetParent.materialized_path.includes(`/${freshFolder.id}/`)) {
          throw cycleDetected();
        }

        newPrefix = `${targetParent.materialized_path}${freshFolder.id}/`;
      } else {
        newPrefix = `/${freshFolder.id}/`;
      }

      const oldPrefix = freshFolder.materialized_path;

      await tx.folders.update({
        where: { id: folderId },
        data: { name: newName, parent_folder_id: newParentId, materialized_path: newPrefix },
      });

      // Full-subtree rewrite, same transaction: every descendant's materialized_path is
      // prefixed with oldPrefix; swap that prefix for newPrefix across the whole subtree in one
      // statement (DESIGN.md §3.3).
      await tx.$executeRaw`
        UPDATE folders
        SET materialized_path = ${newPrefix} || substring(materialized_path from ${oldPrefix.length + 1}::int)
        WHERE materialized_path LIKE ${oldPrefix + "%"} AND id <> ${folderId}::uuid
      `;

      return tx.folders.findUniqueOrThrow({ where: { id: folderId } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw nameCollision();
    }
    throw err;
  }

  await logActivity({
    actorId: userId,
    subjectUserId: folder.owner_id,
    itemType: "folder",
    itemId: folderId,
    action: isReparenting ? "move" : "rename",
  });

  return result;
}

/**
 * Soft-delete a folder and its entire subtree — every descendant folder AND every file inside
 * any of them — in one transaction (DESIGN.md §5.2). Each item's own deleted_at is set to the
 * same instant, but (per REQUIREMENTS.md §5.4) that's only the shared trashing moment; each
 * item's own 30-day retention clock still runs independently off its own deleted_at from here.
 */
export async function trashFolder(userId: string, folderId: string) {
  const folder = await db.folders.findFirst({ where: { id: folderId, deleted_at: null } });
  if (!folder) throw folderNotFound();
  if (!(await checkPermission(userId, "folder", folderId, "editor"))) throw folderNotFound();

  // Not owner_id-scoped: a descendant item can be owned by a different user than the folder
  // being trashed (e.g. an editor created a sub-item inside a folder shared with them, owning
  // that sub-item themselves) — editor-or-above on the top folder covers acting on everything
  // structurally inside it, per DESIGN.md's dynamic-folder-sharing model, matching
  // getFolderContents' identical reasoning above.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE folders
      SET deleted_at = now()
      WHERE deleted_at IS NULL
        AND (id = ${folderId}::uuid OR materialized_path LIKE ${folder.materialized_path + "%"})
    `;
    await tx.$executeRaw`
      UPDATE files
      SET deleted_at = now()
      WHERE deleted_at IS NULL
        AND folder_id IN (
          SELECT id FROM folders
          WHERE (id = ${folderId}::uuid OR materialized_path LIKE ${folder.materialized_path + "%"})
        )
    `;
  });

  await logActivity({ actorId: userId, subjectUserId: folder.owner_id, itemType: "folder", itemId: folderId, action: "delete" });
}

/**
 * REQUIREMENTS.md §5.5 explicitly marks packaged-archive download as out of scope for the
 * original phase ("downloading individual files within it is sufficient") — added anyway as a
 * deliberate scope addition on direct request. Streams every descendant file straight from MinIO
 * into the zip as it's built (storage.getObjectStream, not getObjectBuffer) so a folder full of
 * large files doesn't need to sit fully in this process's memory at once; the archive itself is
 * a readable stream the caller pipes directly to the HTTP response as it's produced, rather than
 * being built to completion and then sent.
 */
export async function getFolderZipArchive(userId: string, folderId: string) {
  if (!(await checkPermission(userId, "folder", folderId, "viewer"))) throw folderNotFound();
  const folder = await db.folders.findFirst({ where: { id: folderId, deleted_at: null } });
  if (!folder) throw folderNotFound();

  const archive = buildFolderZipArchive(folderId);

  await logActivity({ actorId: userId, subjectUserId: folder.owner_id, itemType: "folder", itemId: folderId, action: "download" });

  return { archive, folderName: folder.name };
}

/**
 * The archive-building half of getFolderZipArchive above, split out so a caller who has already
 * authorized access some other way (e.g. share-link-service.ts's own token/scope check for a
 * public share link, which has no userId to run checkPermission against) can build the same zip
 * without going through this module's session-based authorization.
 */
export function buildFolderZipArchive(folderId: string): ZipArchive {
  // archiver 8.x's API: no more default-export factory function (`archiver("zip", opts)` from
  // older versions) — a format-specific class instead.
  const archive = new ZipArchive({ zlib: { level: 9 } });

  // Descendant items can be authorized purely via the top folder's own grant (DESIGN.md's
  // dynamic-folder-sharing model, same reasoning as getFolderContents/trashFolder above) — no
  // per-descendant permission check needed once the root folder itself has cleared viewer access.
  async function addFolderContents(currentFolderId: string, prefix: string): Promise<void> {
    const [subfolders, files] = await Promise.all([
      db.folders.findMany({ where: { parent_folder_id: currentFolderId, deleted_at: null }, orderBy: { name: "asc" } }),
      db.files.findMany({ where: { folder_id: currentFolderId, deleted_at: null }, orderBy: { name: "asc" } }),
    ]);

    for (const file of files) {
      const stream = await storage.getObjectStream(file.storage_key);
      archive.append(stream, { name: prefix + file.name });
    }
    for (const subfolder of subfolders) {
      await addFolderContents(subfolder.id, `${prefix}${subfolder.name}/`);
    }
  }

  // Populated asynchronously in the background — archiver is itself a readable stream the route
  // starts piping to the response immediately, and its internal queue applies backpressure to
  // this population loop as needed rather than requiring the whole zip to be assembled upfront.
  (async () => {
    try {
      await addFolderContents(folderId, "");
      await archive.finalize();
    } catch (err) {
      archive.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return archive;
}
