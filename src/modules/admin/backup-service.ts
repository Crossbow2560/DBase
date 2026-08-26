import { backupBucket } from "../storage/client.js";
import { logActivity } from "./audit-service.js";

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
