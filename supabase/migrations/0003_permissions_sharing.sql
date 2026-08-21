-- =============================================================================
-- 0003_permissions_sharing.sql
-- Subcomponent 2 (IMPLEMENTATION_PHASES.md): PERMISSIONS, EFFECTIVE_PERMISSIONS, SHARE_LINKS
-- Source: DESIGN.md v7 §3.6, §3.7, §3.8
-- =============================================================================

create type item_type as enum ('file', 'folder');
create type permission_role as enum ('owner', 'editor', 'viewer');
create type share_link_role as enum ('editor', 'viewer'); -- deliberately excludes 'owner' (DESIGN.md §3.8)

-- -----------------------------------------------------------------------------
-- PERMISSIONS  (DESIGN.md §3.6)
-- -----------------------------------------------------------------------------
-- item_type/item_id: the polymorphic (file|folder) reference pattern (DESIGN.md §5.1).
-- No real FK is possible against "one of two tables" — referential integrity here is an
-- application/DELETION_QUEUE-worker responsibility, not a database one.
create table permissions (
  id           uuid primary key default gen_random_uuid(),
  item_type    item_type not null,
  item_id      uuid not null,
  user_id      uuid not null references users(id) on delete cascade,
  role         permission_role not null,
  -- Deliberately NOT a foreign key (see the comment below) — kept as a plain NOT NULL uuid.
  granted_by   uuid not null,
  created_at   timestamptz not null default now(),

  constraint uq_permissions_item_user unique (item_type, item_id, user_id)
);

comment on column permissions.user_id is
  'ON DELETE CASCADE (DESIGN.md §3.6, Pass 6): a viewer/editor grant to a since-deleted user is
   meaningless. This cascade must fire only after reassign_all_owned_items() has already run
   (0008) — enforced procedurally by the account-deletion procedure''s step ordering, not by
   this FK alone, since a hard FK cannot express "run me only after that other operation."';
comment on column permissions.granted_by is
  'Application-layer write path must verify granted_by currently holds editor-or-above on the
   target item via EFFECTIVE_PERMISSIONS before this row is written or updated (DESIGN.md §3.6),
   with exactly three exemptions: the initial self-granted owner row at item creation, and
   transfer_ownership()/reassign_all_owned_items() (0008) when invoked by an admin or the
   account-deletion process. Not database-enforced — depends on the acting user''s own resolved
   access level, which a static constraint cannot express. Deliberately has NO foreign key:
   DESIGN.md §3.6 states "granted_by is never null" as a permanent audit record of who granted
   access, and that record must survive the granter''s own account being permanently deleted
   later (e.g. user A shares a file with user B, recording granted_by=A; A''s account is later
   deleted, but B''s grant row — keyed on B as user_id — is untouched by the user_id cascade
   above and must not block A''s deletion). A real FK here (even ON DELETE SET NULL) would
   either block that deletion or silently null out the "never null" audit value; a plain
   unenforced column, matching the same pattern used for ACTIVITY_LOG''s actor_id/subject_user_id
   (0007), is the only way to keep the value NOT NULL, retain it as a historical record, and not
   block deletion.';

-- Exactly one owner per item at any time (DESIGN.md §3.6), deferred to transaction commit so
-- transfer_ownership() (0008) can demote the old owner and promote the new one as two writes
-- inside one transaction without the constraint seeing a transient zero-or-two-owner state.
--
-- Implementation note: DESIGN.md specifies this as a *partial* unique index (`WHERE role =
-- 'owner'`) declared DEFERRABLE. Postgres does not allow that combination — `ALTER TABLE ...
-- ADD CONSTRAINT ... UNIQUE USING INDEX` explicitly rejects a partial index ("cannot create a
-- unique constraint using such an index" — partial indexes and expression indexes are both
-- disallowed as constraint backers), so the literal partial-index-plus-deferrable design is not
-- valid SQL. Fix: a generated, STORED column that is NULL for every non-owner row and equals
-- item_id for owner rows. A plain (non-partial) unique index on (item_type, item_id,
-- owner_scope) is then equivalent to the intended partial constraint, because standard UNIQUE
-- semantics never consider NULL values to collide — every non-owner row has owner_scope = NULL
-- and is invisible to the constraint, exactly as the partial index intended — while still being
-- a plain column-only index eligible for ADD CONSTRAINT ... UNIQUE USING INDEX ... DEFERRABLE.
alter table permissions
  add column owner_scope uuid
  generated always as (case when role = 'owner' then item_id else null end) stored;

