-- =============================================================================
-- 0008_account_lifecycle.sql
-- Subcomponent 7 (IMPLEMENTATION_PHASES.md): deactivation, deletion cascade, bulk reassignment
-- Source: DESIGN.md v7 §3.6 (transfer_ownership), §7 items #1 and #6; REQUIREMENTS.md §4, §5.1.1
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Last-admin-standing guard (REQUIREMENTS.md §4)
-- -----------------------------------------------------------------------------
-- Rejects any demote/deactivate/delete that would leave zero admin accounts. Does not apply
-- to the very first admin's creation (this trigger only fires on UPDATE/DELETE, never INSERT),
-- which is the bootstrap case where zero admins is the expected starting state.
create or replace function users_enforce_last_admin_standing()
returns trigger
language plpgsql
as $$
declare
  v_remaining_admins integer;
begin
  if tg_op = 'DELETE' then
    if old.role = 'admin' and old.is_active then
      select count(*) into v_remaining_admins
      from users where role = 'admin' and is_active and id <> old.id;
      if v_remaining_admins = 0 then
        raise exception 'LAST_ADMIN: cannot delete the last remaining active admin account';
      end if;
    end if;
    return old;
  end if;

  if old.role = 'admin' and old.is_active
     and (new.role <> 'admin' or new.is_active = false) then
    select count(*) into v_remaining_admins
    from users where role = 'admin' and is_active and id <> old.id;
    if v_remaining_admins = 0 then
      raise exception 'LAST_ADMIN: cannot demote or deactivate the last remaining active admin account';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_users_last_admin_standing
  before update or delete on users
  for each row
  execute function users_enforce_last_admin_standing();

