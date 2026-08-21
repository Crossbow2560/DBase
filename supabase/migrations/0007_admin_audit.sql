-- =============================================================================
-- 0007_admin_audit.sql
-- Subcomponent 6 (IMPLEMENTATION_PHASES.md): ACTIVITY_LOG
-- Source: DESIGN.md v7 §3.9, §4
-- Admin's "role='admin' bypass" itself has no schema footprint (DESIGN.md §4.2) — it is a
-- pure application-layer short-circuit inside access.checkPermission(), not a database object.
-- =============================================================================

-- Closed set (DESIGN.md §3.9): any new user-facing action must extend this enum explicitly
-- rather than relying on `metadata` alone to carry it.
create type activity_action as enum (
  'upload', 'download', 'rename', 'move', 'delete', 'restore', 'purge',
  'share', 'unshare', 'create_share_link', 'revoke_share_link',
  'favorite', 'unfavorite', 'tag', 'untag',
  'quota_change', 'permission_change', 'ownership_transfer',
  'view',
  'account_deactivate', 'account_reactivate', 'account_delete'
);

-- -----------------------------------------------------------------------------
-- ACTIVITY_LOG  (DESIGN.md §3.9)
-- -----------------------------------------------------------------------------
create table activity_log (
  id               uuid primary key default gen_random_uuid(),
  actor_id         uuid, -- deliberately NOT a foreign key — see the note below
  subject_user_id  uuid, -- deliberately NOT a foreign key — see the note below; equal to actor_id for ordinary self-service actions
  item_type        item_type,
  item_id          uuid,
  action           activity_action not null,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

comment on table activity_log is
  'Append-only. actor_id/subject_user_id split (DESIGN.md §3.9, Pass 3) so an admin action on
   another user''s data is attributable to both the admin (actor) and the affected user
   (subject) distinctly, rather than losing one side of that record. actor_id/subject_user_id
   are deliberately plain uuid columns with NO foreign key at all (DESIGN.md §7 item #6, step
   (f)): these rows must survive the referenced user''s permanent deletion, and a real FK
   constraint cannot express "tolerate a dangling reference" — by definition a FK either blocks
   the deletion (the default/NO ACTION behavior) or nulls/cascades the value on delete, and
   DESIGN.md explicitly requires neither: the row must survive AND the historical id should not
   be silently erased. The application must additionally snapshot a denormalized display-name
   into `metadata` at write time so historical entries stay human-readable once the referenced
   user row is actually gone, since a plain id can no longer be joined against USERS at that
   point. A `view` row is written once per
   admin browsing session of another user''s content, not once per file glanced at within it
   (DESIGN.md §3.9, Pass 6).';

create index idx_activity_log_item on activity_log(item_type, item_id);
create index idx_activity_log_actor on activity_log(actor_id, created_at);
create index idx_activity_log_subject on activity_log(subject_user_id, created_at);
