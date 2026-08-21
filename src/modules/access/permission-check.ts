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
 * is deactivated — implemented here as a check on each grant's own `granted_by` user, not the
 * item's owner, since a re-share (an editor granting a viewer) must also stop working while the
 * re-sharing editor specifically is deactivated, independent of the owner's own active state.
 * This closes a gap explicitly flagged (but not fixed) during Subcomponent 4: this function
 * previously had no deactivation-awareness at all.
 */
export async function resolveEffectiveRole(
  userId: string,
  itemType: ItemType,
  itemId: string,
): Promise<Role | null> {
  let best: Role | null = null;
  const consider = (role: Role) => {
    if (!best || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  };

  // Memoized per call — an ancestor walk can revisit the same granter across many grant rows.
  const activeGranterCache = new Map<string, boolean>();
  async function granterIsActive(grantedBy: string): Promise<boolean> {
    const cached = activeGranterCache.get(grantedBy);
    if (cached !== undefined) return cached;
    const granter = await db.users.findUnique({ where: { id: grantedBy }, select: { is_active: true } });
    const active = granter?.is_active ?? false;
    activeGranterCache.set(grantedBy, active);
    return active;
  }

  const direct = await db.permissions.findUnique({
    where: { item_type_item_id_user_id: { item_type: itemType, item_id: itemId, user_id: userId } },
  });
  if (direct && (await granterIsActive(direct.granted_by))) consider(direct.role);

  const parentFolderId = await getParentFolderId(itemType, itemId);
  if (parentFolderId) {
    const ancestorIds = await getAncestorFolderIds(parentFolderId);
    if (ancestorIds.length > 0) {
      const grants = await db.permissions.findMany({
        where: { item_type: "folder", item_id: { in: ancestorIds }, user_id: userId },
      });
      for (const grant of grants) {
        if (await granterIsActive(grant.granted_by)) consider(grant.role);
      }
    }
  }

  return best;
}

async function getParentFolderId(itemType: ItemType, itemId: string): Promise<string | null> {
  if (itemType === "file") {
    const file = await db.files.findUnique({ where: { id: itemId }, select: { folder_id: true } });
    return file?.folder_id ?? null;
  }
  const folder = await db.folders.findUnique({ where: { id: itemId }, select: { parent_folder_id: true } });
  return folder?.parent_folder_id ?? null;
}

/** Every folder id in the ancestor chain, from `startFolderId` up to (and including) the root. */
async function getAncestorFolderIds(startFolderId: string): Promise<string[]> {
  const folder = await db.folders.findUnique({
    where: { id: startFolderId },
    select: { materialized_path: true },
  });
  if (!folder) return [];
  return folder.materialized_path.split("/").filter(Boolean);
}
