-- =============================================================================
-- 0027_device_tokens.sql
-- Long-lived bearer tokens for non-browser clients (the dbase-sync CLI/daemon).
--
-- A cookie session lasts SESSION_TTL_DAYS and is minted only by login, which is limited to
-- 20 requests per 15 minutes per IP — fine for a browser, wrong for a daemon that should keep
-- running for months. A device token has no expiry; it lives until it is revoked (by the user,
-- a password change/reset, or account deactivation). It authenticates exactly like a session
-- (accounts/guards.ts requireSession), so every existing route works with it unchanged.
--
-- Stored only as a SHA-256 hash, like sessions and share links (DESIGN.md §3.2); the raw token is
-- shown once, at creation.
-- =============================================================================

create table device_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  token_hash    text not null unique,
  name          text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,

  constraint device_tokens_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint device_tokens_name_length check (char_length(name) between 1 and 100)
);

create index idx_device_tokens_user_id on device_tokens(user_id);

-- Same reasoning as 0010: this app never uses the Supabase data API, so deny it by default.
alter table device_tokens enable row level security;
