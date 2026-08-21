-- =============================================================================
-- 0011_harden_function_search_paths.sql
-- Pins search_path on every function this schema defines, closing the
-- "function_search_path_mutable" advisor warning: without an explicit search_path, each
-- function resolves unqualified table names (users, permissions, files, ...) via whatever
-- search_path is active in the calling session, which a sufficiently privileged/malicious
-- caller could manipulate to shadow those names with objects of their own choosing. Pinning
-- to 'public, pg_temp' removes that degree of freedom without changing any behavior, since
-- every table these functions reference already lives in public.
-- =============================================================================

alter function users_enforce_quota_on_increase() set search_path = public, pg_temp;
alter function files_folders_guard_owner_id_change() set search_path = public, pg_temp;
alter function touch_updated_at() set search_path = public, pg_temp;
alter function users_enforce_last_admin_standing() set search_path = public, pg_temp;
alter function transfer_ownership(item_type, uuid, uuid, uuid, boolean) set search_path = public, pg_temp;
alter function reassign_all_owned_items(uuid, uuid, uuid) set search_path = public, pg_temp;
alter function delete_account(uuid, uuid, uuid) set search_path = public, pg_temp;
