# Technical decisions

## Modular monolith, single instance

**Decision:** one Fastify process holds every domain module and every background worker.

**Why:** a single host is the deployment target. One process keeps transactions, logging and deployment simple. Modules are still isolated behind two choke points, `checkPermission()` for authorization and `storage/client.ts` for object storage, so splitting them out later wouldn't mean rewriting call sites.

**Trade-off: exactly one backend instance is supported.** Running replicas is not a configuration option today, for two concrete reasons:

- **Rate limits are per process.** `@fastify/rate-limit` uses its in-memory store, so N replicas would each allow the full budget — login brute-force protection, share-link unlock limits and the per-IP ceiling would all be N× weaker.
- **Workers run in every process.** Each instance starts all four `setInterval` workers. Queue claims use `FOR UPDATE SKIP LOCKED` and session aborts use conditional updates, so duplicated workers stay *correct*, but they multiply database polling for no benefit.

Scaling out would mean a shared rate-limit store (`@fastify/rate-limit` supports Redis) and running workers in one dedicated process. Until then, scale vertically. The backend logs this constraint at startup.

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

**Decision:** `resolveEffectiveRole()` resolves every check with one SQL query: the item's direct grant plus grants on every ancestor folder (taken from the parent's `materialized_path`), joined to `users` so grants from deactivated granters don't count. The `effective_permissions` table exists but isn't read.

**Why:** the design requires correct synchronous fallback anyway, so skipping the cache costs only read performance, not correctness. It also makes revocation and deactivation take effect immediately. A grant stops working as soon as its `granted_by` user is deactivated, without any invalidation step.

**Trade-off:** each check costs two round trips (the admin-role lookup and the grant query) rather than a cache read. `search` uses the same rule, so it finds anything inside a shared folder. "Shared with me" deliberately lists only top-level shares, as in Google Drive; their contents are reached by opening them.

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

**Decision:** each part (5–32 MiB, sized to the file) is streamed through the backend to `tmp/<session>/part-NNNNNN`, then combined with MinIO's server-side `composeObject` into a random `files/<64 hex>` key.

**Why:**
- Quota is checked and charged per part, so an upload is rejected when it would exceed quota rather than after it finishes.
- Parts are idempotent and resumable.
- Abandoned sessions are swept by a timer that credits the quota back.
- Random keys keep `storage_key` unguessable.

**Rate limiting:** upload-part endpoints are deliberately excluded from rate limits; authenticated part requests don't count toward the per-IP ceiling either (only failed authentications do). The client caps concurrency instead.

**Throughput:** large uploads were bound by per-part overhead, not bandwidth. Each 5 MiB part waited for ~11 sequential database round trips plus two proxy hops, so one part at a time reached about 8 MB/s against a database 50 ms away. The fix keeps this architecture but removes the overhead: one database round trip per part (`record_upload_part()`), bodies piped to MinIO instead of buffered, parts sized to the file, and 4 parts in flight per file. Measured with a 50 ms database round trip (`test/preview/upload-bench.ts`): 7.8 MB/s before, ~95 MB/s for a 200 MB file and ~230 MB/s for 1 GB after.

**Rejected for now:** presigned uploads straight from the browser to MinIO. That would skip Node and Next entirely, but it means reserving quota by declared size instead of charging per received part, MinIO CORS, and replacing the compose path with native S3 multipart. Worth revisiting if the backend becomes the bottleneck.

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

**Exception:** `GET /users/lookup` intentionally resolves emails, because sharing requires it. It's limited to 30 lookups a minute per session so it can't be used to sweep a list of addresses.

## Single shared `.env`

**Decision:** one root `.env` drives the backend, the frontend and compose. Each port variable sets both the container port and the host port.

**Why:** a single config file avoids drift between files. `web/scripts/with-frontend-port.js` exists only because both services would otherwise claim `PORT`.

## Encryption at rest and RLS

- **Encryption:** MinIO SSE-S3 with a single KMS key from `MINIO_KMS_SECRET_KEY`. It is simple but has no key rotation, and objects written before it was enabled stay unencrypted.
- **RLS:** enabled with zero policies (`0010`). This closes the Supabase auto-generated API. The app's own role bypasses RLS, so authorization stays in `checkPermission()`.

## Folder sync: a trigger-written change feed with commit-ordered cursors

**Decision:** triggers on `files`/`folders` write `sync_events`. A sequencer serialized by an advisory lock assigns `seq` to committed rows only, and clients resume from a `seq` cursor.

**Why:** a client resuming from "the last thing I saw" needs a cursor that never skips anything. `updated_at` can't provide that (concurrent transactions commit out of timestamp order, and purged rows vanish), and a plain `bigserial` can't either (values are taken at insert, not commit). Numbering only committed rows, one sequencer at a time, makes `seq` order equal to visibility order. Triggers mean no write path can forget to log.

**Trade-offs:** one extra insert per mutation, plus a short sequencer pass before each sync read. Events are pruned after `SYNC_EVENT_RETENTION_DAYS`, and an older cursor gets `410` and re-reads the tree.

**Rejected:** a timestamp cursor with an overlap window (it trades missed events for duplicates and guesswork), and a global lock held from first write to commit (it would serialize every upload).

## Device tokens for sync clients

**Decision:** long-lived bearer tokens (`dbt_…`, stored hashed) that authenticate every normal route but can't manage credentials. `dbase-sync login` uses the password once, to mint a token, and then signs that session out.

**Why:** cookie sessions expire after 30 days and logins are limited to 20 per 15 minutes per IP, which is fine for a browser but wrong for a daemon. Refusing credential management to tokens means a leaked token can't escalate. Password changes and resets, and deactivation, revoke all of a user's tokens, like sessions.

## Content replace without version history; opaque content versions

**Decision:** a replace swaps a file's `storage_key` in place, and the old object is deleted shortly after. The old bytes stop counting against quota immediately. Change detection and compare-and-swap use `version = sha256(storage_key)`, not `checksum`.

**Why:**
- Keeping the same file row preserves shares, tags, favorites and links.
- Without versions, there's nothing to keep the old bytes for.
- Checksums are client-supplied and the web client doesn't send them, so most files have none. The storage key changes exactly when the content does, and hashing it keeps the key itself private.
- When an editor replaces someone else's file, the owner is charged the difference, because quota counts what a user owns.

## Sync never propagates deletes

**Decision:** deleting a file locally leaves it in DBase (`local_removed`, and it isn't downloaded again unless edited remotely). Trashing it in DBase leaves the local copy (`detached`, and it's never uploaded again unless the user runs `dbase-sync reattach`). When both sides changed, both versions are kept.

**Why:** a sync client must never be the reason data is lost. An accidental delete on either side, or a confused client, can't take the other side's copy with it, and an edit always beats a delete. The cost is that intentional deletes have to be made on each side.

