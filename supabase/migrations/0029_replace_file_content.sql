-- =============================================================================
-- 0029_replace_file_content.sql
-- Replacing an existing file's content in place (sync clients pushing a local edit), and
-- recording a client-computed SHA-256 for every upload.
--
-- UPLOAD_SESSIONS
--   replace_file_id    the file whose content this session replaces; null = a new file. Not a
--                      foreign key: a purge must not be blocked by (or cascade into) a session,
--                      and completion re-checks that the file is still live anyway.
--   expected_version   compare-and-swap: completion fails with CONTENT_CONFLICT unless the file's
--                      current content version still equals this — so a client can't overwrite an
--                      edit it never saw. A content version is an opaque hash of the file's
--                      storage_key (files/content-version.ts), which changes exactly when the
--                      content does; checksums can't serve here, since web uploads don't send one.
--   checksum           the client's SHA-256 of the whole upload, copied to files.checksum. The
--                      server doesn't hash the bytes itself (parts are composed inside MinIO), so
--                      this is the uploader's claim — sync clients use it to verify downloads,
--                      not as a server-side integrity guarantee.
--
-- DELETION_QUEUE.blob_only
--   A replace leaves the old object behind; it's queued for removal like a purge, but the FILES
--   row must survive and its quota was already settled in the replace transaction. Such rows
--   carry a fresh random item_id rather than the file's id, so none of the "is this item already
--   being purged?" checks (restore, purge-now, the expiry scan, the in-flight unique index)
--   mistake an old blob's cleanup for the file itself being deleted.
-- =============================================================================

alter table upload_sessions
  add column replace_file_id   uuid,
  add column expected_version  text,
  add column checksum          text,
  add constraint upload_sessions_expected_version_format check (expected_version ~ '^[0-9a-f]{32}$'),
  add constraint upload_sessions_checksum_format check (checksum ~ '^[0-9a-f]{64}$');

alter table deletion_queue
  add column blob_only boolean not null default false,
  add constraint deletion_queue_blob_only_settled check (not blob_only or size_bytes = 0);
