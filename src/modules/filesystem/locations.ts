import { db } from "../../db.js";

/**
 * For items listed outside their own folder (search results, recent files): the chain of folders
 * between a starting point and each item's parent, as [{ id, name }] — rendered as "in Projects /
 * Alpha". `parentPath` is the containing folder's materialized_path ("/root-id/…/parent-id/");
 * `scopePath`, if given, is the starting folder's materialized_path, whose ids are left out.
 * One query for all names, however many items.
 */
export async function resolveLocations<T extends { parent_path: string | null }>(
  rows: T[],
  scopePath: string | null = null,
): Promise<(row: T) => { id: string; name: string }[]> {
  const scopeIds = new Set(scopePath ? scopePath.split("/").filter(Boolean) : []);
  const chainFor = (path: string | null) => (path ? path.split("/").filter((id) => id && !scopeIds.has(id)) : []);
  const ids = [...new Set(rows.flatMap((r) => chainFor(r.parent_path)))];
  const names = new Map(
    (await db.folders.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((f) => [f.id, f.name]),
  );
  return (row) => chainFor(row.parent_path).map((id) => ({ id, name: names.get(id) ?? "" }));
}
