-- =============================================================================
-- 0013_password_reset_tokens.sql
-- Subcomponent 0 (IMPLEMENTATION_PHASES.md): PASSWORD_RESET_TOKENS
--
-- Gap closure: REQUIREMENTS.md §5.1 requires self-service password reset ("e.g., an emailed
-- reset link"), but DESIGN.md's entity list (§3) never modeled where that reset token's state
-- lives — USERS/SESSIONS alone have no field for it. This table follows the same
-- store-a-hash-never-the-token pattern DESIGN.md already uses for SESSIONS.refresh_token_hash
-- (§3.2), for the same reason: a leaked database row must not itself be a usable reset link.
-- =============================================================================

create table password_reset_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz, -- null = unused; set once, on successful confirm, to prevent replay
  created_at  timestamptz not null default now()
);

comment on table password_reset_tokens is
  'The raw token is emailed to the user and never stored — only its hash. A token is valid to
   confirm a reset exactly once: used_at IS NULL AND expires_at > now(). Requesting a new reset
   does not need to invalidate prior outstanding tokens for the same user (a stale, unused
   token simply expires on its own); the application may optionally do so for tidiness, but it
   is not a correctness requirement.';

-- token_hash already backed by its UNIQUE constraint — looked up on every confirm attempt.
create index idx_password_reset_tokens_user_id on password_reset_tokens(user_id);

alter table password_reset_tokens enable row level security;
