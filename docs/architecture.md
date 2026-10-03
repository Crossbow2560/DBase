# Architecture

## System overview

```
 Browser
   │  same-origin requests (session cookie)        presigned GET (file bytes)
   ▼                                                        │
 Next.js frontend (web/, :3001)                             │
   │  rewrite /api/v1/* → BACKEND_URL                       │
   ▼                                                        ▼
 Fastify backend (src/, :3000) ───── minio SDK ──────►  MinIO (:9000)
   │  Prisma / raw SQL                                   bucket "dbase" (SSE-S3)
   ▼                                                     buckets "dbase-backup-<ts>"
 Supabase Postgres (pooler :6543)
   ▲
   └── scripts/migrate.ts applies supabase/migrations/*.sql
```

There are three runtime services plus a one-shot init container (`docker-compose.yml`):

| Service | Role |
|---|---|
| `backend` | Fastify API and all background workers, as one Node process |
| `frontend` | Next.js standalone server. Serves the UI and reverse-proxies `/api/v1/*` |
| `minio` | Object storage for file bytes, upload parts and thumbnails |
| `minio-init` | Creates the `dbase` bucket and enables SSE-S3 default encryption, then exits |

Postgres is external (Supabase). The stack does not run its own database.

## Backend components

`src/app.ts#buildApp()` builds the Fastify instance; `src/server.ts` calls it, starts listening and starts the three workers. The integration tests use `buildApp()` directly with `app.inject()`. `buildApp()`:

1. Configures logging with a request serializer that masks share-link tokens and drops query strings, and sets `trustProxy` (`TRUST_PROXY`, default: loopback/private hops) so `request.ip` is the real client behind the Next.js proxy.
2. Registers the cookie plugin (with `COOKIE_SECRET` for signed share-unlock cookies) and the rate-limit plugin: 300 req/min keyed by a SHA-256 of the session cookie (or IP), per-route overrides, plus a per-IP ceiling (`RATE_LIMIT_PER_IP_PER_MINUTE`) built on `createRateLimit()` so made-up cookies can't dodge limits.
3. Adds a raw `application/octet-stream` body parser for upload parts, with `bodyLimit` raised to 10 MB.
4. Installs a single error handler that maps `AppError` → `{ error: { code, message } }`, schema-validation errors → `400 VALIDATION_ERROR`, and anything else → `500 INTERNAL_ERROR`.
5. Registers each module's route plugin. Route guards (`requireSession`, `requireAdmin`) and the shared rate-limit presets live in `modules/accounts/guards.ts`.

### Domain modules (`src/modules/*`)

| Module | Responsibility |
|---|---|
| `accounts` | Register, email verification, login/logout, sessions, password change/reset, profile, storage usage |
| `filesystem` | Folders (create, rename, move, trash, list, zip), files (rename, move, trash, download/preview URLs), chunked uploads |
| `access` | `checkPermission()` / `resolveEffectiveRole()`, permission grants, ownership transfer, share links (authenticated and public) |
| `trash` | Trash listing, restore, "delete forever", deletion-queue processing |
| `organize` | Favorites and per-user colored tags |
| `search` | Case-insensitive name search over everything the user can open (owned, shared, or inside a shared folder) |
| `thumbnails` | Thumbnail queue and generation (`sharp`, `ffmpeg`, `pdftoppm`) |
| `lifecycle` | Account deactivate, reactivate and delete (with ownership reassignment) |
| `admin` | User management, quotas, roles, system storage limit, stats, activity log, failed jobs, MinIO backup/restore, outbound email |
| `email` | Inbound Resend webhook (Svix signature verification) and storage of received mail |
| `storage` | The only module that touches MinIO: part upload/compose, presigned URLs, streams, backups |

Each module follows the same layout: `routes.ts` (HTTP and schema validation), `*-service.ts` (business logic) and `errors.ts` (factory functions that return `AppError`s with stable codes).

### Two enforced boundaries

