# Testing

## Running tests

```bash
npm test
```

This runs `node --import tsx --test src/**/*.test.ts`, which uses Node's built-in `node:test` runner and `node:assert/strict`. There is no Jest or Vitest. `tsx` compiles the TypeScript on the fly, and test files are excluded from `tsc` builds (`tsconfig.json` → `exclude`).

> The glob is expanded by your shell. In shells without `globstar` (default bash), `src/**/*.test.ts` matches only one directory level below `src/`. That covers the current tests in `src/lib/`, but tests nested deeper would be skipped. Quote the pattern or enable `shopt -s globstar` if you add deeper tests.

## What is covered

The suite is unit-only and has no I/O, so it needs no database, MinIO or `.env`:

| File | Covers |
|---|---|
| `src/lib/password.test.ts` | bcrypt round trip, wrong-password rejection, hash ≠ plaintext, 8-character minimum |
| `src/lib/tokens.test.ts` | token uniqueness and entropy, deterministic SHA-256 hashing, hash ≠ raw token |

Nothing covers the service modules, the routes, the workers, the SQL migrations (triggers, constraints, `delete_account`) or the frontend. `web/` has `npm run typecheck` (`tsc --noEmit`) and `npm run lint`, but no test runner.

## Strategy

- **Pure helpers:** functions in `src/lib` are tested directly with `node:test`.
- **Database invariants:** these are deliberately enforced in Postgres (see [decisions.md](decisions.md)), so the meaningful tests for quotas, ownership and last-admin rules would be integration tests against a real Postgres with the migrations applied. They don't exist yet.
- **Current fallback:** service-layer and end-to-end behavior is verified manually against a running stack. Many code comments describe bugs found that way, by "actually running" or "actually loading in a browser".

## Static checks

```bash
npm run build              # backend type check + emit (tsc, strict, noUncheckedIndexedAccess)
cd web && npm run typecheck
cd web && npm run lint
```

No coverage tool is configured.
