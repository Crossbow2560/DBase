-- =============================================================================
-- 0019_activity_action_backup_restore.sql
-- Extends the closed activity_action enum (0007, 0016, 0018) with the admin-triggered MinIO
-- restore-from-backup action (src/modules/admin/backup-service.ts).
-- =============================================================================

alter type activity_action add value 'backup_restore';