- **Authorization:** every module calls `access/permission-check.ts#checkPermission(userId, itemType, itemId, requiredRole)`. It resolves the highest role from a direct grant or from any ancestor folder in one SQL query (ancestors come from the parent's `folders.materialized_path`). Grants whose `granted_by` user is deactivated are ignored. Admins short-circuit to `true`. When access is denied, the route returns a 404-style `*_NOT_FOUND` rather than 403, so the item's existence isn't leaked.
- **Storage:** only `storage/client.ts` builds MinIO clients or touches `storage_key`/`thumbnail_key`. It uses two clients: an internal one (`MINIO_ENDPOINT`, for I/O) and a public one (`MINIO_PUBLIC_ENDPOINT`, only for signing presigned URLs the browser will load). The region is pinned to `us-east-1` so presigning never makes a network call.

### Background workers (`src/workers/*`)

All workers use `setInterval` with an in-memory "tick in progress" flag so ticks never overlap.

| Worker | Interval | Work |
|---|---|---|
| `upload-session-cleanup` | 5 min | Abort `pending` upload sessions past `expires_at`, credit the bytes back to the quota, remove temp parts |
| `deletion-queue` (drain) | 1 min | Claim pending `deletion_queue` rows (`FOR UPDATE SKIP LOCKED`), delete the objects, retry up to 5 times, then mark `failed` |
| `deletion-queue` (scan) | 1 h | Enqueue trashed items older than `TRASH_RETENTION_DAYS` (30) |
| `thumbnail-queue` | 30 s | Claim pending `thumbnail_queue` rows, generate a 320px JPEG, retry up to 3 times |

## Key flows

### Authentication

1. `POST /auth/register` creates the user with `email_verified=false` and emails a verification link (`PUBLIC_APP_URL/verify-email?token=…`). Only the SHA-256 hash of the token is stored.
2. `POST /auth/verify-email` flips `email_verified`. A DB trigger (migration `0022`) allocates the user's quota out of the system storage limit at this point.
3. `POST /auth/login` checks the bcrypt hash, then `is_active`, then `email_verified`, in that order, so a wrong password looks identical either way. It creates a `sessions` row and sets the `dbase_session` httpOnly, `SameSite=Lax` cookie (`Secure` when `PUBLIC_APP_URL` is https, or per `COOKIE_SECURE`).
4. Every protected route runs `requireSession` as a `preHandler`. It hashes the cookie, loads the session and its user, and rejects the request if the session is revoked or expired or the user is deactivated.

### Chunked upload

```
POST /files                                  → upload_sessions row (pending, expires in 60 min)
PUT  /files/upload-sessions/:id/parts/:n     → record_upload_part(): session row locked, part row + quota charge,
                                               then body streamed to MinIO tmp/<id>/part-NNNNNN   (n = 0 … totalParts-1)
POST /files/upload-sessions/:id/complete     → claim session (pending → complete),
                                               MinIO composeObject → files/<random>,
                                               [tx] files row + owner permission + session link,
                                               thumbnail enqueue, audit log
```

- The client (`web/lib/uploads.tsx`) sizes parts at about 1/16 of the file (5–32 MiB), sends up to 4 parts of a file at once, runs at most 3 files concurrently and retries on 429 using `Retry-After`.
- Quota is charged per part with a single conditional `UPDATE users … WHERE used + delta <= quota RETURNING`, so concurrent parts can't overshoot. A system-wide trigger raises `SYSTEM_STORAGE_LIMIT_EXCEEDED` on top of that.
- Part numbers must be `0 … totalParts-1`; every part except the last must be at least 5 MiB (MinIO's compose minimum) and none over 64 MiB.
- Per part, the server does one database round trip — `record_upload_part()` (`0025`) validates, records the part and charges quota under the session row lock — then pipes the request body to MinIO through a presigned PUT, never buffering it. The destination is validated at init and completion, not per part.
- The Next.js proxy needs `experimental.middlewareClientMaxBodySize` raised (`web/next.config.js`, 70 MB); its default silently truncates request bodies over 10 MB.
- Parts are idempotent: re-sending a recorded part is a no-op. Recording the part and charging quota happen in one transaction holding the session row's lock, so concurrent retries charge once and an abort always sees (and refunds) every charged part.
- Completion composes the object **before** creating the file row. A compose failure returns the session to `pending` (the client can retry or cancel); a DB failure deletes the composed object and aborts with a refund. Cancel, the cleanup worker and a failing completion each claim the session with a conditional update, so only one of them ever refunds.
- On page load the frontend cancels any upload interrupted by a refresh of that tab (ids kept in `sessionStorage`), releasing its quota immediately.
- Transient failures (network errors, 5xx, 408, `UPLOAD_IN_PROGRESS`) are retried with backoff (1 s, 2 s, 4 s). After that the file fails but keeps its server session, so a manual Retry sends only the missing parts. Permanent failures abort the session (refunding quota) and Retry starts over. Completion is idempotent, so a retried "complete" whose first response was lost returns the existing file.
- The destination folder and name are re-validated on every part and on completion. Sibling names are unique per folder regardless of who owns each item (`0023`).

### Folder uploads

`web/lib/folder-upload.ts` turns a drop (via `webkitGetAsEntry()`, reading directories in batches until empty) or an `<input webkitdirectory>` selection (via `webkitRelativePath`) into a list of directories plus files. The upload provider checks quota, creates every directory in one `POST /folders/tree` (`folder-tree-service.ts`: two bulk inserts, folders plus owner permissions, in one transaction), then queues each file into its folder through the normal upload path. The tray shows the folder as one group.

### Downloads and previews

The backend never streams single files. `GET /files/:id/download|preview|thumbnail` checks permission and returns a short-lived presigned MinIO URL that the browser loads directly. Folder zips are the exception: `archiver` streams them through Fastify straight from MinIO object streams, without temp files.

### Sharing

- **Direct grants:** these are rows in `permissions` (`owner`/`editor`/`viewer`). Folder grants apply to the whole subtree dynamically.
- **Share links:** these store the SHA-256 of a random token (the raw token is shown to the creator once), a role, an optional bcrypt password and an optional expiry. Public routes under `/api/v1/public/share-links/:token` need no session. They resolve the link, check that its creator is still active, and keep folder browsing confined to the shared subtree.
- **Link passwords:** `POST …/:token/unlock` checks the password once (limited per client IP and link) and sets a signed, httpOnly cookie scoped to that link's API path; the other public routes require it. Passwords never appear in URLs or logs.

### Trash and deletion

Trashing sets `deleted_at`. Restoring clears it, as long as the item isn't already mid-purge. "Delete forever" and the 30-day scan both enqueue into `deletion_queue`, which the drain worker processes asynchronously, removing objects and crediting quota. Rows that keep failing show up in the admin "Failed jobs" page.

## Database interaction

- **DDL source of truth:** `supabase/migrations/0001…0022.sql`, applied by `scripts/migrate.ts`, which records each applied file in `_migrations`. `prisma/schema.prisma` is used only to generate a typed client. `prisma migrate` and `db push` must never be run.
- **Constraints the database enforces:**
  - Per-user quota: a `CHECK` plus a trigger.
  - System storage limit and pre-allocation (`0015`, `0022`).
  - Exactly one owner per item, through a deferrable constraint on the generated `owner_scope` column.
  - The last remaining active admin can't be deleted, demoted or deactivated (`LAST_ADMIN`).
  - Unique live names per folder.
- **Stored procedures:** `delete_account()` and `transfer_ownership()` (`0008`) perform multi-table ownership changes atomically.
- **Concurrency:** folder moves take `pg_advisory_xact_lock` on (subtree root, target parent) in sorted order, then re-run the cycle check inside the lock. Only transaction-scoped advisory locks are used, which is why the Supavisor transaction pooler (`:6543`) is safe for everything.
- **Search:** `ILIKE '%term%'` backed by `pg_trgm` GIN indexes (`0009`, moved to the `extensions` schema in `0014`).
- **RLS:** enabled on every table with zero policies (`0010`). The app connects with a role that bypasses RLS, so this only blocks the public Supabase API from reaching the tables.

## Frontend

- **Routes:** Next.js App Router under `web/app`:
  - `(auth)`: login, register, verify-email, password reset.
  - `(app)`: authenticated shell with sidebar, quota indicator, upload tray and the admin section.
  - `s/[token]`: public share-link viewer.
- **API access:** `web/lib/api-client.ts` is the only place that issues API requests. It sends `credentials: "include"`, parses the `{ error: { code, message } }` envelope into `ApiError`, and sends every `UNAUTHENTICATED` response to a single redirect-to-login handler registered by `AuthProvider`.
- **Server state:** handled by TanStack Query (`staleTime` 30 s), with keys centralized in `web/lib/query-keys.ts`.
- **Proxy:** `/api/v1/*` is proxied by a `next.config.js` rewrite, not a route handler, so the cookie is forwarded untouched. The rewrite target is baked in at `next build` time from `BACKEND_URL`.
