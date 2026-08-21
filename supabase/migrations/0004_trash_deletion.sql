-- =============================================================================
-- 0004_trash_deletion.sql
-- Subcomponent 3 (IMPLEMENTATION_PHASES.md): DELETION_QUEUE
-- Source: DESIGN.md v7 §3.10, §5.2
-- (deleted_at columns and their indexes already exist on FOLDERS/FILES — 0002)
-- =============================================================================

create type deletion_queue_status as enum ('pending', 'processing', 'done', 'failed');

-- -----------------------------------------------------------------------------
-- DELETION_QUEUE  (DESIGN.md §3.10)
-- -----------------------------------------------------------------------------
-- A durable work queue decoupling blob deletion from DB-row deletion, so a crash between the
-- two never leaves an orphaned blob or a dangling row (DESIGN.md §3.10, Pass 1).
create table deletion_queue (
  id             uuid primary key default gen_random_uuid(),
  item_type      item_type not null,
  item_id        uuid not null,
  storage_key    text,
  thumbnail_key  text,
  owner_id       uuid references users(id) on delete set null, -- nullable: an account can be deleted while its own item is still mid-purge; the worker must skip the quota credit-back step when owner_id is null by the time it processes the row
  size_bytes     bigint not null default 0, -- always 0 for a folder's own row (folders hold no blob)
  status         deletion_queue_status not null default 'pending',
  attempts       integer not null default 0,
  enqueued_at    timestamptz not null default now(),
  processed_at   timestamptz,

  constraint deletion_queue_size_bytes_non_negative check (size_bytes >= 0),
  constraint deletion_queue_attempts_non_negative check (attempts >= 0)
);

comment on table deletion_queue is
  'Worker order: delete the blob from the object store, purge the DB row, cascade-clean
   PERMISSIONS/SHARE_LINKS/ACTIVITY_LOG/FAVORITES/ITEM_TAGS references (polymorphic, no real
   FK, so nothing else does this automatically), then atomically credit size_bytes back onto
   owner_id.storage_used_bytes in the same transaction as marking the row done (DESIGN.md
   §3.10). THUMBNAIL_QUEUE is deliberately NOT part of this manual cascade — it has a real
   file_id FK with ON DELETE CASCADE (0006) and is cleaned up by Postgres automatically.
   A folder purge must enumerate every descendant file individually with its own queue row
   (not just one row for the folder itself), or descendant blobs are permanently orphaned.';

-- Idempotent-enqueue guard (DESIGN.md §3.10/§5.2, Pass 5): prevents the 30-day scheduled purge
-- job and an explicit "delete now" action from both successfully enqueueing the same item.
-- A second concurrent enqueue attempt should be handled as ON CONFLICT DO NOTHING.
create unique index uq_deletion_queue_item_in_flight
  on deletion_queue (item_id)
  where status in ('pending', 'processing');

-- Worker polling.
create index idx_deletion_queue_status on deletion_queue(status);
