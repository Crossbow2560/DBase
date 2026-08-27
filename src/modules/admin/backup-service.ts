import { backupBucket, listBackupBuckets, restoreBucket } from "../storage/client.js";
import { logActivity } from "./audit-service.js";
import { backupNotFound } from "./errors.js";

/**
 * REQUIREMENTS.md-equivalent admin ask: duplicate the entire object store into a separate
 * backup location on demand. storage/client.ts's backupBucket() does the actual MinIO work
 * (server-side copy into a fresh timestamped bucket); this just wraps it with the audit trail
 * every other admin action in this module gets.
 */
export async function runBackup(adminId: string) {
  const result = await backupBucket();

  await logActivity({
    actorId: adminId,
    subjectUserId: null,
    action: "backup_run",
    metadata: { backupBucket: result.backupBucket, objectCount: result.objectCount },
  });

  return result;
}

/** The restore page's picklist — every backup bucket a previous runBackup() call produced. */
export async function listBackups() {
  const buckets = await listBackupBuckets();
  return buckets.map((b) => ({ name: b.name, createdAt: b.createdAt.toISOString() }));
}

/**
 * Restores a specific previously-taken backup back into the live bucket. `backupBucketName` is
 * re-validated here against the actual current list of backups (not just storage/client.ts's own
 * prefix check) so a request naming a real-but-unrelated bucket, or one that's since been deleted,
 * fails with a clean 404 rather than either silently doing nothing useful or restoreBucket()'s
 * lower-level Error.
 */
export async function restoreBackup(adminId: string, backupBucketName: string) {
  const available = await listBackupBuckets();
  if (!available.some((b) => b.name === backupBucketName)) throw backupNotFound();

  const result = await restoreBucket(backupBucketName);

  await logActivity({
    actorId: adminId,
    subjectUserId: null,
    action: "backup_restore",
    metadata: { backupBucket: backupBucketName, objectCount: result.objectCount },
  });

  return result;
}
