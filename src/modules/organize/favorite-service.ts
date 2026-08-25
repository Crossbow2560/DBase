import { db } from "../../db.js";
import { checkPermission } from "../access/permission-check.js";
import type { ItemType } from "../access/permission-check.js";
import { logActivity } from "../admin/audit-service.js";
import { itemNotFound } from "./errors.js";

/**
 * REQUIREMENTS.md §5.7: favoriting requires at least viewer-level access to the item (owner,
 * direct grant, or inherited folder share) and the item must currently be live — access via an
 * anonymous share link doesn't qualify, which is automatically satisfied here since
 * checkPermission only resolves PERMISSIONS-based access, never SHARE_LINKS. Idempotent:
 * favoriting an already-favorited item is a no-op, not an error.
 */
export async function addFavorite(userId: string, itemType: ItemType, itemId: string): Promise<void> {
  if (!(await checkPermission(userId, itemType, itemId, "viewer"))) throw itemNotFound();
  if (!(await isLive(itemType, itemId))) throw itemNotFound();

  await db.$executeRaw`
    INSERT INTO favorites (user_id, item_type, item_id) VALUES (${userId}::uuid, ${itemType}::item_type, ${itemId}::uuid)
    ON CONFLICT (user_id, item_type, item_id) DO NOTHING
  `;

  // REQUIREMENTS.md §5.13: a favorite is the favoriting user's own data, not the item owner's —
  // subject === actor here, unlike write actions that mutate the item itself.
  await logActivity({ actorId: userId, subjectUserId: userId, itemType, itemId, action: "favorite" });
}

/** REQUIREMENTS.md §5.7: users can unmark a favorite at any time — idempotent, never an error. */
export async function removeFavorite(userId: string, itemType: ItemType, itemId: string): Promise<void> {
  await db.favorites.deleteMany({ where: { user_id: userId, item_type: itemType, item_id: itemId } });
  await logActivity({ actorId: userId, subjectUserId: userId, itemType, itemId, action: "unfavorite" });
}

/**
 * DESIGN.md §3.11: favorites are resolved lazily at render time, not eagerly invalidated when
 * access changes — a row that no longer resolves (item purged, or access since revoked) is
 * pruned from storage right here rather than merely hidden in the response.
 *
 * Known gap (IMPLEMENTATION_PHASES.md #4, explicitly flagged as deferred there): REQUIREMENTS.md
 * §5.7 requires a favorite to survive a *reversible* access loss (e.g. the sharing user's
 * account being deactivated, not deleted) — hidden while deactivated, then reappearing
 * automatically on reactivation, without being deleted from storage in the meantime.
 * checkPermission()/resolveEffectiveRole() don't yet factor in account deactivation at all
 * (Subcomponent 7, Account Lifecycle, hasn't been built), so there is currently no way for this
 * function to distinguish "permanently lost access" from "temporarily suspended by a reversible
 * deactivation" — every visibility failure is treated as permanent and the row is deleted. This
 * needs revisiting once Subcomponent 7 lands deactivation-awareness in the access-check path.
 */
export async function listFavorites(userId: string) {
  const rows = await db.favorites.findMany({ where: { user_id: userId }, orderBy: { created_at: "desc" } });

  const result: {
    id: string;
    name: string;
    type: ItemType;
    sizeBytes?: string;
    mimeType?: string;
    updatedAt: string;
  }[] = [];
  for (const row of rows) {
    const details = await resolveVisibleItem(userId, row.item_type, row.item_id);
    if (details === null) {
      await db.favorites.deleteMany({ where: { user_id: userId, item_type: row.item_type, item_id: row.item_id } });
      continue;
    }
    result.push({ id: row.item_id, type: row.item_type, ...details });
  }
  return result;
}

async function isLive(itemType: ItemType, itemId: string): Promise<boolean> {
  if (itemType === "file") {
    return (await db.files.findFirst({ where: { id: itemId, deleted_at: null } })) !== null;
  }
  return (await db.folders.findFirst({ where: { id: itemId, deleted_at: null } })) !== null;
}

/**
 * Same fields folder-service.ts's serializeItems() returns for a folder listing — the frontend
 * renders favorited files/folders through the same list/grid components as a folder's contents
 * (Size/Modified columns, grid thumbnails), so this needs to carry the same shape rather than
 * just a name.
 */
export async function resolveVisibleItem(
  userId: string,
  itemType: ItemType,
  itemId: string,
): Promise<{ name: string; sizeBytes?: string; mimeType?: string; updatedAt: string } | null> {
  if (!(await checkPermission(userId, itemType, itemId, "viewer"))) return null;
  if (itemType === "file") {
    const file = await db.files.findFirst({
      where: { id: itemId, deleted_at: null },
      select: { name: true, size_bytes: true, mime_type: true, updated_at: true },
    });
    if (!file) return null;
    return {
      name: file.name,
      sizeBytes: file.size_bytes.toString(),
      mimeType: file.mime_type,
      updatedAt: file.updated_at.toISOString(),
    };
  }
  const folder = await db.folders.findFirst({
    where: { id: itemId, deleted_at: null },
    select: { name: true, updated_at: true },
  });
  if (!folder) return null;
  return { name: folder.name, updatedAt: folder.updated_at.toISOString() };
}
