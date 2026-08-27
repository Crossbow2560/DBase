import type { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import type { ItemType } from "../access/permission-check.js";

type ActivityAction =
  | "upload" | "download" | "rename" | "move" | "delete" | "restore" | "purge"
  | "share" | "unshare" | "create_share_link" | "revoke_share_link"
  | "favorite" | "unfavorite" | "tag" | "untag"
  | "quota_change" | "system_storage_limit_change" | "permission_change" | "ownership_transfer"
  | "backup_run" | "backup_restore"
  | "view"
  | "account_deactivate" | "account_reactivate" | "account_delete";

/**
 * REQUIREMENTS.md §5.13: every entry records who performed the action (actor) and, distinctly,
 * whose account/data was affected (subject) — equal for an ordinary self-service action, distinct
 * for an admin acting on someone else's account/data. Append-only, no update/delete path exists.
 *
 * actor_id/subject_user_id are deliberately not validated against a live USERS row here (no FK,
 * migration 0007) — a row logged moments before an account deletion must still write cleanly.
 */
export async function logActivity(entry: {
  actorId: string | null;
  subjectUserId: string | null;
  itemType?: ItemType;
  itemId?: string;
  action: ActivityAction;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.activity_log.create({
    data: {
      actor_id: entry.actorId,
      subject_user_id: entry.subjectUserId,
      item_type: entry.itemType,
      item_id: entry.itemId,
      action: entry.action,
      metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}

// DESIGN.md §3.9 (Pass 6): a `view` row is written once per admin browsing session of another
// user's content, not once per file glanced at — approximated here as "not already logged within
// the last N minutes for this exact (admin, subject) pair," since this app has no separate
// browsing-session object distinct from the login session itself.
const VIEW_SESSION_WINDOW_MS = 30 * 60 * 1000;

export async function logAdminViewIfNewSession(adminId: string, subjectUserId: string): Promise<void> {
  const recent = await db.activity_log.findFirst({
    where: {
      actor_id: adminId,
      subject_user_id: subjectUserId,
      action: "view",
      created_at: { gt: new Date(Date.now() - VIEW_SESSION_WINDOW_MS) },
    },
  });
  if (recent) return;
  await logActivity({ actorId: adminId, subjectUserId, action: "view" });
}

/**
 * DESIGN.md §4.2: usage frequency is computed by aggregating ACTIVITY_LOG, not maintained as a
 * live counter table. Counts `download` and `view` events per item as a reasonable proxy for
 * "how often is this accessed."
 */
export async function getUsageFrequency(limit = 50) {
  const rows = await db.activity_log.groupBy({
    by: ["item_type", "item_id"],
    where: { action: { in: ["download", "view"] }, item_id: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { item_id: "desc" } },
    take: limit,
  });
  return rows.map((row) => ({ itemType: row.item_type, itemId: row.item_id, accessCount: row._count._all }));
}
