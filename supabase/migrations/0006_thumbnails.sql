-- =============================================================================
-- 0006_thumbnails.sql
-- Subcomponent 5 (IMPLEMENTATION_PHASES.md): THUMBNAIL_QUEUE
-- Source: DESIGN.md v7 §3.13
-- (files.thumbnail_status / files.thumbnail_key already exist — 0002)
-- =============================================================================

create type thumbnail_queue_status as enum ('pending', 'processing', 'done', 'failed');

create table thumbnail_queue (
  id            uuid primary key default gen_random_uuid(),
  file_id       uuid not null references files(id) on delete cascade,
  status        thumbnail_queue_status not null default 'pending',
  attempts      integer not null default 0,
  enqueued_at   timestamptz not null default now(),
  processed_at  timestamptz,

  constraint thumbnail_queue_attempts_non_negative check (attempts >= 0)
);

comment on table thumbnail_queue is
  'file_id ON DELETE CASCADE (DESIGN.md §3.13): when DELETION_QUEUE''s worker purges a FILES
   row, the corresponding queue row vanishes automatically — no manual cascade step needed
   here, unlike PERMISSIONS/SHARE_LINKS/ACTIVITY_LOG/FAVORITES/ITEM_TAGS (0004). Only enqueued
   for image/*, video/*, application/pdf mime types, triggered post-upload-completion, never
   blocking the upload response (REQUIREMENTS.md §5.9). The worker must re-check
   files.deleted_at IS NULL immediately before writing the generated blob — not only at claim
   time — to close the race where a file is trashed while its thumbnail job is still
   in-flight (DESIGN.md §3.13, Pass 4).';

-- Concurrency guard (DESIGN.md §3.13, Pass 4): a second enqueue attempt while one is already
-- pending is a no-op rather than a duplicate queue row / duplicated worker effort.
create unique index uq_thumbnail_queue_file_pending
  on thumbnail_queue (file_id)
  where status = 'pending';

-- Worker polling, same pattern as DELETION_QUEUE.
create index idx_thumbnail_queue_status_enqueued on thumbnail_queue(status, enqueued_at);
