-- =============================================================================
-- 0022_preallocate_user_quotas.sql
-- Per-user quotas are now PRE-ALLOCATED out of system_settings.total_storage_limit_bytes:
-- SUM(users.storage_quota_bytes) may never exceed the system limit. Before this, 0015 only
-- capped SUM(storage_used_bytes), so an admin could hand a single account a 9000 GB quota on a
-- 500 GB system and registration kept handing out the default quota with no regard for how
-- much of the system was already promised to someone else.
--
-- Only VERIFIED accounts (0017's email_verified) hold an allocation. An unverified sign-up has
-- nobody who's proven control of it yet, and may never be finished — letting those rows hold
-- space would let abandoned or junk sign-ups fill the system and lock out real registrants.
--
-- Consequences, all enforced here rather than only in the application layer (same reasoning as
-- 0015 — the guarantee must hold against any write path):
--   * INSERT into users fails once the space left unallocated by verified accounts can't cover
--     the new account's quota → registration is closed once the system is fully allocated.
--     The new row isn't allocated yet at this point; this is just the registration gate.
--   * Verifying an email (email_verified false → true) is the point the quota is actually
--     allocated, and fails if the space has run out since registration.
--   * Raising a verified user's quota fails if it would push total allocation past the limit.
--     An unverified user's quota isn't allocated, so it's checked when they verify instead.
--   * Lowering the system limit below current total allocation fails.
-- Decreases (lowering a quota, raising the limit) are always allowed, so a deployment that is
-- already over-allocated when this migration runs isn't wedged — it just can't get worse.
--
-- Deleted accounts (0008 hard-deletes the USERS row) release their allocation automatically,
-- since the SUM is a live read over USERS, same as 0015's usage SUM.
-- =============================================================================

create or replace function users_enforce_quota_preallocation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_limit bigint;
  v_allocated_others bigint;
begin
  if tg_op = 'UPDATE' then
    if not new.email_verified then
      return new;
    end if;
    if old.email_verified and new.storage_quota_bytes <= old.storage_quota_bytes then
      return new;
    end if;
  end if;

  -- Same singleton lock 0015's usage trigger takes: serializes concurrent registrations,
  -- verifications and quota changes so two of them can't each read a stale total and both
  -- squeeze in.
  select total_storage_limit_bytes into v_limit from system_settings where id = true for update;

  select coalesce(sum(storage_quota_bytes), 0) into v_allocated_others
  from users where id <> new.id and email_verified;

  if v_allocated_others + new.storage_quota_bytes > v_limit then
    raise exception 'SYSTEM_STORAGE_ALLOCATION_EXCEEDED: allocated % + requested % would exceed total_storage_limit_bytes %',
      v_allocated_others, new.storage_quota_bytes, v_limit
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger trg_users_enforce_quota_preallocation
  before insert or update of storage_quota_bytes, email_verified on users
  for each row
  execute function users_enforce_quota_preallocation();

create or replace function system_settings_enforce_limit_covers_allocation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_allocated bigint;
begin
  if new.total_storage_limit_bytes >= old.total_storage_limit_bytes then
    return new;
  end if;

  select coalesce(sum(storage_quota_bytes), 0) into v_allocated from users where email_verified;

  if new.total_storage_limit_bytes < v_allocated then
    raise exception 'STORAGE_LIMIT_BELOW_ALLOCATION: total_storage_limit_bytes % is below allocated quotas %',
      new.total_storage_limit_bytes, v_allocated
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger trg_system_settings_enforce_limit_covers_allocation
  before update of total_storage_limit_bytes on system_settings
  for each row
  execute function system_settings_enforce_limit_covers_allocation();
