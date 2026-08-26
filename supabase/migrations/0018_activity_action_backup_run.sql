-- =============================================================================
-- 0018_activity_action_backup_run.sql
-- Extends the closed activity_action enum (0007, 0016) with the admin-triggered MinIO backup
-- action (src/modules/admin/backup-service.ts).
-- =============================================================================

alter type activity_action add value 'backup_run';
