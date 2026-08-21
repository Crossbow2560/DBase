-- =============================================================================
-- 0002_core_filesystem.sql
-- Subcomponent 1 (IMPLEMENTATION_PHASES.md): FOLDERS, FILES, UPLOAD_SESSIONS
-- Source: DESIGN.md v7 §3.3, §3.4, §3.5
-- =============================================================================

create type upload_status as enum ('pending', 'complete');
create type thumbnail_status as enum ('none', 'pending', 'ready', 'failed');
create type upload_session_status as enum ('pending', 'complete', 'aborted');

-- Guards against the exact bug class transfer_ownership() (0008) exists to prevent: FILES/
-- FOLDERS.owner_id must never change except through that function, which keeps it in sync
-- with the PERMISSIONS 'owner' row in the same transaction. Without this guard, nothing stops
-- a stray `UPDATE files SET owner_id = ...` from silently desyncing the two representations
-- again. Same transaction-local-flag pattern as users_enforce_quota_on_increase's bypass
-- (0001): transfer_ownership() sets 'dbase.allow_owner_id_change' to 'true' immediately
-- around its own owner_id UPDATE, then resets it, so no other statement in the same
-- transaction is inadvertently exempted.
create or replace function files_folders_guard_owner_id_change()
returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id
     and coalesce(current_setting('dbase.allow_owner_id_change', true), 'false') <> 'true' then
    raise exception 'OWNER_ID_DIRECT_WRITE_BLOCKED: owner_id on % % may only be changed via transfer_ownership()/reassign_all_owned_items() (0008)',
      tg_table_name, old.id;
  end if;
  return new;
end;
$$;

-- Matches USERS' pattern (0001), where updated_at is bumped as a side effect of the same
-- trigger that enforces quota — FILES/FOLDERS have no equivalent always-firing trigger of
-- their own, so every mutating statement (rename, move, restore, ...) would otherwise have to
-- remember to set updated_at explicitly. This makes it automatic and unconditional instead.
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- FOLDERS  (DESIGN.md §3.3)
-- -----------------------------------------------------------------------------
create table folders (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  owner_id           uuid not null references users(id),
  -- No ON DELETE action, deliberately: a folder purge must go through DELETION_QUEUE (0004),
  -- which deletes each descendant's blob before its DB row. If this were ON DELETE CASCADE, a
  -- direct `DELETE FROM folders` on a folder that still has live children would silently
  -- cascade-delete every descendant row without ever running their blob cleanup, orphaning
  -- MinIO objects. Postgres refusing the delete while children still reference this row is the
  -- intended safety net that forces bottom-up (children-before-parent) deletion order.
  parent_folder_id   uuid references folders(id), -- null = root-level
  materialized_path  text not null, -- denormalized id-path, e.g. '/root-id/child-id/'; NOT the human-readable path
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  constraint folders_name_not_blank check (length(btrim(name)) > 0),
  -- REQUIREMENTS.md §5.2: 255 bytes UTF-8 per name. The 4096-byte full-path limit is an
  -- application-layer check computed by walking materialized_path (DESIGN.md §3.3) — it is
  -- not representable as a single-row constraint here.
  constraint folders_name_byte_length check (octet_length(name) <= 255),
  -- Minimal DB-level backstop against the trivial self-parent case. Full ancestor-chain
  -- cycle prevention (a folder moved several levels into its own descendant tree) requires
  -- a recursive walk plus pg_advisory_xact_lock ordering and is enforced in the application
  -- transaction, per APPLICATION_DESIGN.md §5.1 — not achievable in a single-row CHECK/trigger.
  constraint folders_not_own_parent check (id is distinct from parent_folder_id)
);

comment on table folders is
  'name must be stored NFC-normalized and trimmed by the application before every write (DESIGN.md §3.3) — this constraint layer does not normalize on its own.';
comment on column folders.materialized_path is
  'Rewritten for the entire subtree, in the same transaction as any move (DESIGN.md §3.3).';

create trigger trg_folders_guard_owner_id_change
  before update on folders
  for each row
  execute function files_folders_guard_owner_id_change();

create trigger trg_folders_touch_updated_at
  before update on folders
  for each row
  execute function touch_updated_at();

