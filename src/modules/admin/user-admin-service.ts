import { db } from "../../db.js";
import {
  userNotFound,
  invalidQuota,
  lastAdminStanding,
  invalidStorageLimit,
  quotaExceedsUnallocated,
  storageLimitBelowAllocation,
} from "./errors.js";
import { logActivity, logAdminViewIfNewSession } from "./audit-service.js";

function mapUserRow(user: {
  id: string;
  email: string;
  display_name: string;
  role: "user" | "admin";
  is_active: boolean;
  storage_used_bytes: bigint;
  storage_quota_bytes: bigint;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    isActive: user.is_active,
    // Safe as Number: quota/usage are byte counts on a single self-hosted deployment, nowhere
    // near Number.MAX_SAFE_INTEGER (~9 petabytes) — matches the admin UI's numeric fields.
    storageUsedBytes: Number(user.storage_used_bytes),
    storageQuotaBytes: Number(user.storage_quota_bytes),
  };
}

/** REQUIREMENTS.md §5.10: per-user storage usage, alongside role/active state for the admin UI. */
export async function listUsers() {
  const users = await db.users.findMany({ orderBy: { created_at: "asc" } });
  return users.map(mapUserRow);
}

/**
 * REQUIREMENTS.md §5.6: only an admin can change a user's quota; 0 is valid, negative is not.
 * Reducing below current usage is explicitly allowed (existing files/data are untouched — this
 * only affects future uploads). Raising it is bounded by the system's unallocated space —
 * quotas are pre-allocated out of the system-wide limit (supabase/migrations/
 * 0022_preallocate_user_quotas.sql, which is the real enforcement; the catch below only turns
 * its exception into a useful message).
 */
export async function changeQuota(adminId: string, targetUserId: string, quotaBytes: number): Promise<void> {
  if (!Number.isInteger(quotaBytes) || quotaBytes < 0) throw invalidQuota();

  const user = await db.users.findUnique({ where: { id: targetUserId } });
  if (!user) throw userNotFound();

  try {
    await db.users.update({ where: { id: targetUserId }, data: { storage_quota_bytes: BigInt(quotaBytes) } });
  } catch (err) {
    if (err instanceof Error && err.message.includes("SYSTEM_STORAGE_ALLOCATION_EXCEEDED")) {
      const { limit, allocated } = await getAllocation();
      const available = limit - (user.email_verified ? allocated - user.storage_quota_bytes : allocated);
      throw quotaExceedsUnallocated(available > 0n ? available : 0n);
    }
    throw err;
  }

  await logActivity({
    actorId: adminId,
    subjectUserId: targetUserId,
    action: "quota_change",
    metadata: {
      subjectEmail: user.email,
      previousQuotaBytes: user.storage_quota_bytes.toString(),
      newQuotaBytes: quotaBytes.toString(),
    },
  });
}

/**
 * REQUIREMENTS.md §4: role is a simple binary flag; the last-admin-standing guard itself is
 * enforced at the database level (trigger, migration 0008) — this just maps that Postgres
 * exception to a proper API error rather than a generic 500.
 */
export async function changeRole(adminId: string, targetUserId: string, role: "user" | "admin"): Promise<void> {
  const user = await db.users.findUnique({ where: { id: targetUserId } });
  if (!user) throw userNotFound();

  try {
    await db.users.update({ where: { id: targetUserId }, data: { role } });
  } catch (err) {
    if (err instanceof Error && err.message.includes("LAST_ADMIN")) throw lastAdminStanding();
    throw err;
  }

  await logActivity({
    actorId: adminId,
    subjectUserId: targetUserId,
    action: "permission_change",
    metadata: { subjectEmail: user.email, previousRole: user.role, newRole: role },
  });
}

/**
 * DESIGN.md §4.3: system-wide storage stats are a point-in-time approximation — SUM() over
 * USERS.storage_used_bytes doesn't account for bytes tied up in in-flight UPLOAD_SESSIONS or
 * still-`pending` DELETION_QUEUE rows, which this deliberately does not attempt to include.
 */
export async function getSystemStats() {
  const [totalUsers, usage] = await Promise.all([
    db.users.count(),
    db.users.aggregate({ _sum: { storage_used_bytes: true } }),
  ]);
  return {
    totalUsers,
    totalStorageUsedBytes: Number(usage._sum.storage_used_bytes ?? 0n),
  };
}

/**
 * The system-wide hard cap on SUM(users.storage_used_bytes) — the same number
 * supabase/migrations/0015_system_storage_limit.sql's trigger enforces on every upload, surfaced
 * here so the admin UI can show and edit it. totalStorageUsedBytes duplicates getSystemStats()'s
 * own aggregate rather than sharing one round trip with it — this endpoint is deliberately
 * standalone so the settings page doesn't need to also fetch /admin/stats to render a usage bar
 * next to the limit it's editing.
 */
export async function getSystemStorageSettings() {
  const [settings, usage, allocation] = await Promise.all([
    db.system_settings.findUniqueOrThrow({ where: { id: true } }),
    db.users.aggregate({ _sum: { storage_used_bytes: true } }),
    db.users.aggregate({ where: { email_verified: true }, _sum: { storage_quota_bytes: true } }),
  ]);
  return {
    totalStorageLimitBytes: Number(settings.total_storage_limit_bytes),
    totalStorageUsedBytes: Number(usage._sum.storage_used_bytes ?? 0n),
    // SUM of every verified account's quota — pre-allocated out of the limit (0022), so this is
    // what actually decides whether a new account can register or a quota can be raised.
    // Unverified sign-ups don't hold an allocation until they verify.
    totalStorageAllocatedBytes: Number(allocation._sum.storage_quota_bytes ?? 0n),
  };
}

