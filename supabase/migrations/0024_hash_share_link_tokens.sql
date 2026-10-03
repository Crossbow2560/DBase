-- =============================================================================
-- 0024_hash_share_link_tokens.sql
-- Share-link tokens are stored as SHA-256 hashes, like session/reset/verification tokens.
--
-- A share token is a bearer credential: anyone holding it opens the link. Sessions
-- (refresh_token_hash), password-reset and email-verification tokens were already stored only as
-- hashes (DESIGN.md §3.2: "Store a hash of the token, never the token itself"), but
-- share_links.token held the raw value, so a database leak handed out every live link.
--
-- Existing rows are hashed in place, so every link already sent out keeps working: the app hashes
-- the presented token (src/lib/tokens.ts hashToken: lowercase hex SHA-256 of the UTF-8 string) and
-- looks it up by this column. Uses the core sha256() function (PostgreSQL 11+), not pgcrypto, so it
-- doesn't depend on which schema an extension lives in.
--
-- Consequence: the share dialog can no longer re-display an existing link's URL — it's shown once,
-- at creation (same model as API tokens elsewhere).
-- =============================================================================

alter table share_links rename column token to token_hash;
alter table share_links rename constraint share_links_token_key to share_links_token_hash_key;

update share_links
set token_hash = encode(sha256(convert_to(token_hash, 'UTF8')), 'hex');

-- Belt and braces: every value must now look like a hex SHA-256, never a raw token.
alter table share_links
  add constraint share_links_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$');
