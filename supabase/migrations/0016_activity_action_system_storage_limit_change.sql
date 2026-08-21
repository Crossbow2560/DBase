-- =============================================================================
-- 0016_activity_action_system_storage_limit_change.sql
-- Extends the closed activity_action enum (0007) with the one new admin action
-- 0015_system_storage_limit.sql's admin-editable cap needs to log distinctly from the existing
-- per-user 'quota_change' — this is a system-wide setting change, not a specific account's quota.
-- =============================================================================

alter type activity_action add value 'system_storage_limit_change';
