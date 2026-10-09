import { db } from "../../db.js";
import { logActivity } from "../admin/audit-service.js";
import { userNotFound, lastAdminStanding, noSystemAdmin } from "./errors.js";
import { revokeAllDeviceTokens } from "../accounts/device-token-service.js";

function isLastAdminError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("LAST_ADMIN");
}

/**
 * REQUIREMENTS.md §5.1: deactivation is fully reversible and mutates no data — every dependent
 * effect (sessions dead, share links down, direct/inherited shares suspended) is enforced by
 * other code paths re-checking `is_active` live (accounts/service.ts's resolveSession,
 * access/share-link-service.ts's resolveShareLink, access/permission-check.ts's
 * resolveEffectiveRole) rather than by anything this function does beyond flipping the flag and
 * killing existing sessions — there is no separate state to "turn back on" at reactivation time.
 */
export async function deactivateAccount(adminId: string, targetUserId: string): Promise<void> {
  const user = await db.users.findUnique({ where: { id: targetUserId } });
  if (!user) throw userNotFound();

  try {
    await db.users.update({ where: { id: targetUserId }, data: { is_active: false } });
  } catch (err) {
    if (isLastAdminError(err)) throw lastAdminStanding();
    throw err;
  }

  // Every active session invalidated immediately (REQUIREMENTS.md §5.1) — an already-issued
  // session cookie must stop working on its very next use, not just future login attempts.
  await db.sessions.updateMany({
    where: { user_id: targetUserId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  // Not strictly needed (resolveDeviceToken also rejects inactive users), but reactivation must
  // not silently bring old devices back — the user signs them in again.
  await revokeAllDeviceTokens(targetUserId);

  await logActivity({
    actorId: adminId,
    subjectUserId: targetUserId,
    action: "account_deactivate",
    metadata: { subjectEmail: user.email },
  });
}

export async function reactivateAccount(adminId: string, targetUserId: string): Promise<void> {
  const user = await db.users.findUnique({ where: { id: targetUserId } });
  if (!user) throw userNotFound();

  await db.users.update({ where: { id: targetUserId }, data: { is_active: true } });

  await logActivity({
    actorId: adminId,
    subjectUserId: targetUserId,
    action: "account_reactivate",
    metadata: { subjectEmail: user.email },
  });
}

/**
 * REQUIREMENTS.md §5.1.1: "a designated system admin account" — this deployment has no separate
 * concept of one, so the oldest still-active admin account stands in for it, deterministically.
 */
async function getDefaultReassignmentOwner(excludeUserId: string): Promise<string> {
  const admin = await db.users.findFirst({
    where: { role: "admin", is_active: true, id: { not: excludeUserId } },
    orderBy: { created_at: "asc" },
  });
  if (!admin) throw noSystemAdmin();
  return admin.id;
}

/**
 * REQUIREMENTS.md §5.1.1 / DESIGN.md §7 item #6: wraps the delete_account() Postgres function
 * (migration 0008), which already performs the fully-specified atomic procedure — bulk
 * ownership reassignment, session invalidation, then DELETE FROM USERS (whose ON DELETE CASCADE
 * side effects handle SHARE_LINKS/PERMISSIONS-as-grantee/TAGS/FAVORITES; ACTIVITY_LOG survives
 * by design, no FK at all). This wrapper's only job is: resolving the replacement owner per the
 * self-service-vs-admin policy, mapping the last-admin-standing exception, and writing the audit
 * row afterward (the user row is already gone by then, which is fine — no FK).
 *
 * No EFFECTIVE_PERMISSIONS rebuild is enqueued after the PERMISSIONS-as-grantee cascade DESIGN.md
 * calls for (§7 item #6(c)) — this schema deliberately has no such cache to rebuild
 * (access/permission-check.ts always resolves synchronously), so that step is a no-op here by
 * architecture, not an oversight.
 */
export async function deleteAccount(
  actingUserId: string,
  targetUserId: string,
  replacementOwnerId?: string,
): Promise<void> {
  const user = await db.users.findUnique({ where: { id: targetUserId } });
  if (!user) throw userNotFound();

  const isSelfService = actingUserId === targetUserId;

  // REQUIREMENTS.md §5.1.1: self-service deletion always uses the default policy — a departing
  // user cannot choose who inherits their files, even if a replacementOwnerId were somehow
  // passed through from the client on that path.
  let targetOwnerId: string;
  if (isSelfService || !replacementOwnerId) {
    targetOwnerId = await getDefaultReassignmentOwner(targetUserId);
  } else {
    const replacement = await db.users.findUnique({ where: { id: replacementOwnerId } });
    if (!replacement) throw userNotFound();
    targetOwnerId = replacementOwnerId;
  }

  try {
    await db.$executeRaw`SELECT delete_account(${targetUserId}::uuid, ${targetOwnerId}::uuid, ${actingUserId}::uuid)`;
  } catch (err) {
    if (isLastAdminError(err)) throw lastAdminStanding();
    throw err;
  }

  await logActivity({
    actorId: actingUserId,
    subjectUserId: targetUserId,
    action: "account_delete",
    metadata: { subjectEmail: user.email, subjectDisplayName: user.display_name, reassignedTo: targetOwnerId },
  });
}