create unique index uq_permissions_one_owner_per_item
  on permissions (item_type, item_id, owner_scope);

alter table permissions
  add constraint uq_permissions_one_owner_per_item_deferrable
  unique using index uq_permissions_one_owner_per_item
  deferrable initially deferred;

comment on constraint uq_permissions_one_owner_per_item_deferrable on permissions is
  'DEFERRABLE INITIALLY DEFERRED (DESIGN.md §3.6, Pass 3). No code path — including admin
   actions — may UPDATE/DELETE/INSERT to change ownership except through transfer_ownership()
   / reassign_all_owned_items() (0008).';

create index idx_permissions_item on permissions(item_type, item_id);
create index idx_permissions_user_id on permissions(user_id);

-- -----------------------------------------------------------------------------
-- EFFECTIVE_PERMISSIONS  (DESIGN.md §3.7) — a cache, never the source of truth.
-- -----------------------------------------------------------------------------
create table effective_permissions (
  item_type         item_type not null,
  item_id           uuid not null,
  user_id           uuid not null references users(id) on delete cascade,
  role              permission_role not null,
  source_permission_id uuid references permissions(id) on delete set null, -- without this, deleting the PERMISSIONS row on an ordinary revoke would be blocked by any stale cache row still pointing at it
  recomputed_at     timestamptz not null default now(),

  primary key (item_type, item_id, user_id)
);

comment on table effective_permissions is
  'Read-path performance optimization ONLY (DESIGN.md §3.7, Pass 2). Every actual
   authorization decision must be able to fall back to a synchronous, on-demand
   recomputation from PERMISSIONS if this cache is missing, stale, or the call site is
   security-sensitive — application-layer rule (access.checkPermission), not enforceable here.
   Rebuilt asynchronously by an application-level worker on every share, unshare, move, and
   transfer_ownership() event; a rebuild job must discard itself (no-op) if its carried event
   timestamp is older than this row''s current recomputed_at (last-write-wins by event time,
   not job-completion time — DESIGN.md §3.7 Pass 6).';

-- The composite primary key above already serves as this table's own lookup index (DESIGN.md §5.4).

-- -----------------------------------------------------------------------------
-- SHARE_LINKS  (DESIGN.md §3.8)
-- -----------------------------------------------------------------------------
create table share_links (
  id                              uuid primary key default gen_random_uuid(),
  item_type                       item_type not null,
  item_id                         uuid not null,
  token                           text not null unique,
  role                            share_link_role not null,
  password_hash                   text,
  failed_password_attempts        integer not null default 0,
  failed_attempts_window_started_at timestamptz,
  expires_at                      timestamptz,
  created_by                      uuid not null references users(id) on delete cascade,
  created_at                      timestamptz not null default now(),

  constraint share_links_failed_attempts_non_negative check (failed_password_attempts >= 0)
);

comment on column share_links.created_by is
  'ON DELETE CASCADE (DESIGN.md §3.8): directly satisfies REQUIREMENTS.md''s "permanently
   invalidates every public share link that user created" rule at the database level. A link''s
   availability tracks its own specific creator, not the item''s owner (deliberate, confirmed
   policy — REQUIREMENTS.md §5.5).';
comment on table share_links is
  'Every access attempt must join to users on created_by and check is_active = true in the same
   access-check path used for authenticated permission checks (DESIGN.md §3.8) — a deactivated
   creator''s links are denied. This is a pure application-layer rule with no database-level
   backstop (DESIGN.md §4.3), same accepted-risk category as the admin bypass. Password-attempt
   throttling (10 failures / 15-minute window, keyed on the token) is implemented against
   failed_password_attempts / failed_attempts_window_started_at at the application layer
   (DESIGN.md §3.8) — a failed attempt outside the current window resets both fields rather
   than accumulating indefinitely.';

create index idx_share_links_item on share_links(item_type, item_id);
-- share_links.token already backed by its UNIQUE constraint (DESIGN.md §5.4: looked up on
-- every public link access).
