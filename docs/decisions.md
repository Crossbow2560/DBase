# Technical decisions

## Modular monolith, single instance

**Decision:** one Fastify process holds every domain module and every background worker.

**Why:** a single host is the deployment target. One process keeps transactions, logging and deployment simple. Modules are still isolated behind two choke points, `checkPermission()` for authorization and `storage/client.ts` for object storage, so splitting them out later wouldn't mean rewriting call sites.

**Trade-off:** the design assumes a single instance. The rate-limit store is in-process memory, and the workers rely on in-memory overlap guards. Queue claims use `FOR UPDATE SKIP LOCKED`, so queue processing itself is multi-instance safe. Rate limits, however, would under-count across replicas.

## SQL migrations as the schema source of truth, Prisma for queries only

**Decision:** DDL lives in `supabase/migrations/*.sql` and is applied by `scripts/migrate.ts` using `pg`. Prisma is used only as a typed query client.

**Why:** the schema depends on things Prisma's migration engine can't express:
- deferrable one-owner-per-item constraints on a generated column
- quota and system-limit triggers
- the `LAST_ADMIN` guard
- the `delete_account()` and `transfer_ownership()` functions
- trigram indexes in the `extensions` schema

`pg`'s simple query protocol runs multi-statement files containing `$$` function bodies the same way `psql` does.

**Rejected alternatives:**
- `prisma migrate` can't model the constructs above.
- The Supabase CLI/dashboard was replaced by the runner so deploys can apply migrations automatically before new code starts serving.

## Invariants enforced in Postgres, not only in app code

**Decision:** the following are enforced by triggers and constraints:
- the per-user quota
- the system storage limit
- quota pre-allocation (sum of quotas ≤ system limit)
- exactly one owner per item
- at least one active admin

**Why:** these invariants have to hold under concurrent requests and against any future write path. The app still checks first, for good error messages. For example, quota is charged with an atomic `UPDATE … WHERE used + delta <= quota RETURNING`, never read-then-write. Trigger exceptions are mapped to stable error codes such as `SYSTEM_STORAGE_LIMIT_EXCEEDED`, `SYSTEM_STORAGE_ALLOCATION_EXCEEDED` and `LAST_ADMIN`.

## Transaction-mode pooler for everything

**Decision:** both the app and the migration runner use Supavisor's transaction pooler (`DATABASE_URL`, port 6543).

**Why:** the self-hosted runner has no IPv6 route, and Supabase's direct host is IPv6-only. This only works because every advisory lock is `pg_advisory_xact_lock` (transaction-scoped), never session-scoped, and every migration file runs inside its own `begin`/`commit`.

## Synchronous permission resolution, no cache

**Decision:** `resolveEffectiveRole()` walks the folder ancestor chain on every check, using `materialized_path` to find ancestors. The `effective_permissions` table exists but isn't read.

**Why:** the design requires correct synchronous fallback anyway, so skipping the cache costs only read performance, not correctness. It also makes revocation and deactivation take effect immediately. A grant stops working as soon as its `granted_by` user is deactivated, without any invalidation step.

**Trade-off:** each check costs several queries. `search` and `shared-with-me` only list items with a **direct** grant. Items reachable only through an inherited folder share are accessible but don't appear in those lists.

## Opaque sessions in an httpOnly cookie behind a same-origin proxy

**Decision:**
- Sessions are random 32-byte tokens stored as SHA-256 hashes in `sessions` and sent as an httpOnly, `secure`, `SameSite=Lax` cookie.
- The frontend reaches the API through a Next.js **rewrite** of `/api/v1/*`.

**Why:**
- Server-side sessions make logout, "revoke this device" and deactivation instant, which JWTs can't do without a denylist.
- A fast hash is fine for high-entropy tokens. bcrypt (12 rounds) is reserved for passwords.
- A rewrite forwards the Cookie header by construction. A hand-written route handler could silently drop it.
- Same origin removes CORS from the picture entirely.

**Gotcha:** rewrites are evaluated at `next build`, so `BACKEND_URL` is a Docker **build arg**, not a runtime env var.

## Presigned URLs for file bytes; two MinIO clients

**Decision:** downloads, previews and thumbnails return presigned MinIO URLs. Only folder zips stream through the backend.

**Why:** file bytes never pass through Node. Permission is checked once, at signing time. The browser and the backend reach MinIO at different hosts (a public domain vs. the compose service name `minio`), so one client does I/O and a second, `publicClient`, only signs. Pinning the region stops the SDK from making a region-lookup network call against the public host, which isn't reachable from inside the container.

## Custom chunked upload instead of S3 multipart

**Decision:** each 5 MB part is stored as `tmp/<session>/part-NNNNNN`, then combined with MinIO's server-side `composeObject` into a random `files/<64 hex>` key.

**Why:**
- Quota is checked and charged per part, so an upload is rejected when it would exceed quota rather than after it finishes.
- Parts are idempotent and resumable.
- Abandoned sessions are swept by a timer that credits the quota back.
- Random keys keep `storage_key` unguessable.

**Rate limiting:** upload-part endpoints are deliberately excluded from rate limits. The client caps concurrency at 3 and honors `Retry-After` instead.

## Asynchronous deletion and thumbnails through DB-backed queues

**Decision:** `deletion_queue` and `thumbnail_queue` tables, drained by `setInterval` workers with bounded retries (5 for deletion, 3 for thumbnails), then a terminal `failed` state.

**Why:**
- Purging objects and generating thumbnails can be slow or fail transiently, and shouldn't block a request.
- Durable rows survive restarts.
- Partial unique indexes make enqueueing idempotent.
- Failed deletions are visible to admins (`/admin/failed-jobs`) instead of retrying forever.

**Rejected:** native bindings for video and PDF thumbnails. The worker shells out to `ffmpeg` and `pdftoppm` because it's a best-effort background job.

## Bootstrap admin by CLI script, not HTTP

**Decision:** `scripts/bootstrap-admin.ts` creates the first admin and refuses to run once any admin exists.

**Why:** there is no permanent "create admin" endpoint to attack. `role` is never accepted from clients.

## Non-enumerating auth responses

- Registration, password-reset and resend-verification responses never reveal whether an email exists.
- Login checks the password before `is_active` and `email_verified`.
- Denied item access returns 404, not 403.
- An unverified account's email can be re-registered, which overwrites the unverified row, so abandoned signups don't block the address forever.

**Exception:** `GET /users/lookup` intentionally resolves emails, because sharing requires it.

## Single shared `.env`

**Decision:** one root `.env` drives the backend, the frontend and compose. Each port variable sets both the container port and the host port.

**Why:** a single config file avoids drift between files. `web/scripts/with-frontend-port.js` exists only because both services would otherwise claim `PORT`.

## Encryption at rest and RLS

- **Encryption:** MinIO SSE-S3 with a single KMS key from `MINIO_KMS_SECRET_KEY`. It is simple but has no key rotation, and objects written before it was enabled stay unencrypted.
- **RLS:** enabled with zero policies (`0010`). This closes the Supabase auto-generated API. The app's own role bypasses RLS, so authorization stays in `checkPermission()`.
