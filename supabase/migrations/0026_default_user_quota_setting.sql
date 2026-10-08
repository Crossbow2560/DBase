-- =============================================================================
-- 0026_default_user_quota_setting.sql
-- The quota a newly registered account starts with becomes an admin-editable setting instead of
-- only the DEFAULT_USER_QUOTA_BYTES environment variable, so changing it no longer needs a
-- redeploy. NULL means "not set from the admin panel yet": the application falls back to
-- DEFAULT_USER_QUOTA_BYTES, so existing deployments keep their current default untouched.
--
-- Only accounts created after a change get the new default — existing quotas are never rewritten.
-- =============================================================================

alter table system_settings
  add column default_user_quota_bytes bigint,
  add constraint system_settings_default_quota_non_negative
    check (default_user_quota_bytes is null or default_user_quota_bytes >= 0);

comment on column system_settings.default_user_quota_bytes is
  'Quota (bytes) given to newly registered accounts. NULL = use the DEFAULT_USER_QUOTA_BYTES env var.';

alter type activity_action add value 'default_quota_change';