async function getAllocation() {
  const [settings, usage] = await Promise.all([
    db.system_settings.findUniqueOrThrow({ where: { id: true } }),
    db.users.aggregate({ where: { email_verified: true }, _sum: { storage_quota_bytes: true } }),
  ]);
  return { limit: settings.total_storage_limit_bytes, allocated: usage._sum.storage_quota_bytes ?? 0n };
}

/**
 * REQUIREMENTS.md §5.6-equivalent for the system-wide cap: only an admin can change it. Same
 * "lowering below current usage is allowed" philosophy as changeQuota() above — it only affects
 * future uploads, not existing data. It can't go below the total already allocated to user
 * quotas, though (0022's trigger enforces that; this just maps its exception). The real
 * enforcement is still the DB triggers (0015, 0022), not this function.
 */
export async function setSystemStorageLimit(adminId: string, limitBytes: number): Promise<void> {
  if (!Number.isInteger(limitBytes) || limitBytes < 0) throw invalidStorageLimit();

  const previous = await db.system_settings.findUniqueOrThrow({ where: { id: true } });
  try {
    await db.system_settings.update({ where: { id: true }, data: { total_storage_limit_bytes: BigInt(limitBytes) } });
  } catch (err) {
    if (err instanceof Error && err.message.includes("STORAGE_LIMIT_BELOW_ALLOCATION")) {
      const { allocated } = await getAllocation();
      throw storageLimitBelowAllocation(allocated);
    }
    throw err;
  }

  await logActivity({
    actorId: adminId,
    subjectUserId: null,
    action: "system_storage_limit_change",
    metadata: {
      previousLimitBytes: previous.total_storage_limit_bytes.toString(),
      newLimitBytes: limitBytes.toString(),
    },
  });
}

/** DESIGN.md §3.10: DELETION_QUEUE rows stuck in `failed` after bounded retries, for manual investigation. */
export async function listFailedDeletions() {
  const rows = await db.deletion_queue.findMany({
    where: { status: "failed" },
    orderBy: { enqueued_at: "desc" },
  });
  return rows.map((row) => ({
    id: row.id,
    itemType: row.item_type,
    itemId: row.item_id,
    attempts: row.attempts,
    enqueuedAt: row.enqueued_at.toISOString(),
  }));
}

export async function listActivity(limit = 200) {
  const rows = await db.activity_log.findMany({ orderBy: { created_at: "desc" }, take: limit });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorId: row.actor_id,
    subjectUserId: row.subject_user_id,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * REQUIREMENTS.md §5.10: an admin can view any user's files/folders regardless of ownership or
 * sharing — every such view is itself a loggable action (logAdminViewIfNewSession dedupes to
 * once per ~30-minute browsing session, not once per file, DESIGN.md §3.9 Pass 6). Matches the
 * scaffolded admin UI's flat root-listing page; an optional folderId lets an admin drill into a
 * subfolder the same way, since checkPermission's admin bypass already authorizes that without
 * any further change here.
 */
export async function adminGetUserFiles(adminId: string, targetUserId: string, folderId?: string) {
  const targetUser = await db.users.findUnique({ where: { id: targetUserId } });
  if (!targetUser) throw userNotFound();

  await logAdminViewIfNewSession(adminId, targetUserId);

  if (folderId) {
    // Not owner_id-scoped, same as folder-service.ts's getFolderContents — a shared/nested
    // folder can hold items owned by someone other than targetUserId, and this is still "this
    // user's files" from the browsing admin's point of view since they got here by drilling into
    // targetUserId's own tree.
    const folder = await db.folders.findFirst({ where: { id: folderId, deleted_at: null } });
    if (!folder) throw userNotFound();

    const [folders, files] = await Promise.all([
      db.folders.findMany({ where: { parent_folder_id: folderId, deleted_at: null }, orderBy: { name: "asc" } }),
      db.files.findMany({ where: { folder_id: folderId, deleted_at: null }, orderBy: { name: "asc" } }),
    ]);
    return {
      folder: { id: folder.id, name: folder.name, parentFolderId: folder.parent_folder_id },
      items: serializeAdminItems(folders, files),
    };
  }

  const [folders, files] = await Promise.all([
    db.folders.findMany({
      where: { owner_id: targetUserId, parent_folder_id: null, deleted_at: null },
      orderBy: { name: "asc" },
    }),
    db.files.findMany({
      where: { owner_id: targetUserId, folder_id: null, deleted_at: null },
      orderBy: { name: "asc" },
    }),
  ]);
  return { folder: null, items: serializeAdminItems(folders, files) };
}

function serializeAdminItems(
  folders: { id: string; name: string; updated_at: Date }[],
  files: { id: string; name: string; size_bytes: bigint; mime_type: string; updated_at: Date }[],
) {
  return [
    ...folders.map((f) => ({ id: f.id, name: f.name, type: "folder" as const, updatedAt: f.updated_at.toISOString() })),
    ...files.map((f) => ({
      id: f.id,
      name: f.name,
      type: "file" as const,
      sizeBytes: f.size_bytes.toString(),
      mimeType: f.mime_type,
      updatedAt: f.updated_at.toISOString(),
    })),
  ];
}
