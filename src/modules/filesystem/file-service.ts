import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { resolveLocations } from "./locations.js";
import * as storage from "../storage/client.js";
import { normalizeName, assertPathLengthOk } from "./normalize.js";
import { nameCollision, fileNotFound, folderNotFound, noLongerAvailable } from "./errors.js";
import { checkPermission } from "../access/permission-check.js";
import { logActivity } from "../admin/audit-service.js";

const POSTGRES_UNIQUE_VIOLATION = "P2002";

/**
 * files.size_bytes is a Postgres bigint, which Prisma returns as a native JS BigInt —
 * Fastify's JSON serializer has no built-in support for BigInt (`JSON.stringify` throws on it
 * directly). Every route response containing a raw file row must go through this first; found
 * as a real 500 on the upload-completion endpoint (a second, not-yet-hit instance of the same
 * bug existed here too, on the rename/move response, before this helper existed).
 */
export function serializeFile<T extends { size_bytes: bigint }>(file: T) {
  return { ...file, size_bytes: file.size_bytes.toString() };
}

export async function renameOrMoveFile(
  userId: string,
  fileId: string,
  updates: { name?: string; folderId?: string | null },
) {
  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file) throw fileNotFound();
  if (!(await checkPermission(userId, "file", fileId, "editor"))) throw fileNotFound();

  const newName = updates.name !== undefined ? normalizeName(updates.name) : file.name;
  const newFolderId = updates.folderId !== undefined ? updates.folderId : file.folder_id;

  // REQUIREMENTS.md §5.3's move-authorization: editor-or-above on the destination too. Same
  // deferred "would this strip someone else's access" check noted in folder-service.ts's
  // moveOrRenameFolder — not implemented here either, for the same reason.
  if (newFolderId) {
    if (!(await checkPermission(userId, "folder", newFolderId, "editor"))) throw folderNotFound();
    const target = await db.folders.findFirst({ where: { id: newFolderId, deleted_at: null } });
    if (!target) throw folderNotFound();
  }

  await assertPathLengthOk(newFolderId, newName);

  let updated;
  try {
    updated = await db.files.update({
      where: { id: fileId },
      data: { name: newName, folder_id: newFolderId },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw nameCollision();
    }
    throw err;
  }

  // REQUIREMENTS.md §5.13: subject is the item's owner, distinct from actor when a non-owner
  // editor performs the move/rename — matches every other write path's subject resolution here.
  const isMove = newFolderId !== file.folder_id;
  await logActivity({
    actorId: userId,
    subjectUserId: file.owner_id,
    itemType: "file",
    itemId: fileId,
    action: isMove ? "move" : "rename",
  });

  return updated;
}

export async function trashFile(userId: string, fileId: string) {
  if (!(await checkPermission(userId, "file", fileId, "editor"))) throw fileNotFound();
  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file) throw fileNotFound();

  await db.files.update({ where: { id: fileId }, data: { deleted_at: new Date() } });

  await logActivity({ actorId: userId, subjectUserId: file.owner_id, itemType: "file", itemId: fileId, action: "delete" });
}

/**
 * DESIGN.md §3.4's download-time enforcement: authorized once, at request time — deleted_at
 * IS NULL is checked here, not re-checked once the presigned URL is handed out, so an in-flight
 * download already started is allowed to complete even if the file is trashed moments later
 * (storage_key's content is immutable for the life of a FILES row, DESIGN.md §3.4, since this
 * schema has no versioning). A *new* download request after trashing hits this same check and
 * is rejected immediately — no dependency on DELETION_QUEUE's async purge timeline, which
 * doesn't exist yet (Subcomponent 3).
 */
export async function getDownloadUrl(userId: string, fileId: string) {
  if (!(await checkPermission(userId, "file", fileId, "viewer"))) throw noLongerAvailable();
  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file || file.upload_status !== "complete") throw noLongerAvailable();

  await logActivity({ actorId: userId, subjectUserId: file.owner_id, itemType: "file", itemId: fileId, action: "download" });

  return storage.getPresignedDownloadUrl(file.storage_key, 300, file.name);
}

const PREVIEWABLE_PREFIXES = ["image/", "video/", "audio/"];

export function isPreviewable(mimeType: string): boolean {
  return PREVIEWABLE_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || mimeType === "application/pdf";
}

/**
 * Inline in-browser preview (click-to-open, like Drive), distinct from getDownloadUrl above —
 * same authorization/liveness checks, but returns `null` for a normal "no preview available"
 * state (same convention as thumbnails, REQUIREMENTS.md §5.9) rather than an error, for any mime
 * type the frontend has no inline viewer for. Does not log a `download` activity row — opening a
 * preview isn't a download in the REQUIREMENTS.md §5.13 sense (the file's bytes aren't being
 * saved by the user); the frontend's Download button remains the thing that logs `download`.
 */
export async function getPreviewUrl(userId: string, fileId: string): Promise<{ url: string; mimeType: string } | null> {
  if (!(await checkPermission(userId, "file", fileId, "viewer"))) throw noLongerAvailable();
  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file || file.upload_status !== "complete") throw noLongerAvailable();
  if (!isPreviewable(file.mime_type)) return null;

  const url = await storage.getPresignedPreviewUrl(file.storage_key, file.mime_type);
  return { url, mimeType: file.mime_type };
}

const RECENT_FILES_MAX = 50;

/**
 * The home page's "Recent Files": the most recently added or changed files anywhere in the user's
 * My Files tree — their own root-level files plus everything inside their own root-level folders,
 * at any depth (the same scope as searching My Files, search-service.ts searchWithin "mine"). It
 * used to be built client-side from the root folder's listing, so a file uploaded into any
 * subfolder could never appear. Each file carries its location ("in Projects / Alpha").
 */
export async function listRecentFiles(userId: string, limit: number) {
  const take = Math.min(Math.max(1, limit), RECENT_FILES_MAX);
  const rows = await db.$queryRaw<
    {
      id: string;
      name: string;
      size_bytes: bigint;
      mime_type: string;
      created_at: Date;
      updated_at: Date;
      parent_id: string | null;
      parent_path: string | null;
    }[]
  >`
    WITH roots AS (
      SELECT id::text AS id FROM folders
      WHERE owner_id = ${userId}::uuid AND parent_folder_id IS NULL AND deleted_at IS NULL
    )
    SELECT fi.id, fi.name, fi.size_bytes, fi.mime_type, fi.created_at, fi.updated_at,
           fi.folder_id AS parent_id, p.materialized_path AS parent_path
    FROM files fi LEFT JOIN folders p ON p.id = fi.folder_id
    WHERE fi.deleted_at IS NULL
      AND fi.upload_status = 'complete'
      AND (
        (fi.folder_id IS NULL AND fi.owner_id = ${userId}::uuid)
        OR split_part(p.materialized_path, '/', 2) IN (SELECT id FROM roots)
      )
    ORDER BY fi.updated_at DESC, fi.id
    LIMIT ${take}
  `;

  const locationOf = await resolveLocations(rows);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: "file" as const,
    sizeBytes: row.size_bytes.toString(),
    mimeType: row.mime_type,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    parentFolderId: row.parent_id,
    location: locationOf(row),
  }));
}
