-- =============================================================================
-- 0017_email_verification.sql
-- Subcomponent 0: email verification on signup
--
-- REQUIREMENTS.md §5.1 originally deferred this ("not required in this phase — deferred, see
-- §8") — added on direct request. Mirrors password_reset_tokens (0013) exactly: same
-- store-a-hash-never-the-token pattern, same shape, for the same reason (a leaked DB row must
-- not itself be a usable verification link).
-- =============================================================================

alter table users add column email_verified boolean not null default false;

comment on column users.email_verified is
  'False until the registrant proves control of the email address by following a verification
   link (email_verification_tokens below). Login is blocked while false (accounts/service.ts) —
   this is the actual point of verification, not just a cosmetic badge.';

create table email_verification_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz, -- null = unused; set once, on successful verify, to prevent replay
  created_at  timestamptz not null default now()
);

comment on table email_verification_tokens is
  'The raw token is emailed to the registrant and never stored — only its hash, same as
   password_reset_tokens (0013). A token is valid to confirm exactly once:
   used_at IS NULL AND expires_at > now(). Requesting a resend does not invalidate prior
   outstanding tokens for the same user — a stale, unused one simply expires on its own.';

create index idx_email_verification_tokens_user_id on email_verification_tokens(user_id);

alter table email_verification_tokens enable row level security;

-- Accounts created before this feature existed never went through a verification flow at all —
-- leaving them at the new column's false default would retroactively lock out every existing
-- login (including the admin's own), not just gate future signups, which is the actual intent.
update users set email_verified = true where created_at < now();
