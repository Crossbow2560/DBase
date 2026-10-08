import { db } from "../../db.js";
import { config } from "../../config.js";

/**
 * The quota a newly created account starts with: the admin-set value in system_settings
 * (supabase/migrations/0026_default_user_quota_setting.sql), or DEFAULT_USER_QUOTA_BYTES until an
 * admin has set one.
 */
export async function getDefaultUserQuotaBytes(): Promise<bigint> {
  const settings = await db.system_settings.findUnique({
    where: { id: true },
    select: { default_user_quota_bytes: true },
  });
  return settings?.default_user_quota_bytes ?? config.defaultUserQuotaBytes;
}
