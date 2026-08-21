import { db } from "../../db.js";
import { generateToken } from "../../lib/tokens.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { checkPermission, resolveEffectiveRole, type ItemType, type Role } from "./permission-check.js";
import { insufficientPermission, shareLinkNotFound, invalidSharePassword, tooManyPasswordAttempts } from "./errors.js";
import { logActivity } from "../admin/audit-service.js";

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSWORD_ATTEMPTS = 10;

/** DESIGN.md §3.6: the same granting-authority check as a direct PERMISSIONS grant. */
export async function createShareLink(
  actingUserId: string,
  itemType: ItemType,
  itemId: string,
  role: "viewer" | "editor",
  options: { password?: string; expiresAt?: Date },
) {
  const authorized = await checkPermission(actingUserId, itemType, itemId, "editor");
  if (!authorized) throw insufficientPermission();

  const actorRole = await resolveEffectiveRole(actingUserId, itemType, itemId);
  if (!actorRole || ROLE_RANK[role] > ROLE_RANK[actorRole]) throw insufficientPermission();

  const token = generateToken();
  const passwordHash = options.password ? await hashPassword(options.password) : null;

  const link = await db.share_links.create({
    data: {
      item_type: itemType,
      item_id: itemId,
      token,
      role,
      password_hash: passwordHash,
      expires_at: options.expiresAt ?? null,
      created_by: actingUserId,
    },
  });

  const ownerGrant = await db.permissions.findFirst({ where: { item_type: itemType, item_id: itemId, role: "owner" } });
  await logActivity({
    actorId: actingUserId,
    subjectUserId: ownerGrant?.user_id ?? null,
    itemType,
    itemId,
    action: "create_share_link",
  });

  return link;
}

export async function revokeShareLink(actingUserId: string, shareLinkId: string): Promise<void> {
  // Only the creator may revoke — REQUIREMENTS.md §5.5 doesn't grant this to the item's owner
  // if they aren't the link's own creator (DESIGN.md §3.8's "a link's fate follows its own
  // creator" rule cuts both ways).
  const link = await db.share_links.findFirst({ where: { id: shareLinkId, created_by: actingUserId } });
  if (!link) throw shareLinkNotFound();

  await db.share_links.delete({ where: { id: shareLinkId } });

  const ownerGrant = await db.permissions.findFirst({
    where: { item_type: link.item_type, item_id: link.item_id, role: "owner" },
  });
  await logActivity({
    actorId: actingUserId,
    subjectUserId: ownerGrant?.user_id ?? null,
    itemType: link.item_type,
    itemId: link.item_id,
    action: "revoke_share_link",
  });
}

/** Every share link on an item, for the share dialog — same editor-or-above gate as listPermissions. */
export async function listShareLinksForItem(actingUserId: string, itemType: ItemType, itemId: string) {
  const authorized = await checkPermission(actingUserId, itemType, itemId, "editor");
  if (!authorized) throw insufficientPermission();

  const links = await db.share_links.findMany({
    where: { item_type: itemType, item_id: itemId },
    orderBy: { created_at: "desc" },
  });

  return links.map((link) => ({
    id: link.id,
    token: link.token,
    role: link.role,
    hasPassword: link.password_hash !== null,
    expiresAt: link.expires_at?.toISOString() ?? null,
    createdBy: link.created_by,
    createdAt: link.created_at.toISOString(),
  }));
}

/**
 * DESIGN.md §3.8: every access attempt joins to users on created_by and checks is_active —
 * a deactivated creator's links are denied, application-layer, no DB backstop (accepted risk,
 * DESIGN.md §4.3). Also enforces the password-attempt throttle (10 failures / 15-minute window,
 * keyed on the token itself) when the link is password-protected.
 */
export async function resolveShareLink(token: string, password?: string) {
  const link = await db.share_links.findUnique({ where: { token }, include: { creator: true } });
  if (!link || !link.creator.is_active) throw shareLinkNotFound();
  if (link.expires_at && link.expires_at < new Date()) throw shareLinkNotFound();

  if (link.password_hash) {
    const now = new Date();
    const windowExpired =
      !link.failed_attempts_window_started_at ||
      now.getTime() - link.failed_attempts_window_started_at.getTime() > PASSWORD_ATTEMPT_WINDOW_MS;

    const attemptsBefore = windowExpired ? 0 : link.failed_password_attempts;
    if (attemptsBefore >= MAX_PASSWORD_ATTEMPTS) throw tooManyPasswordAttempts();

    const passwordOk = password ? await verifyPassword(password, link.password_hash) : false;

    if (!passwordOk) {
      await db.share_links.update({
        where: { id: link.id },
        data: {
          failed_password_attempts: attemptsBefore + 1,
          failed_attempts_window_started_at: windowExpired ? now : link.failed_attempts_window_started_at,
        },
      });
      throw invalidSharePassword();
    }

    if (attemptsBefore > 0 || windowExpired) {
      await db.share_links.update({
        where: { id: link.id },
        data: { failed_password_attempts: 0, failed_attempts_window_started_at: null },
      });
    }
  }

  return link;
}