-- Unique sibling names among live folders (DESIGN.md §3.3: "UNIQUE(parent_folder_id, name)
-- WHERE deleted_at IS NULL"). Implementation note: parent_folder_id is NULL for every
-- root-level folder regardless of owner, and standard UNIQUE semantics treat NULL as
-- distinct from NULL — so the literal two-column index would not actually enforce
-- root-level sibling uniqueness at all (not even within one owner's own root). owner_id is
-- added and NULLS NOT DISTINCT is used so the constraint holds correctly at the root too;
-- this is a no-op scoping change for non-root rows, since parent_folder_id there is already
-- a single folder id that itself only ever belongs to one owner.
create unique index uq_folders_sibling_name
  on folders (owner_id, parent_folder_id, name)
  nulls not distinct
  where deleted_at is null;

create index idx_folders_parent_folder_id on folders(parent_folder_id);
create index idx_folders_materialized_path on folders(materialized_path text_pattern_ops);
create index idx_folders_owner_id on folders(owner_id);

-- Partial indexes for the common "exclude trashed items" case (DESIGN.md §5.4).
create index idx_folders_live on folders(owner_id) where deleted_at is null;

-- Trash-listing pagination (owner-scoped) and the 30-day scheduled purge scan (cross-owner).
create index idx_folders_trash_by_owner on folders(owner_id, deleted_at) where deleted_at is not null;
create index idx_folders_trash_scan on folders(deleted_at) where deleted_at is not null;

-- -----------------------------------------------------------------------------
-- FILES  (DESIGN.md §3.4)
-- -----------------------------------------------------------------------------
create table files (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  owner_id           uuid not null references users(id),
  -- Same deliberate no-ON-DELETE-action reasoning as folders.parent_folder_id above: a folder
  -- purge must not be able to cascade-delete a file row before DELETION_QUEUE has cleaned up
  -- its blob (0004).
  folder_id          uuid references folders(id), -- null = user's root
  size_bytes         bigint not null default 0,
  mime_type          text not null,
  checksum           text, -- SHA-256; unused today, a stepping stone for future dedup (out of scope)
  storage_key        text not null unique, -- non-guessable; only the `storage` module may construct/dereference this
  upload_status      upload_status not null default 'pending',
  thumbnail_status   thumbnail_status not null default 'none',
  thumbnail_key      text, -- non-guessable, same bucket-policy requirement as storage_key
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  constraint files_name_not_blank check (length(btrim(name)) > 0),
  constraint files_name_byte_length check (octet_length(name) <= 255),
  constraint files_size_bytes_non_negative check (size_bytes >= 0)
);

comment on column files.name is
  'Same NFC-normalize-and-trim-before-write requirement as folders.name (DESIGN.md §3.4).';
comment on column files.storage_key is
  'Must be non-guessable (random UUID / content-hash derived), never {folder_id}/{filename} (DESIGN.md §3.4).';

create trigger trg_files_guard_owner_id_change
  before update on files
  for each row
  execute function files_folders_guard_owner_id_change();

create trigger trg_files_touch_updated_at
  before update on files
  for each row
  execute function touch_updated_at();

-- Same root-level NULL-uniqueness fix as folders, same reasoning.
create unique index uq_files_sibling_name
  on files (owner_id, folder_id, name)
  nulls not distinct
  where deleted_at is null;

create index idx_files_folder_id on files(folder_id);
create index idx_files_owner_id on files(owner_id);
create index idx_files_live on files(owner_id) where deleted_at is null;

create index idx_files_trash_by_owner on files(owner_id, deleted_at) where deleted_at is not null;
create index idx_files_trash_scan on files(deleted_at) where deleted_at is not null;

-- -----------------------------------------------------------------------------
-- UPLOAD_SESSIONS  (DESIGN.md §3.5)
-- -----------------------------------------------------------------------------
create table upload_sessions (
  id                 uuid primary key default gen_random_uuid(),
  file_id            uuid references files(id) on delete cascade, -- nullable: the FILES row may not exist yet. Cascades so the DELETION_QUEUE worker's later "purge the database row" step (0004) is never blocked by a completed upload session still pointing at it
  user_id            uuid not null references users(id) on delete cascade, -- without cascade, a lingering row (even for a completed/aborted session) blocks account deletion
  -- Unlike files.folder_id/folders.parent_folder_id above, this reference carries no blob-
  -- cleanup obligation of its own (an upload_sessions row has no MinIO object tied to it
  -- directly — its multipart upload_id belongs to MinIO, not this column) — ON DELETE SET NULL
  -- so a folder purge is never blocked by a stale/completed session that merely once targeted
  -- it. A still-in-flight session should already have been aborted by the concurrent-mutation
  -- guard (REQUIREMENTS.md §5.3) before the folder could reach physical deletion; this is a
  -- backstop for the case where that ordering assumption doesn't hold.
  target_folder_id   uuid references folders(id) on delete set null, -- null = uploading to root, same convention as files.folder_id
  target_name        text not null,
  minio_upload_id    text not null,
  total_parts        integer not null,
  status             upload_session_status not null default 'pending',
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),

  constraint upload_sessions_total_parts_positive check (total_parts > 0)
);

comment on table upload_sessions is
  'target_folder_id/target_name exist so finalization/part-completion can re-verify the destination is still valid (REQUIREMENTS.md §5.3 concurrent-mutation guard).';

-- Per-part completion tracking as a child table (DESIGN.md §3.5), not a bare counter — lets a
-- resumed upload correctly skip only the parts truly already stored.
create table upload_session_parts (
  upload_session_id  uuid not null references upload_sessions(id) on delete cascade,
  part_number        integer not null,
  size_bytes         bigint not null, -- needed to credit storage_used_bytes back on abort
  completed_at       timestamptz not null default now(),

  primary key (upload_session_id, part_number),
  constraint upload_session_parts_size_bytes_non_negative check (size_bytes >= 0)
);

create index idx_upload_sessions_user_id on upload_sessions(user_id);
create index idx_upload_sessions_expiry_scan
  on upload_sessions(expires_at)
  where status = 'pending';
