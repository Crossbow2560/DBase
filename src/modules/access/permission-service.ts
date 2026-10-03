import type { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { checkPermission, resolveEffectiveRole, type ItemType, type Role } from "./permission-check.js";
import { insufficientPermission, itemNotFound } from "./errors.js";
import { logActivity } from "../admin/audit-service.js";

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * DESIGN.md §3.6: every folder/file creation must insert exactly one owner PERMISSIONS row
 * immediately, self-referential granted_by, so the item never has a zero-owner window. Called
 * by folder-service.ts/upload-service.ts right after the item row itself is created — not
 * exposed as its own route, since it's not something a client ever calls directly.
 */
export async function createOwnerPermission(
  itemType: ItemType,
  itemId: string,
  ownerId: string,
  client: Prisma.TransactionClient = db,
): Promise<void> {
  await client.permissions.create({
    data: { item_type: itemType, item_id: itemId, user_id: ownerId, role: "owner", granted_by: ownerId },
  });
}

/**
 * DESIGN.md §3.6: granting access requires the acting user to hold editor-or-above on the
 * target item (checked via the same shared access-check function everything else uses), and an
 * editor may grant up to but never above their own level. Sharing with the current owner, or
 * with oneself, is a no-op per REQUIREMENTS.md §5.5 — not an error.
 */
export async function grantPermission(
  actingUserId: string,
  itemType: ItemType,
  itemId: string,
  granteeUserId: string,
  role: Exclude<Role, "owner">,
): Promise<void> {
  if (granteeUserId === actingUserId) return;

  const authorized = await checkPermission(actingUserId, itemType, itemId, "editor");
  if (!authorized) throw insufficientPermission();

  const ownerGrant = await db.permissions.findFirst({
    where: { item_type: itemType, item_id: itemId, role: "owner" },
  });
  if (!ownerGrant) throw itemNotFound();
  if (ownerGrant.user_id === granteeUserId) return; // sharing with the owner is a no-op

  const actorRole = await resolveEffectiveRole(actingUserId, itemType, itemId);
  if (!actorRole || ROLE_RANK[role] > ROLE_RANK[actorRole]) throw insufficientPermission();

  const existing = await db.permissions.findUnique({
    where: { item_type_item_id_user_id: { item_type: itemType, item_id: itemId, user_id: granteeUserId } },
  });
  // REQUIREMENTS.md §5.5: sharing with someone who already has access updates their grant to
  // the higher of the two levels — never downgrades an existing grant.
  const finalRole: Role =
    existing && ROLE_RANK[existing.role] > ROLE_RANK[role] ? existing.role : role;

  await db.permissions.upsert({
    where: { item_type_item_id_user_id: { item_type: itemType, item_id: itemId, user_id: granteeUserId } },
    create: { item_type: itemType, item_id: itemId, user_id: granteeUserId, role: finalRole, granted_by: actingUserId },
    update: { role: finalRole, granted_by: actingUserId },
  });

  await logActivity({
    actorId: actingUserId,
    subjectUserId: ownerGrant.user_id,
    itemType,
    itemId,
    action: "share",
    metadata: { granteeUserId, role: finalRole },
  });
}

export async function revokePermission(
  actingUserId: string,
  itemType: ItemType,
  itemId: string,
  targetUserId: string,
): Promise<void> {
  const authorized = await checkPermission(actingUserId, itemType, itemId, "editor");
  if (!authorized) throw insufficientPermission();

  // Never lets a revoke touch the owner row — ownership only ever changes via
  // transfer_ownership() (DESIGN.md §3.6).
  await db.permissions.deleteMany({
    where: { item_type: itemType, item_id: itemId, user_id: targetUserId, role: { not: "owner" } },
  });

  const ownerGrant = await db.permissions.findFirst({ where: { item_type: itemType, item_id: itemId, role: "owner" } });
  await logActivity({
    actorId: actingUserId,
    subjectUserId: ownerGrant?.user_id ?? null,
    itemType,
    itemId,
    action: "unshare",
    metadata: { targetUserId },
  });
}

/**
 * REQUIREMENTS.md §5.5: the items shared with this user — the top-level shares only, by design
 * (the same model as Google Drive's "Shared with me"): a shared folder appears once, and what's
 * inside it is reached by opening it, where folder-inherited access applies (checkPermission).
 * Everything inside shared folders is still findable through search (search-service.ts).
 *
 * Grants whose granter is deactivated are left out, matching checkPermission(): listing an item
 * the user can't actually open would just lead to a "not found".
 */
export async function listSharedWithMe(userId: string) {
  const allGrants = await db.permissions.findMany({
    where: { user_id: userId, role: { not: "owner" } },
    orderBy: { created_at: "desc" },
  });
  // granted_by is deliberately not a FK (0003), so there's no relation to filter through.
  const activeGranters = new Set(
    (
      await db.users.findMany({
        where: { id: { in: [...new Set(allGrants.map((g) => g.granted_by))] }, is_active: true },
        select: { id: true },
      })
    ).map((u) => u.id),
  );
  const grants = allGrants.filter((g) => activeGranters.has(g.granted_by));

  const items: { id: string; type: ItemType; name: string; role: Role }[] = [];
  for (const grant of grants) {
    if (grant.item_type === "file") {
      const file = await db.files.findFirst({ where: { id: grant.item_id, deleted_at: null } });
      if (file) items.push({ id: file.id, type: "file", name: file.name, role: grant.role });
    } else {
      const folder = await db.folders.findFirst({ where: { id: grant.item_id, deleted_at: null } });
      if (folder) items.push({ id: folder.id, type: "folder", name: folder.name, role: grant.role });
    }
  }
  return items;
}

/**
 * The current collaborator list for an item — who it's shared with and at what level. Requires
 * editor-or-above, same gate as granting/revoking; a plain viewer isn't shown who else has
 * access. The frontend's share dialog uses this to render existing collaborators alongside the
 * grant form (there was previously no way to see or manage this at all — no share UI existed).
 */
export async function listPermissions(actingUserId: string, itemType: ItemType, itemId: string) {
  const authorized = await checkPermission(actingUserId, itemType, itemId, "editor");
  if (!authorized) throw insufficientPermission();

  const grants = await db.permissions.findMany({
    where: { item_type: itemType, item_id: itemId, role: { not: "owner" } },
    include: { user: { select: { email: true, display_name: true } } },
    orderBy: { created_at: "asc" },
  });

  return grants.map((g) => ({
    userId: g.user_id,
    email: g.user.email,
    displayName: g.user.display_name,
    role: g.role as Exclude<Role, "owner">,
  }));
}

/**
 * Wraps the transfer_ownership() Postgres function (supabase/migrations/0008) — the only code
 * path permitted to change a PERMISSIONS 'owner' row, and the one that also keeps
 * FILES/FOLDERS.owner_id and storage_used_bytes in sync (see that migration's comments). Only
 * the current owner may transfer — UNLESS the acting user is an admin, per REQUIREMENTS.md
 * §5.10 ("change any user's permissions, including reassigning ownership of an item"): real gap
 * found while building Subcomponent 6, since this always passed p_bypass_authority_check=false,
 * meaning even an admin hit "INSUFFICIENT_PERMISSION" here despite checkPermission's admin
 * bypass suggesting otherwise everywhere else — this is the one write path that goes straight to
 * a Postgres function rather than through checkPermission, so it needed its own explicit check.
 */
export async function transferOwnership(
  actingUserId: string,
  itemType: ItemType,
  itemId: string,
  newOwnerId: string,
): Promise<void> {
  const actingUser = await db.users.findUnique({ where: { id: actingUserId }, select: { role: true } });
  const bypassAuthorityCheck = actingUser?.role === "admin";

  try {
    await db.$executeRaw`SELECT transfer_ownership(${itemType}::item_type, ${itemId}::uuid, ${newOwnerId}::uuid, ${actingUserId}::uuid, ${bypassAuthorityCheck})`;
  } catch (err) {
    // Pre-existing gap, closed here while touching this function anyway: transfer_ownership()'s
    // INSUFFICIENT_PERMISSION/OWNER_NOT_FOUND Postgres exceptions were previously unmapped and
    // fell through to a generic 500 instead of a proper 403/404.
    if (err instanceof Error && err.message.includes("INSUFFICIENT_PERMISSION")) throw insufficientPermission();
    if (err instanceof Error && err.message.includes("OWNER_NOT_FOUND")) throw itemNotFound();
    throw err;
  }

  await logActivity({
    actorId: actingUserId,
    subjectUserId: newOwnerId,
    itemType,
    itemId,
    action: "ownership_transfer",
    metadata: { newOwnerId },
  });
}