-- -----------------------------------------------------------------------------
-- transfer_ownership()  (DESIGN.md §3.6)
-- -----------------------------------------------------------------------------
-- The ONLY code path permitted to change a PERMISSIONS 'owner' row. Kept as a single
-- PL/pgSQL function (per APPLICATION_DESIGN.md §5.4.1) specifically so the demote/promote
-- pair can never have a third statement inserted between them within the same transaction —
-- something a purely application-level "two calls in a $transaction block" pattern cannot
-- guarantee. Relies on uq_permissions_one_owner_per_item_deferrable (0003) being checked at
-- commit, not per-statement.
--
-- p_bypass_authority_check corresponds to DESIGN.md §3.6's granting-authority check
-- exemption #2 (admin action, or invoked internally by reassign_all_owned_items() below) —
-- it must never be settable from a client-reachable code path directly; only an admin
-- endpoint or the account-deletion procedure may set it true.
--
-- Design note (not specified by DESIGN.md, decided here): the prior owner is demoted to
-- 'editor' rather than losing all access, so a normal (non-account-deletion) ownership
-- transfer doesn't silently strip the previous owner's own ability to use the item. For the
-- account-deletion bulk-reassignment path this is moot, since the departing user's row is
-- cascade-deleted moments later anyway (PERMISSIONS.user_id ON DELETE CASCADE, 0003).
--
-- Design note (also decided here): for a FILE, this function moves size_bytes from the old
-- owner's storage_used_bytes to the new owner's, atomically, in the same transaction as the
-- ownership change. Without this, DELETION_QUEUE's later credit-back step (0004) would
-- decrement whoever owns the file AT PURGE TIME — the new owner — even though their balance
-- was never incremented for it, risking a negative storage_used_bytes and, more generally,
-- silently breaking quota accounting for every transferred/inherited file (most importantly
-- during account deletion's bulk reassignment, DESIGN.md §7 item #1). A FOLDER holds no bytes
-- of its own (DELETION_QUEUE.size_bytes is always 0 for a folder's row, 0004) — files inside a
-- transferred folder keep their own independent ownership and byte attribution unless
-- separately transferred, matching how reassign_all_owned_items() below already walks every
-- owned item individually rather than assuming a folder transfer cascades to its contents
-- (REQUIREMENTS.md §5.1.1 lists "every file and folder it owns" as separate reassignment
-- targets). The move is never blocked by the new owner's quota (see the bypass mechanism on
-- users_enforce_quota_on_increase, 0001).
create or replace function transfer_ownership(
  p_item_type        item_type,
  p_item_id          uuid,
  p_new_owner_id     uuid,
  p_acting_user_id   uuid,
  p_bypass_authority_check boolean default false
)
returns void
language plpgsql
as $$
declare
  v_current_owner_id uuid;
  v_size_bytes        bigint;
begin
  select user_id into v_current_owner_id
  from permissions
  where item_type = p_item_type and item_id = p_item_id and role = 'owner'
  for update;

  if v_current_owner_id is null then
    raise exception 'OWNER_NOT_FOUND: no owner row for % %', p_item_type, p_item_id;
  end if;

  if v_current_owner_id = p_new_owner_id then
    return; -- no-op: already the owner
  end if;

  if not p_bypass_authority_check and p_acting_user_id <> v_current_owner_id then
    raise exception 'INSUFFICIENT_PERMISSION: % may not transfer ownership of % %',
      p_acting_user_id, p_item_type, p_item_id;
  end if;

  update permissions
  set role = 'editor', granted_by = p_acting_user_id
  where item_type = p_item_type and item_id = p_item_id and user_id = v_current_owner_id;

  insert into permissions (item_type, item_id, user_id, role, granted_by)
  values (p_item_type, p_item_id, p_new_owner_id, 'owner', p_acting_user_id)
  on conflict (item_type, item_id, user_id)
  do update set role = 'owner', granted_by = excluded.granted_by;

  -- DESIGN.md keeps ownership represented twice: the PERMISSIONS 'owner' row updated above,
  -- AND a redundant owner_id column directly on FILES/FOLDERS (§3.3/§3.4) — used by every
  -- owner-scoped index in this schema (sibling-name uniqueness, trash-listing pagination,
  -- idx_files_owner_id/idx_folders_owner_id). DESIGN.md never states these two must be kept in
  -- sync, but leaving owner_id untouched here would silently desync it from the moment of the
  -- very first transfer, and would independently block account deletion later (files/folders
  -- .owner_id intentionally has no ON DELETE cascade, since it is supposed to always be valid
  -- once reassign_all_owned_items() has run — see 0002/0008). Both representations must be
  -- updated in the same transaction as the single source-of-truth operation.
  --
  -- The owner_id UPDATEs below are guarded by files_folders_guard_owner_id_change() (0002),
  -- which blocks any direct write to owner_id outside this function — 'dbase.
  -- allow_owner_id_change' must be set immediately around them, same transaction-local-flag
  -- pattern as the quota bypass below.
  perform set_config('dbase.allow_owner_id_change', 'true', true);

  if p_item_type = 'file' then
    -- updated_at is bumped automatically by trg_files_touch_updated_at (0002).
    update files set owner_id = p_new_owner_id
      where id = p_item_id
      returning size_bytes into v_size_bytes;

    perform set_config('dbase.allow_owner_id_change', 'false', true);

    if not found then
      -- A PERMISSIONS 'owner' row existed with no matching live FILES row — should be
      -- impossible given DELETION_QUEUE's cascade cleanup (0004), but fail loudly here rather
      -- than let v_size_bytes stay NULL and hit users.storage_used_bytes' NOT NULL constraint
      -- with a confusing low-level error below.
      raise exception 'FILE_NOT_FOUND: permissions row for file % has no matching files row', p_item_id;
    end if;

    -- Move the byte accounting to match the ownership change (see the design note above).
    -- Bypasses the quota-on-increase check for the new owner's side of the move; the flag is
    -- transaction-local (is_local = true) and explicitly reset immediately after, so nothing
    -- else in the same transaction is inadvertently exempted from quota enforcement.
    perform set_config('dbase.bypass_quota_check', 'true', true);

    update users set storage_used_bytes = storage_used_bytes - v_size_bytes
      where id = v_current_owner_id;
    update users set storage_used_bytes = storage_used_bytes + v_size_bytes
      where id = p_new_owner_id;

    perform set_config('dbase.bypass_quota_check', 'false', true);
  else
    -- Folders hold no bytes of their own — no storage_used_bytes movement needed.
    -- updated_at is bumped automatically by trg_folders_touch_updated_at (0002).
    update folders set owner_id = p_new_owner_id where id = p_item_id;

    perform set_config('dbase.allow_owner_id_change', 'false', true);
  end if;

  -- Caller (application layer) must still enqueue an EFFECTIVE_PERMISSIONS rebuild for this
  -- item (DESIGN.md §3.7, Pass 5) — the async rebuild queue is application-managed, not a
  -- database table this function writes to directly.
end;
$$;

-- -----------------------------------------------------------------------------
-- reassign_all_owned_items()  (DESIGN.md §7 item #1 — the bulk variant)
-- -----------------------------------------------------------------------------
-- Required as an atomic precondition of account deletion (REQUIREMENTS.md §5.1.1): every item
-- the departing user owns must be reassigned before the user row itself can be removed.
-- Always invoked with the authority-check bypassed (DESIGN.md §3.6's exemption #2) — the
-- calling application code is responsible for gating who may call this (admin, or the
-- account-deletion process acting on the departing user's own behalf).
create or replace function reassign_all_owned_items(
  p_from_user_id  uuid,
  p_to_user_id    uuid,
  p_acting_user_id uuid
)
returns void
language plpgsql
as $$
declare
  r record;
begin
  for r in
    select item_type, item_id
    from permissions
    where role = 'owner' and user_id = p_from_user_id
  loop
    perform transfer_ownership(r.item_type, r.item_id, p_to_user_id, p_acting_user_id, true);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- delete_account()  (DESIGN.md §7 item #6 — the full account-deletion procedure)
-- -----------------------------------------------------------------------------
-- Ordering per APPLICATION_DESIGN.md §5.4.3 / DESIGN.md §7 item #6:
--   (1) bulk ownership reassignment — must complete first, since it is the precondition the
--       granting-authority check and the PERMISSIONS-as-grantee cascade both depend on.
--   (2) session invalidation — marks sessions revoked explicitly before the user row is
--       removed, for parity with the deactivation flow; sessions.user_id does also carry an
--       ON DELETE CASCADE (0001) as a backstop so a lingering row can never block step (3).
--   (3) DELETE FROM USERS — triggers, automatically, at the database level: SHARE_LINKS
--       (created_by cascade), PERMISSIONS-as-grantee (user_id cascade), TAGS→ITEM_TAGS
--       (cascade), FAVORITES (user_id cascade), SESSIONS (user_id cascade), UPLOAD_SESSIONS
--       (user_id cascade). ACTIVITY_LOG rows are NOT touched (no FK at all on
--       actor_id/subject_user_id — DESIGN.md §7 item #6(f)) and must survive.
--
-- This function does not itself re-delete SHARE_LINKS/PERMISSIONS/TAGS/FAVORITES rows — those
-- are database-level ON DELETE CASCADE side effects of the single DELETE FROM USERS statement
-- below, per DESIGN.md's explicit instruction not to duplicate cascade behavior in application
-- code. The caller is responsible for the one step this function cannot perform: enqueuing an
-- EFFECTIVE_PERMISSIONS rebuild for every item that just had a PERMISSIONS-as-grantee row
-- cascade-deleted (the cascade only removes the source-of-truth row, not the derived cache).
create or replace function delete_account(
  p_user_id             uuid,
  p_default_owner_id    uuid, -- the designated system admin account (self-service), or an
                               -- admin-chosen replacement owner
  p_acting_user_id      uuid  -- the admin performing the deletion, or p_user_id itself for
                               -- self-service
)
returns void
language plpgsql
as $$
begin
  -- (1) Pre-step (a): bulk ownership reassignment.
  perform reassign_all_owned_items(p_user_id, p_default_owner_id, p_acting_user_id);

  -- (2) Pre-step (e): invalidate every active session before the user row is removed.
  update sessions
  set revoked_at = now()
  where user_id = p_user_id and revoked_at is null;

  -- (3) The single statement whose ON DELETE CASCADE side effects perform steps (b), (c),
  --     (d), (g). ACTIVITY_LOG (f) is untouched by design.
  delete from users where id = p_user_id;
end;
$$;

comment on function delete_account(uuid, uuid, uuid) is
  'Both self-service (DELETE /api/v1/users/me) and admin-initiated deletion call this same
   function — self-service always passes the designated system-admin account as
   p_default_owner_id (REQUIREMENTS.md §5.1.1: a departing user cannot choose who inherits
   their files); an admin path may instead pass a specific chosen replacement owner.';
