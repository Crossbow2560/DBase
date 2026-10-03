import { db } from "../../db.js";

export type ItemType = "file" | "folder";
export type Role = "owner" | "editor" | "viewer";

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

function roleAtLeast(have: Role, need: Role): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

/**
 * APPLICATION_DESIGN.md §3.3: the one function every module above `access` must call for an
 * authorization decision — no domain module may query PERMISSIONS/EFFECTIVE_PERMISSIONS
 * directly.
 *
 * Deliberate simplification for this pass: this always resolves synchronously from PERMISSIONS
 * (walking the folder ancestor chain) — there is no EFFECTIVE_PERMISSIONS cache read here yet.
 * DESIGN.md §3.7 already requires every access check to be ABLE to fall back to this exact
 * synchronous path (the cache "must never be treated as the source of truth"), so skipping the
 * cache doesn't sacrifice correctness — only the read-path performance optimization the cache
 * exists for. Adding the cache later (read it first, fall back to this function on a miss) is
 * additive and doesn't change this function's contract, so it's a reasonable thing to defer
 * rather than build before there's any read-volume reason to.
 */
export async function checkPermission(
  userId: string,
  itemType: ItemType,
  itemId: string,
  requiredRole: Role,
): Promise<boolean> {
  const user = await db.users.findUnique({ where: { id: userId }, select: { role: true } });
  // DESIGN.md §4.2: the admin bypass lives in this one shared function, short-circuiting
  // before any PERMISSIONS lookup — but only for ordinary item access, never for the
  // granting-authority check (permission-service.ts calls this function too, but the
  // exemption logic for *that* check is separate and narrower, per DESIGN.md §3.6).
  if (user?.role === "admin") return true;

  const effective = await resolveEffectiveRole(userId, itemType, itemId);
  if (!effective) return false;
  return roleAtLeast(effective, requiredRole);
}

/**
 * The highest role this user holds on this item, via a direct grant or an ancestor folder
 * share. REQUIREMENTS.md §5.1 (Subcomponent 7): "any item that user directly shared with other
 * users immediately stops granting those other users access" while that granting user's account
 * is deactivated — implemented as a check on each grant's own `granted_by` user, not the item's
 * owner, since a re-share (an editor granting a viewer) must also stop working while the
 * re-sharing editor specifically is deactivated, independent of the owner's own active state.
 *
 * One SQL round trip (a real cost, fixed): this used to issue a query for the direct grant, one
 * for the parent, one for the ancestor path, one for the ancestor grants, plus one per distinct
 * granter to check is_active — on every authorization check, i.e. several times per request.
 * The ancestor chain comes from the parent folder's materialized_path ("/root-id/.../parent-id/"),
 * and granter activity is a join. Still always synchronous from PERMISSIONS: the
 * effective_permissions table (0003) remains an unused cache, so there is nothing to invalidate.
 */
export async function resolveEffectiveRole(
  userId: string,
  itemType: ItemType,
  itemId: string,
): Promise<Role | null> {
  const rows = await db.$queryRaw<{ role: Role }[]>`
    WITH parent AS (
      SELECT f.materialized_path AS path
      FROM files fi JOIN folders f ON f.id = fi.folder_id
      WHERE ${itemType} = 'file' AND fi.id = ${itemId}::uuid
      UNION ALL
      SELECT p.materialized_path
      FROM folders c JOIN folders p ON p.id = c.parent_folder_id
      WHERE ${itemType} = 'folder' AND c.id = ${itemId}::uuid
    ),
    ancestors AS (
      SELECT unnest(string_to_array(btrim(path, '/'), '/'))::uuid AS folder_id FROM parent
    )
    SELECT p.role::text AS role
    FROM permissions p
    JOIN users g ON g.id = p.granted_by AND g.is_active
    WHERE p.user_id = ${userId}::uuid
      AND (
        (p.item_type = ${itemType}::item_type AND p.item_id = ${itemId}::uuid)
        OR (p.item_type = 'folder' AND p.item_id IN (SELECT folder_id FROM ancestors))
      )
  `;

  let best: Role | null = null;
  for (const { role } of rows) {
    if (!best || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best;
}
