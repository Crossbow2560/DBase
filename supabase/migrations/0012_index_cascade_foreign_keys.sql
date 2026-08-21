-- =============================================================================
-- 0012_index_cascade_foreign_keys.sql
-- Covers six foreign keys the performance advisor flagged as unindexed — all six are exactly
-- the ON DELETE CASCADE / SET NULL columns added earlier (0002-0004) to fix real
-- account-deletion/revoke/purge blocking bugs. Without a covering index on the referencing
-- column, Postgres must sequentially scan the whole child table to find rows to
-- cascade/null-out every time the parent side of the FK is deleted — harmless at zero rows,
-- a real cost once these tables hold data (deleting a user, revoking a permission, or purging
-- a file are not rare operations in this schema).
-- =============================================================================

-- Supports DELETION_QUEUE's worker crediting quota back to owner_id, and now also the
-- ON DELETE SET NULL added in 0004 for the account-deleted-mid-purge edge case.
create index idx_deletion_queue_owner_id on deletion_queue(owner_id);

-- Supports the ON DELETE SET NULL added in 0003 so an ordinary revoke (deleting a PERMISSIONS
-- row) isn't blocked by scanning every EFFECTIVE_PERMISSIONS row for a stale pointer.
create index idx_effective_permissions_source_permission_id on effective_permissions(source_permission_id);

-- effective_permissions' primary key (item_type, item_id, user_id) has user_id as a trailing
-- column, same reverse-lookup gap as FAVORITES/ITEM_TAGS (DESIGN.md §5.1) — needed for the
-- ON DELETE CASCADE from USERS to resolve efficiently on account deletion.
create index idx_effective_permissions_user_id on effective_permissions(user_id);

-- Supports the ON DELETE CASCADE on created_by (0003) for account deletion.
create index idx_share_links_created_by on share_links(created_by);

-- Supports the ON DELETE CASCADE on file_id (0002) so DELETION_QUEUE's file purge isn't
-- blocked by scanning every UPLOAD_SESSIONS row for a stale reference.
create index idx_upload_sessions_file_id on upload_sessions(file_id);

-- Supports the ON DELETE SET NULL on target_folder_id (0002) for folder purges.
create index idx_upload_sessions_target_folder_id on upload_sessions(target_folder_id);
