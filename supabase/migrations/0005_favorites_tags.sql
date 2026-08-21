-- =============================================================================
-- 0005_favorites_tags.sql
-- Subcomponent 4 (IMPLEMENTATION_PHASES.md): FAVORITES, TAGS, ITEM_TAGS
-- Source: DESIGN.md v7 §3.11, §3.12
-- =============================================================================

-- -----------------------------------------------------------------------------
-- FAVORITES  (DESIGN.md §3.11)
-- -----------------------------------------------------------------------------
create table favorites (
  user_id      uuid not null references users(id) on delete cascade,
  item_type    item_type not null,
  item_id      uuid not null,
  created_at   timestamptz not null default now(),

  primary key (user_id, item_type, item_id)
);

comment on table favorites is
  'user_id ON DELETE CASCADE fires only on permanent account deletion, never on deactivation
   (REQUIREMENTS.md §5.7 — a favorite must survive a reversible deactivation of the SHARING
   user''s account; that is a separate concern, handled by lazy prune-on-read below, not this
   FK). Visibility is resolved lazily: rendering the favorites list re-checks deleted_at IS
   NULL and an EFFECTIVE_PERMISSIONS access check per row, and a row that fails is deleted from
   FAVORITES at that point (application-layer lazy prune-on-read, DESIGN.md §3.11) — not
   eagerly invalidated by every permission-revocation code path. A favorite lost only because
   the sharing user''s account is deactivated (a reversible state) must be hidden, not deleted,
   from storage, so it reappears automatically on reactivation with no action from the
   favoriting user (REQUIREMENTS.md §5.7) — this distinction is enforced at the application
   layer inside the lazy-prune check, not expressible as a schema constraint.';

-- Secondary index required (DESIGN.md §3.11, Pass 4): item_type/item_id are the TRAILING
-- columns of the primary key, so the PK alone does not serve the DELETION_QUEUE reverse
-- lookup ("what favorited this item").
create index idx_favorites_item on favorites(item_type, item_id);

-- -----------------------------------------------------------------------------
-- TAGS  (DESIGN.md §3.12) — per-user scoped, confirmed by the system owner.
-- -----------------------------------------------------------------------------
create table tags (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references users(id) on delete cascade,
  name        text not null,
  color       text,
  created_at  timestamptz not null default now(),

  constraint uq_tags_owner_name unique (owner_id, name)
);

comment on table tags is
  'Cascade-deleted on user deletion (NOT reassigned, unlike PERMISSIONS ownership) — a tag has
   no independent existence and no stakeholders beyond its creator (DESIGN.md §3.12, Pass 4).
   Cascades further into ITEM_TAGS via that table''s own tag_id FK.';

create index idx_tags_owner_id on tags(owner_id);

-- -----------------------------------------------------------------------------
-- ITEM_TAGS  (DESIGN.md §3.12)
-- -----------------------------------------------------------------------------
create table item_tags (
  tag_id       uuid not null references tags(id) on delete cascade,
  item_type    item_type not null,
  item_id      uuid not null,
  created_at   timestamptz not null default now(),

  primary key (tag_id, item_type, item_id)
);

comment on table item_tags is
  'Two distinct application-layer write-path checks, not one (DESIGN.md §3.12): (1) the
   acting user must hold editor-or-above on the target item via EFFECTIVE_PERMISSIONS, and
   (2) tag_id must belong to a TAGS row owned by the acting user (Pass 6 fix — closes a gap
   where an editor could apply another user''s private tag_id to an item they can write to).
   Neither check is expressible as a plain FK/CHECK, since both depend on comparing against
   the acting user''s own identity at write time.';

-- Secondary index required, same reverse-lookup reasoning as FAVORITES.
create index idx_item_tags_item on item_tags(item_type, item_id);
-- "show all items with this tag"
create index idx_item_tags_tag_id on item_tags(tag_id);
