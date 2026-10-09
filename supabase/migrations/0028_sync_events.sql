-- =============================================================================
-- 0028_sync_events.sql
-- A change feed for sync clients (GET /api/v1/sync/changes).
--
-- Every create / content update / move-or-rename / trash / restore / purge of a file or folder
-- writes one SYNC_EVENTS row, from triggers, so no write path can forget to. Purges are recorded
-- too — the item rows are hard-deleted, so without this a client could never learn that something
-- it had synced is gone.
--
-- ORDERING (why `seq` is not just a bigserial)
-- A client resumes from "the last seq I saw". A sequence value is taken at INSERT time, but rows
-- become visible at COMMIT time, and those orders differ: transaction A takes seq 5, B takes 6
-- and commits first, a client reads up to 6, then A commits — and seq 5 is never delivered. Taking
-- txids into account doesn't fix it either (a txid is assigned at a transaction's first write, not
-- at insert). So events are inserted with seq NULL, and sequence_sync_events() assigns seqs to
-- already-committed rows only, in one transaction serialized by an advisory lock. Anything that
-- commits later is necessarily sequenced later, with a higher seq — so a cursor never skips an
-- event. The /sync endpoints call it before reading; the workers also call it periodically.
--
-- PATHS
-- `path` / `prev_path` are the materialized_path of the item's parent folder after / before the
-- change ('/' for the user's root). A sync root R's subtree is every event whose path contains
-- '/R/'. Taken from the parent row, not the item's own materialized_path, because a folder
-- restore changes parent_folder_id before it rewrites materialized_path.
-- Descendant path rewrites during a folder move (folder-service.ts) change neither parent nor
-- name, so they write no events: one `move` on the moved folder describes the whole move.
-- =============================================================================

create type sync_event_kind as enum ('create', 'update', 'move', 'trash', 'restore', 'purge');

create table sync_events (
  id              bigserial primary key,   -- insertion order only; never exposed
  seq             bigint unique,           -- delivery order; null until sequenced
  item_type       item_type not null,
  item_id         uuid not null,
  kind            sync_event_kind not null,
  name            text not null,
  parent_id       uuid,                    -- folder id, null = user's root
  prev_parent_id  uuid,
  path            text,                    -- parent's materialized_path after the change
  prev_path       text,                    -- parent's materialized_path before the change
  occurred_at     timestamptz not null default now()
);

create index idx_sync_events_unsequenced on sync_events(id) where seq is null;
create index idx_sync_events_occurred_at on sync_events(occurred_at);
create index idx_sync_events_item on sync_events(item_id);

-- Singleton bookkeeping for the sequencer and retention.
create table sync_state (
  id                  boolean primary key default true check (id),
  last_seq            bigint not null default 0,
  -- Every event with seq <= this has been pruned; a cursor below it can't be resumed (410).
  pruned_through_seq  bigint not null default 0
);
insert into sync_state default values;

alter table sync_events enable row level security;
alter table sync_state enable row level security;

-- -----------------------------------------------------------------------------
-- Sequencer
-- -----------------------------------------------------------------------------
create or replace function sequence_sync_events()
returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_last bigint;
  v_count bigint;
begin
  -- Serializes sequencers; held to commit, so a later sequencer always sees this one's seqs.
  perform pg_advisory_xact_lock(hashtext('sync_events_sequencer'));
  select last_seq into v_last from sync_state where id = true for update;

  with pending as (
    select id, row_number() over (order by id) as rn
    from sync_events
    where seq is null
  )
  update sync_events e
  set seq = v_last + pending.rn
  from pending
  where e.id = pending.id;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    update sync_state set last_seq = v_last + v_count where id = true;
  end if;
  return v_last + v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create or replace function sync_parent_path(p_folder_id uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case when p_folder_id is null then '/'
              else (select materialized_path from folders where id = p_folder_id) end
$$;

create or replace function files_write_sync_events()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into sync_events (item_type, item_id, kind, name, parent_id, path)
    values ('file', new.id, 'create', new.name, new.folder_id, sync_parent_path(new.folder_id));
    return null;
  end if;

  if tg_op = 'DELETE' then
    insert into sync_events (item_type, item_id, kind, name, prev_parent_id, prev_path)
    values ('file', old.id, 'purge', old.name, old.folder_id, sync_parent_path(old.folder_id));
    return null;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    insert into sync_events (item_type, item_id, kind, name, parent_id, prev_parent_id, path, prev_path)
    values ('file', new.id, 'trash', new.name, new.folder_id, old.folder_id,
            sync_parent_path(new.folder_id), sync_parent_path(old.folder_id));
    return null;
  end if;

  if old.deleted_at is not null and new.deleted_at is null then
    insert into sync_events (item_type, item_id, kind, name, parent_id, prev_parent_id, path, prev_path)
    values ('file', new.id, 'restore', new.name, new.folder_id, old.folder_id,
            sync_parent_path(new.folder_id), sync_parent_path(old.folder_id));
    return null;
  end if;

  if new.folder_id is distinct from old.folder_id or new.name is distinct from old.name then
    insert into sync_events (item_type, item_id, kind, name, parent_id, prev_parent_id, path, prev_path)
    values ('file', new.id, 'move', new.name, new.folder_id, old.folder_id,
            sync_parent_path(new.folder_id), sync_parent_path(old.folder_id));
  end if;

  if new.storage_key is distinct from old.storage_key
     or new.size_bytes is distinct from old.size_bytes
     or new.checksum is distinct from old.checksum then
    insert into sync_events (item_type, item_id, kind, name, parent_id, path)
    values ('file', new.id, 'update', new.name, new.folder_id, sync_parent_path(new.folder_id));
  end if;

  return null;
end;
$$;

create or replace function folders_write_sync_events()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into sync_events (item_type, item_id, kind, name, parent_id, path)
    values ('folder', new.id, 'create', new.name, new.parent_folder_id, sync_parent_path(new.parent_folder_id));
    return null;
  end if;

  if tg_op = 'DELETE' then
    insert into sync_events (item_type, item_id, kind, name, prev_parent_id, prev_path)
    values ('folder', old.id, 'purge', old.name, old.parent_folder_id, sync_parent_path(old.parent_folder_id));
    return null;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    insert into sync_events (item_type, item_id, kind, name, parent_id, prev_parent_id, path, prev_path)
    values ('folder', new.id, 'trash', new.name, new.parent_folder_id, old.parent_folder_id,
            sync_parent_path(new.parent_folder_id), sync_parent_path(old.parent_folder_id));
    return null;
  end if;

  if old.deleted_at is not null and new.deleted_at is null then
    insert into sync_events (item_type, item_id, kind, name, parent_id, prev_parent_id, path, prev_path)
    values ('folder', new.id, 'restore', new.name, new.parent_folder_id, old.parent_folder_id,
            sync_parent_path(new.parent_folder_id), sync_parent_path(old.parent_folder_id));
    return null;
  end if;

  if new.parent_folder_id is distinct from old.parent_folder_id or new.name is distinct from old.name then
    insert into sync_events (item_type, item_id, kind, name, parent_id, prev_parent_id, path, prev_path)
    values ('folder', new.id, 'move', new.name, new.parent_folder_id, old.parent_folder_id,
            sync_parent_path(new.parent_folder_id), sync_parent_path(old.parent_folder_id));
  end if;

  return null;
end;
$$;

create trigger trg_files_sync_events
  after insert or update or delete on files
  for each row
  execute function files_write_sync_events();

create trigger trg_folders_sync_events
  after insert or update or delete on folders
  for each row
  execute function folders_write_sync_events();
