import { db } from "../../db.js";

interface SearchResultRow {
  id: string;
  name: string;
  type: "file" | "folder";
  size_bytes: bigint | null;
  mime_type: string | null;
  updated_at: Date;
}

/**
 * REQUIREMENTS.md §5.3: "Users can search their own accessible files and folders (owned, or
 * shared with them) by name. Search matches on filename/foldername; partial and case-insensitive
 * matching must be supported at minimum." Backed by the pg_trgm GIN indexes already built for
 * this (migration 0009) — ILIKE '%term%' against those is what they exist to serve.
 *
 * "Accessible" matches access/permission-check.ts exactly (a gap, fixed): owned items, items
 * with a direct grant, AND everything inside a folder shared with this user — previously only the
 * first two, so a file you could open by browsing a shared folder never showed up in search. Grants
 * whose granter is deactivated are excluded, as they are for access itself.
 */
export async function search(userId: string, term: string) {
  const trimmed = term.trim();
  if (trimmed.length === 0) return [];

  const rows = await db.$queryRaw<SearchResultRow[]>`
    WITH grants AS (
      SELECT p.item_type, p.item_id
      FROM permissions p
      JOIN users g ON g.id = p.granted_by AND g.is_active
      WHERE p.user_id = ${userId}::uuid
    ),
    shared_roots AS (
      SELECT f.materialized_path AS path
      FROM folders f JOIN grants gr ON gr.item_type = 'folder' AND gr.item_id = f.id
      WHERE f.deleted_at IS NULL
    )
    SELECT fi.id, fi.name, 'file'::text as type, fi.size_bytes, fi.mime_type, fi.updated_at FROM files fi
    WHERE fi.deleted_at IS NULL
      AND fi.name ILIKE '%' || ${trimmed} || '%'
      AND (
        fi.owner_id = ${userId}::uuid
        OR fi.id IN (SELECT item_id FROM grants WHERE item_type = 'file')
        OR EXISTS (
          SELECT 1 FROM folders parent, shared_roots r
          WHERE parent.id = fi.folder_id AND parent.materialized_path LIKE r.path || '%'
        )
      )
    UNION ALL
    SELECT fo.id, fo.name, 'folder'::text as type, NULL::bigint as size_bytes, NULL::text as mime_type, fo.updated_at FROM folders fo
    WHERE fo.deleted_at IS NULL
      AND fo.name ILIKE '%' || ${trimmed} || '%'
      AND (
        fo.owner_id = ${userId}::uuid
        OR fo.id IN (SELECT item_id FROM grants WHERE item_type = 'folder')
        OR EXISTS (SELECT 1 FROM shared_roots r WHERE fo.materialized_path LIKE r.path || '%')
      )
    ORDER BY name ASC
    LIMIT 50
  `;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    sizeBytes: row.size_bytes !== null ? row.size_bytes.toString() : undefined,
    mimeType: row.mime_type ?? undefined,
    updatedAt: row.updated_at.toISOString(),
  }));
}
