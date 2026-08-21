-- =============================================================================
-- 0015_system_storage_limit.sql
-- A hard, system-wide cap on total storage across every account combined, admin-editable only.
-- Mirrors the per-user quota's own design (0001_foundation.sql's
-- users_enforce_quota_on_increase): the real guarantee lives in a BEFORE UPDATE trigger on
-- USERS, not just an application-layer check, so it holds even against a future write path
-- that bypasses the application's own guarded UPDATE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SYSTEM_SETTINGS (singleton row)
-- -----------------------------------------------------------------------------
-- `id boolean primary key default true check (id)` is the standard Postgres singleton-table
-- trick: the CHECK forces id to always be `true`, and the PRIMARY KEY then makes a second row
-- (which would also have to have id = true) violate uniqueness — so at most one row can ever
-- exist, with no separate application-level enforcement needed.
create table system_settings (
  id                          boolean primary key default true check (id),
  total_storage_limit_bytes   bigint not null default 536870912000, -- 500 GiB (500 * 1024^3), matches the binary-GiB convention DEFAULT_USER_QUOTA_BYTES already uses
  updated_at                  timestamptz not null default now(),

  constraint system_settings_limit_non_negative check (total_storage_limit_bytes >= 0)
);

comment on table system_settings is
  'Singleton (always exactly one row, id = true). Admin-editable system-wide settings.';
comment on column system_settings.total_storage_limit_bytes is
  'Hard cap on SUM(users.storage_used_bytes) across every account. Enforced by trg_users_enforce_system_storage_limit below, not just at the application layer.';

insert into system_settings (id) values (true);

alter table system_settings enable row level security;

create trigger trg_system_settings_touch_updated_at
  before update on system_settings
  for each row
  execute function touch_updated_at();

-- -----------------------------------------------------------------------------
-- Enforcement trigger on USERS
-- -----------------------------------------------------------------------------
-- Fires only when storage_used_bytes is increasing (a credit-back / decrease must always be
-- allowed through, same reasoning as the per-user trigger). Locks the SYSTEM_SETTINGS singleton
-- row first (SELECT ... FOR UPDATE) so two concurrent credits for two different users are
-- serialized here rather than each independently reading a stale total and both passing —
-- the same TOCTOU concern the per-user path avoids by using a single atomic conditional UPDATE
-- instead of read-then-write. With that lock held, SUM(storage_used_bytes) over USERS is a live
-- read of a small table (one row per account, not per file) rather than a second denormalized
-- running total that could drift from reality — deliberately different from
-- users.storage_used_bytes itself, which IS a denormalized counter specifically because
-- summing per-FILE rows live would be expensive (0001_foundation.sql's column comment); summing
-- per-USER rows live is not the same cost shape.
--
-- Same bypass mechanism as users_enforce_quota_on_increase (0001_foundation.sql): ownership
-- transfer moves bytes between two users' rows in one transaction, net-zero on the system total,
-- and must never be blocked by this check.
create or replace function users_enforce_system_storage_limit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_limit bigint;
  v_projected_total bigint;
begin
  if new.storage_used_bytes <= old.storage_used_bytes then
    return new;
  end if;
  if coalesce(current_setting('dbase.bypass_quota_check', true), 'false') = 'true' then
    return new;
  end if;

  select total_storage_limit_bytes into v_limit from system_settings where id = true for update;

  select coalesce(sum(storage_used_bytes), 0) into v_projected_total
  from users where id <> new.id;
  v_projected_total := v_projected_total + new.storage_used_bytes;

  if v_projected_total > v_limit then
    raise exception 'SYSTEM_STORAGE_LIMIT_EXCEEDED: total_storage_used_bytes % would exceed total_storage_limit_bytes %',
      v_projected_total, v_limit
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger trg_users_enforce_system_storage_limit
  before update on users
  for each row
  execute function users_enforce_system_storage_limit();
