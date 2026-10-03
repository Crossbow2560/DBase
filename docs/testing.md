# Testing

Two suites, both on Node's built-in `node:test` runner with `node:assert/strict` (no Jest or Vitest). `tsx` compiles TypeScript on the fly; test files are excluded from `tsc` builds.

## Unit tests

```bash
npm test
```

Runs `node --import tsx --test "src/**/*.test.ts"`. The glob is quoted so Node expands it itself (Node ≥ 22), picking up test files at any depth. No database, MinIO or `.env` needed.

| File | Covers |
|---|---|
| `src/lib/password.test.ts` | bcrypt round trip, wrong-password rejection, hash ≠ plaintext, 8-character minimum |
| `src/lib/tokens.test.ts` | token uniqueness and entropy, deterministic SHA-256 hashing, hash ≠ raw token |
| `src/lib/env.test.ts` | `TRUST_PROXY` parsing, `COOKIE_SECURE` defaults and overrides |

## Integration tests

```bash
npm run test:db:up          # postgres:16 + MinIO from docker-compose's `test` profile (tmpfs, throwaway)
npm run test:integration
npm run test:db:down        # optional
```

`test/integration/harness.ts` gives every test file its own fresh database (migrated with the same `applyMigrations()` deploys use) and its own MinIO bucket, then drives the real app through `buildApp()` + `app.inject()`. It points dotenv at `/dev/null`, so a developer's real `.env` (Supabase URL, Resend key) is never read. Nothing touches the real database.

| File | Covers |
|---|---|
| `smoke.test.ts` | all migrations apply; register → verify → login → upload → byte-identical download; 401/403 guards; cookie `Secure` flag |
| `uploads.test.ts` | part-number validation, 5 MiB minimum part size, concurrent part retries charge once, compose failure leaves no orphan row, cancel/cleanup/completion races refund exactly once |
| `names.test.ts` | folder-scoped sibling names in shared folders; migration `0023` renaming existing duplicates within the byte limit |
| `ratelimit.test.ts` | per-IP ceiling vs rotating cookies, `X-Forwarded-For` trust, login lockout isolated per client, user-lookup limit |
| `share-links.test.ts` | unlock cookie flow, no passwords in URLs, tampered/cross-link cookies, no cross-visitor lockout, hashed tokens, migration `0024`, log redaction |
| `permissions.test.ts` | direct/inherited/highest grants, deactivated granters, admin bypass, search over shared folders, shared-with-me |
| `invariants.test.ts` | per-user quota, system limit pre-allocation, last-admin protection, trash restore/purge (object + quota), share-link scope and expiry |
| `bootstrap-admin.test.ts` | the bootstrap script refuses `--password`, needs a TTY or `BOOTSTRAP_ADMIN_PASSWORD`, creates a working admin |
| `secure-cookie.test.ts` | `Secure` cookies for an `https://` `PUBLIC_APP_URL` |

Test files run in parallel (`--test-concurrency=4`), each in its own process and database.

## Strategy

- **Pure logic** (`src/lib`) gets unit tests.
- **Anything enforced by Postgres** (quotas, ownership, last admin, name uniqueness) or spanning DB + MinIO (uploads, purge) is tested against real services, because mocks would skip exactly the triggers and constraints the behavior depends on.
- **Concurrency bugs** are tested by firing the competing requests together (`Promise.all` / `allSettled`) over several rounds and asserting the end state (quota, rows, objects).
- **Migrations with data fix-ups** are tested by migrating a scratch database up to the previous file (`applyMigrations(url, log, { stopAfter })`), seeding the old shape, then applying the rest.

## Manual preview environment

For browser checks without touching real data:

```bash
npm run test:db:up
npm run preview:seed        # database dbase_preview + bucket + two test accounts (see test/preview/seed.ts)
```

Then start the `preview-backend` (port 3105) and `preview-web` (port 3110) configurations from `.claude/launch.json`.

## Static checks

```bash
npm run build                 # backend type check + emit (tsc, strict, noUncheckedIndexedAccess)
cd web && npm run typecheck
```

`web`'s `npm run lint` currently starts Next's interactive ESLint setup, because the project has no ESLint config yet. No coverage tool is configured.
