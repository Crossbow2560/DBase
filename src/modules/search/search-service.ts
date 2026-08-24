import { db } from "../../db.js";

interface SearchResultRow {
  id: string;
  name: string;
  type: "file" | "folder";
}

/**
 * REQUIREMENTS.md §5.3: "Users can search their own accessible files and folders (owned, or
 * shared with them) by name. Search matches on filename/foldername; partial and case-insensitive
 * matching must be supported at minimum." Backed by the pg_trgm GIN indexes already built for
 * this (migration 0009) — ILIKE '%term%' against those is what they exist to serve.
 *
 * Known, flagged gap (same simplification access/permission-service.ts's listSharedWithMe
 * already accepts, for the same reason): only owned items and items with a DIRECT PERMISSIONS
 * grant are searched — an item only reachable via an ancestor folder's share (no direct grant on
 * the item itself) won't surface here yet. checkPermission()'s own access decisions are
 * unaffected by this; a user can still open such an item via the folder browser, it just won't
 * show up in this specific search listing.
 */
export async function search(userId: string, term: string) {
  const trimmed = term.trim();
  if (trimmed.length === 0) return [];

  const rows = await db.$queryRaw<SearchResultRow[]>`
    SELECT id, name, 'file'::text as type FROM files
    WHERE deleted_at IS NULL
      AND name ILIKE '%' || ${trimmed} || '%'
      AND (
        owner_id = ${userId}::uuid
        OR id IN (SELECT item_id FROM permissions WHERE item_type = 'file' AND user_id = ${userId}::uuid)
      )
    UNION ALL
    SELECT id, name, 'folder'::text as type FROM folders
    WHERE deleted_at IS NULL
      AND name ILIKE '%' || ${trimmed} || '%'
      AND (
        owner_id = ${userId}::uuid
        OR id IN (SELECT item_id FROM permissions WHERE item_type = 'folder' AND user_id = ${userId}::uuid)
      )
    ORDER BY name ASC
    LIMIT 50
  `;

  return rows;
}
