import { db } from "../../db.js";
import { checkPermission } from "../access/permission-check.js";
import { folderNotFound } from "../filesystem/errors.js";

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

interface ScopedResultRow extends SearchResultRow {
  parent_id: string | null;
  parent_path: string | null; // materialized_path of the containing folder ("/root-id/…/parent-id/")
}

const SCOPED_RESULT_LIMIT = 100;

/** ILIKE pattern for a literal substring: % and _ (and the escape char) typed by the user match themselves. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The search box on the folder browser: name matches anywhere BELOW a starting point, at any depth,
 * rather than only among the items already listed (which is all the box could find before — a
 * client-side filter of the current folder's direct children).
 *
 *   - `within` = a folder id: everything in that folder's subtree. Needs viewer access to the
 *     folder; like getFolderContents, everything inside an accessible folder is visible
 *     regardless of who owns each item.
 *   - `within` = "mine": everything reachable from the user's My Files root — their own root-level
 *     files plus the full subtrees of their own root-level folders.
 *
 * Each result carries its location (folder names from the starting point down to the item's
 * parent) so a nested match can be told apart from one in the current folder.
 */
export async function searchWithin(userId: string, term: string, within: string) {
  const trimmed = term.trim();
  if (trimmed.length === 0) return { items: [], truncated: false };
  const pattern = containsPattern(trimmed);

  let rows: ScopedResultRow[];
  let scopePath: string | null = null;
  if (within === "mine") {
    rows = await db.$queryRaw<ScopedResultRow[]>`
      WITH roots AS (
        SELECT id::text AS id FROM folders
        WHERE owner_id = ${userId}::uuid AND parent_folder_id IS NULL AND deleted_at IS NULL
      )
      SELECT fi.id, fi.name, 'file'::text AS type, fi.size_bytes, fi.mime_type, fi.updated_at,
             fi.folder_id AS parent_id, p.materialized_path AS parent_path
      FROM files fi LEFT JOIN folders p ON p.id = fi.folder_id
      WHERE fi.deleted_at IS NULL
        AND fi.name ILIKE ${pattern}
        AND (
          (fi.folder_id IS NULL AND fi.owner_id = ${userId}::uuid)
          OR split_part(p.materialized_path, '/', 2) IN (SELECT id FROM roots)
        )
      UNION ALL
      SELECT fo.id, fo.name, 'folder'::text AS type, NULL::bigint, NULL::text, fo.updated_at,
             fo.parent_folder_id AS parent_id, pp.materialized_path AS parent_path
      FROM folders fo LEFT JOIN folders pp ON pp.id = fo.parent_folder_id
      WHERE fo.deleted_at IS NULL
        AND fo.name ILIKE ${pattern}
        AND split_part(fo.materialized_path, '/', 2) IN (SELECT id FROM roots)
      ORDER BY name ASC
      LIMIT ${SCOPED_RESULT_LIMIT + 1}
    `;
  } else {
    if (!(await checkPermission(userId, "folder", within, "viewer"))) throw folderNotFound();
    const scope = await db.folders.findFirst({ where: { id: within, deleted_at: null } });
    if (!scope) throw folderNotFound();
    scopePath = scope.materialized_path;
    const prefix = `${scope.materialized_path}%`;
    rows = await db.$queryRaw<ScopedResultRow[]>`
      SELECT fi.id, fi.name, 'file'::text AS type, fi.size_bytes, fi.mime_type, fi.updated_at,
             fi.folder_id AS parent_id, p.materialized_path AS parent_path
      FROM files fi JOIN folders p ON p.id = fi.folder_id
      WHERE fi.deleted_at IS NULL
        AND fi.name ILIKE ${pattern}
        AND p.materialized_path LIKE ${prefix}
      UNION ALL
      SELECT fo.id, fo.name, 'folder'::text AS type, NULL::bigint, NULL::text, fo.updated_at,
             fo.parent_folder_id AS parent_id, pp.materialized_path AS parent_path
      FROM folders fo JOIN folders pp ON pp.id = fo.parent_folder_id
      WHERE fo.deleted_at IS NULL
        AND fo.name ILIKE ${pattern}
        AND fo.materialized_path LIKE ${prefix}
        AND fo.id <> ${within}::uuid
      ORDER BY name ASC
      LIMIT ${SCOPED_RESULT_LIMIT + 1}
    `;
  }

  const truncated = rows.length > SCOPED_RESULT_LIMIT;
  rows = rows.slice(0, SCOPED_RESULT_LIMIT);

  // Location: the folder chain from the starting point (exclusive) down to the item's parent.
  const scopeIds = new Set(scopePath ? scopePath.split("/").filter(Boolean) : []);
  const chainFor = (path: string | null) =>
    path ? path.split("/").filter((id) => id && !scopeIds.has(id)) : [];
  const allIds = [...new Set(rows.flatMap((r) => chainFor(r.parent_path)))];
  const names = new Map(
    (await db.folders.findMany({ where: { id: { in: allIds } }, select: { id: true, name: true } })).map((f) => [
      f.id,
      f.name,
    ]),
  );

  return {
    truncated,
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      sizeBytes: row.size_bytes !== null ? row.size_bytes.toString() : undefined,
      mimeType: row.mime_type ?? undefined,
      updatedAt: row.updated_at.toISOString(),
      parentFolderId: row.parent_id,
      // [] means directly in the folder being searched.
      location: chainFor(row.parent_path).map((id) => ({ id, name: names.get(id) ?? "" })),
    })),
  };
}
