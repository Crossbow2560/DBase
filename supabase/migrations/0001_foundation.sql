-- =============================================================================
-- 0001_foundation.sql
-- Subcomponent 0 (IMPLEMENTATION_PHASES.md): USERS, SESSIONS
-- Source: DESIGN.md v7 §3.1, §3.2
-- =============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;    -- used later by search indexes (subcomponent 8)

create type user_role as enum ('user', 'admin');

-- -----------------------------------------------------------------------------
-- USERS  (DESIGN.md §3.1)
-- -----------------------------------------------------------------------------
create table users (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null unique,
  password_hash         text not null,
  display_name          text not null,
  role                  user_role not null default 'user',
  storage_quota_bytes   bigint not null default 0,
  storage_used_bytes    bigint not null default 0,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint users_storage_quota_bytes_non_negative check (storage_quota_bytes >= 0),
  constraint users_storage_used_bytes_non_negative check (storage_used_bytes >= 0)
);

comment on column users.storage_quota_bytes is
  'Admin-editable only, at the application layer. Negative values rejected at input (REQUIREMENTS.md §5.6).';
comment on column users.storage_used_bytes is
  'Denormalized running total. Never computed live via SUM() (DESIGN.md §3.1). Kept in sync by the atomic conditional update in adjustStorageUsed() (APPLICATION_DESIGN.md §5.2), not by this trigger alone.';

-- DESIGN.md §3.1: "this rule must only fire when storage_used_bytes increases" — a plain
-- CHECK constraint cannot see OLD vs NEW, so this must be a BEFORE UPDATE trigger.
-- Lowering storage_quota_bytes below current usage must remain allowed (admin capping a user).
--
-- Bypass mechanism: ownership transfer (transfer_ownership(), 0008) moves a file's
-- size_bytes from the old owner's storage_used_bytes to the new owner's, in the same
-- transaction as the ownership change. That move must never be blocked by the recipient's
-- quota — same accepted-over-quota precedent REQUIREMENTS.md §5.6 already establishes for an
-- admin lowering a user's quota below current usage (over-quota is a legitimate state that
-- blocks new uploads, not existing data). This matters most for account-deletion's bulk
-- reassignment, which must never fail just because the designated system-admin account is
-- over quota. transfer_ownership() sets the transaction-local
-- 'dbase.bypass_quota_check' setting to 'true' around its two balance-adjusting UPDATEs; the
-- non-negative CHECK constraint on storage_used_bytes still applies regardless of this flag,
-- so a genuine accounting bug (e.g. moving more bytes than the old owner actually had) still
-- surfaces loudly rather than being masked.
create or replace function users_enforce_quota_on_increase()
returns trigger
language plpgsql
as $$
begin
  if new.storage_used_bytes > old.storage_used_bytes
     and new.storage_used_bytes > new.storage_quota_bytes
     and coalesce(current_setting('dbase.bypass_quota_check', true), 'false') <> 'true' then
    raise exception 'QUOTA_EXCEEDED: storage_used_bytes % would exceed storage_quota_bytes % for user %',
      new.storage_used_bytes, new.storage_quota_bytes, new.id
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_users_enforce_quota_on_increase
  before update on users
  for each row
  execute function users_enforce_quota_on_increase();

-- -----------------------------------------------------------------------------
-- SESSIONS  (DESIGN.md §3.2)
-- -----------------------------------------------------------------------------
create table sessions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references users(id) on delete cascade, -- account deletion (0008) explicitly revokes sessions first, but the row must still be removable by the subsequent DELETE FROM users without a lingering FK block
  refresh_token_hash     text not null unique,
  device_info            text,
  expires_at             timestamptz not null,
  created_at             timestamptz not null default now(),
  revoked_at             timestamptz
);

-- SESSIONS(refresh_token_hash) already backed by the UNIQUE constraint above, but called out
-- explicitly per DESIGN.md §5.4: looked up on every authenticated request.
-- (index exists implicitly via the UNIQUE constraint)

-- DESIGN.md §5.4 (Pass 6): required for bulk session invalidation on deactivation/deletion.
create index idx_sessions_user_id on sessions(user_id);
