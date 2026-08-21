# Self-Hosted Cloud File Storage — Application Layer Design Document

**Status:** v6. v1 was reviewed once at the detail level (caught and fixed a broken DESIGN.md cross-reference and an over-broad admin activity-logging claim, §9). v2 revised the metadata-store hosting decision to Supabase-hosted PostgreSQL (§1.3, §1.3.1, §8) and received a high-level structural review pass (confirmed the Supabase change was genuinely threaded through, not just a header edit; surfaced and closed one real gap — DESIGN.md's still-open reconciliation/repair job wasn't picked up anywhere in the worker model, now addressed explicitly in §7.8). v3 records three owner decisions on previously-open items: backup/restore design is deliberately out of scope for this phase (§8.4 — the operator's future plan is to duplicate the object store at the database layer instead), multi-instance deployment is out of scope (§8.3 — single instance only), and general API rate limiting is now in scope (new §4.7), while login-attempt lockout specifically stays deferred per REQUIREMENTS.md. v4 corrects §1.3's Row-Level Security decision: RLS is now enabled (with zero policies) on every table as a deny-by-default backstop against Supabase's separate anon/authenticated PostgREST API surface, a path this document had not accounted for until implementation of the actual SQL migrations (`supabase/migrations/`) surfaced it — this does not change the application's own authorization model, since the app connects via the service_role key, which bypasses RLS unconditionally, leaving `access.checkPermission()` as the sole gate on all application traffic exactly as before. v5 adds `GET /api/v1/auth/me` (§4.2) — a gap surfaced while writing FRONTEND_DESIGN.md §6.2, not by a review pass of this document itself: nothing previously let a client re-establish the logged-in user after a page refresh without re-submitting credentials. v6 records two more owner decisions and the real bugs found operationalizing them: `GET /api/v1/users/me/storage` (§4.2) added as a deliberately separate route from `/auth/me`, since quota needs refreshing far more often than identity; and §8's deployment shape revised to Docker-on-Ubuntu (backend, frontend, and MinIO each their own container, orchestrated by a `docker-compose.yml`, Postgres deliberately excluded since Supabase hosts it externally) — which surfaced a real bug only found by actually running the built containers: `next.config.js`'s `rewrites()` bakes its backend URL in at Next.js *build* time, not runtime, so a Docker Compose `environment:` var had no effect and had to become a build argument instead (§8.1 has the full account). A full line-by-line adversarial pass (matching DESIGN.md's six-pass rigor) is still outstanding — see §10.
**Related docs:** [REQUIREMENTS.md](./REQUIREMENTS.md) (product requirements — the *what*), [DESIGN.md](./DESIGN.md) (data model — the *data*), [IMPLEMENTATION_PHASES.md](./IMPLEMENTATION_PHASES.md) (build sequencing)
**Scope:** Application architecture, API design, background job processing, and deployment/infrastructure shape. This document assumes DESIGN.md v7 and REQUIREMENTS.md v6 as settled source-of-truth and does not re-derive any data-model or product decision made there — it only adds the layer of *how the application is built* on top of that schema and those requirements.

---

## 1. Purpose and Goals

DESIGN.md deliberately excluded "application architecture, API design, and infrastructure deployment" from its scope (DESIGN.md §1, line 4). This document fills that gap: given the finalized entity model and the product requirements, how is the actual server built — what processes run, what API surface the client(s) call, how do background jobs execute, and how is the whole thing deployed for the single self-hosted server (or small cluster) shape both prior documents assume (REQUIREMENTS.md §7; DESIGN.md §1.3)?

### 1.1 Functional goals of this document

- Define the service's internal module boundaries, so the "shared access-check function" DESIGN.md repeatedly references (§3.7, §4.2) and other cross-cutting primitives (`transfer_ownership()`, the quota-update pattern, the cycle-detection lock) have one obvious home each, rather than being reinvented per endpoint.
- Define the HTTP API surface: every endpoint needed to satisfy REQUIREMENTS.md §5, its request/response shape, its authentication/authorization requirements, and which DESIGN.md entities/constraints it touches.
- Define how the five asynchronous mechanisms DESIGN.md specifies at the data level — DELETION_QUEUE, THUMBNAIL_QUEUE, the EFFECTIVE_PERMISSIONS rebuild queue, abandoned-UPLOAD_SESSIONS cleanup, and the 30-day trash purge — are actually executed as running code: what triggers them, what process they run in, how they're supervised, and what happens when they fail.
- Define the deployment topology: what processes exist, how they talk to Postgres and MinIO, and how this composes into something operable on the single-server deployment shape.

### 1.2 Explicit non-goals

Matching DESIGN.md §1.2's approach of stating exclusions explicitly rather than leaving them to be inferred:

- **No re-litigating any data model decision.** If DESIGN.md says PERMISSIONS uses a polymorphic `(item_type, item_id)` pair, this document uses that pair; it does not propose an alternative schema.
- **No re-litigating any product requirement.** If REQUIREMENTS.md says tags are per-user, this document builds an API consistent with that; it does not question whether tags should be shared.
- **No frontend/client design.** This document defines the API contract a client consumes, not the client itself (web UI framework, mobile app, CLI, etc.). REQUIREMENTS.md §3 already excludes a documented public/third-party API from scope — the API defined here is the system's own internal client-server contract, not a publicly documented product.
- **No CI/CD pipeline design, observability/monitoring stack selection, or specific cloud-provider deployment instructions.** These are operational concerns downstream of the architecture defined here; §8 states the deployment *shape* (what processes, what they need) without prescribing a specific hosting provider or pipeline tool.
- **No load testing or capacity planning numbers.** DESIGN.md and REQUIREMENTS.md both frame this as a self-hosted, non-SaaS-scale deployment; this document inherits that framing without attempting to quantify expected request volume.

### 1.3 Technology assumptions

- **Runtime/language:** Node.js with TypeScript. Chosen (system-owner specified) over Python/FastAPI or Go primarily for stack unification if the client is also JS/TS, and for TypeScript's ability to share type definitions for API request/response shapes between server and client without a separate schema-generation step.
- **HTTP framework:** **Fastify**, not Express. Rationale, since the system owner left the specific framework open within "Node.js/TypeScript": Fastify has first-class JSON Schema-based request/response validation and serialization built in, which matters here because so much of REQUIREMENTS.md §5.12's error-feedback requirement and DESIGN.md's many precisely-specified constraints (quota vs. permission error distinction, path-length limits, name-collision errors) are naturally expressed as schema validation at the API boundary rather than ad hoc checks scattered through handlers. Fastify's built-in schema compilation is also materially faster than Express + a bolted-on validation middleware for a service that will validate on every request. This is a reversible choice — nothing in this document's architecture is Fastify-specific beyond the route-registration and schema-validation layer described in §4.
- **Metadata store:** **Supabase-hosted PostgreSQL** (system-owner specified — supersedes DESIGN.md §1.3's generic "self-hosted PostgreSQL" framing for the *hosting* of the database only; every schema, constraint, and behavioral rule DESIGN.md specifies is unchanged, since Supabase is Postgres). The application connects through Supabase's connection pooler (Supavisor, transaction-pooling mode) for all traffic, including the raw-SQL, lock-sensitive operations in §5 — this is a deliberate choice, not an oversight, and is why DESIGN.md §3.3's `pg_advisory_xact_lock` requirement (transaction-scoped, not session-scoped, specifically because session-scoped locks are unsafe under transaction-mode pooling) is load-bearing here rather than a hypothetical concern; see §1.3.1 below for the full reasoning. **Supabase Auth is deliberately not used** — USERS/SESSIONS remain the custom tables DESIGN.md §3.1–§3.2 specifies, with this application's own password hashing and session model; Supabase is used purely as hosted Postgres, not as an identity provider. **Postgres Row-Level Security is enabled on every table, but with zero policies** (`supabase/migrations/0010_enable_rls.sql`) — this is narrower than it sounds and does not contradict the rest of this section. It exists solely as a deny-by-default backstop against a path this document had not accounted for until it was caught in review: Supabase auto-generates a PostgREST/GraphQL/Realtime API for every table in the `public` schema, reachable via the `anon`/`authenticated` keys *independently of this application's own Fastify API* — a path `access.checkPermission()` never sees and was never designed to gate, since this application never uses Supabase Auth or the `anon` key (previous paragraph). With RLS on and no policies defined, that separate path is denied by default for every table, which is exactly the correct state given nothing in this architecture is meant to use it. This is orthogonal to, not a replacement for, DESIGN.md §4.3's accepted-risk framing ("pure application-layer bypass has no database-level backstop"): the application itself connects using the Supabase **service_role** key, which is configured to bypass RLS unconditionally, so RLS is fully transparent to — and imposes zero authorization logic on — actual application traffic. The shared `access.checkPermission()` function (§3.3 below) remains the sole authorization gate for everything the application does; RLS's only job is closing off the separate anon-key surface, and it must never be used to encode any actual business-logic policy — a genuine future need for anon/authenticated access through Supabase's own API must be satisfied with an explicit, deliberately-written `CREATE POLICY`, never by disabling RLS again. Both this and the Auth decision are stated explicitly because Supabase makes both easy to reach for, and a future contributor unfamiliar with this reasoning could otherwise "helpfully" wire in Supabase Auth, or add RLS policies that duplicate/conflict with `access.checkPermission()`, silently diverging from DESIGN.md's specified model.
- **Database access:** **Prisma** as the primary ORM/query builder for standard CRUD paths (USERS, FOLDERS, FILES, TAGS, FAVORITES, and read paths generally), with **raw parameterized SQL for a specific, deliberately small set of operations** where Prisma's abstractions would fight the design rather than help: the cycle-detection advisory lock (`pg_advisory_xact_lock`), the deferred-constraint ownership transfer, the atomic conditional quota update, and the EFFECTIVE_PERMISSIONS synchronous-fallback resolution. §5 lists exactly which operations require raw SQL and why. This mirrors DESIGN.md's own pattern of using the right tool per-mechanism (e.g., a `BEFORE UPDATE` trigger for quota, a plain `UNIQUE` constraint for owner uniqueness) rather than forcing one abstraction to cover every case.
- **Blob storage:** **MinIO**, self-hosted separately from Supabase (system-owner specified — Supabase's own Storage product, which itself is a managed layer over S3-compatible buckets, is deliberately not used, to keep a single, self-operated object store rather than splitting blob storage across two providers). The official MinIO JS SDK (S3-compatible) is used, only inside the storage-access module (§4.4) — no other module talks to MinIO directly, so `storage_key` non-guessability and bucket-policy assumptions (DESIGN.md §3.4, §4.3) stay enforced in one place.
- **Background job execution:** in-process async workers (system-owner specified — see §7.1 for the concrete mechanism and its trade-offs against a separate worker process, which DESIGN.md's queue-table design would equally support if this decision is revisited later).
- **Deployment shape:** the application process (and MinIO) are self-hosted; the metadata store is Supabase-hosted rather than self-hosted Postgres — a hybrid shape this document treats as a variant of DESIGN.md §1.3's "single server (or small cluster)" framing, not a departure from its non-SaaS-scale assumptions. §8 details what this means concretely for process topology.

#### 1.3.1 Why the transaction-mode pooler is safe here, not just tolerated

DESIGN.md §3.3 (Pass 5, item 1) identifies the exact hazard: a *session*-scoped advisory lock (`pg_advisory_lock`) is tied to the physical backend connection, and a transaction-pooling connection pooler (PgBouncer, or Supabase's Supavisor in transaction mode) can hand that same backend connection to a different, unrelated request the moment the current transaction commits — so a session-scoped lock can leak or be silently dropped from under the code that thinks it still holds it. This is precisely Supabase's default pooling mode. DESIGN.md's own fix for this — `pg_advisory_xact_lock`, which is transaction-scoped and releases automatically at commit or rollback, with no explicit unlock call and no dependency on which physical connection later reuses the backend — was already specified for exactly this reason, independent of which pooler ends up in front of Postgres. Because §5.1 below already commits to `pg_advisory_xact_lock` (never the session-scoped variant) for the cycle-detection lock, and no other mechanism in this document takes an advisory lock, session-mode pooling was never required in the first place — routing every connection, including the lock-sensitive ones, through Supabase's transaction-mode pooler is safe as designed, not merely acceptable as a compromise. The one discipline this places on implementation: **no code path may ever call `pg_advisory_lock`/`pg_advisory_unlock` (the session-scoped functions) anywhere in this codebase** — only `pg_advisory_xact_lock`, enforced by code review, since Postgres itself won't stop a session-scoped call from being added later by someone unaware of this constraint.

---

## 2. Design Process

This document is being drafted as a v1, single-pass initial design — explicitly *not* claiming the adversarial-review maturity DESIGN.md reached after six passes. The system owner's instruction was to match DESIGN.md's rigor as a target, not to falsely claim it has already been achieved. Concretely, this means:

- Every architectural decision below states its rationale and, where a real alternative existed, why it was rejected — the same "why does this exist" discipline DESIGN.md uses, so a future review pass can evaluate the reasoning rather than just the conclusion.
- Known open questions and risks are surfaced explicitly in §10 (mirroring DESIGN.md §7's "Open Items") rather than glossed over.
- This document should go through the same kind of fresh-eyes adversarial review DESIGN.md did before implementation begins in earnest — checking cross-references against REQUIREMENTS.md and DESIGN.md for gaps, checking each fix/decision against the others for regressions, and specifically re-examining anything marked as an open question below.

---

## 3. Service Architecture Overview

### 3.1 Single deployable, internally modular

The application is one deployable Node.js service (not a set of independently deployed microservices) containing three logical layers:

1. **The API layer** — Fastify route handlers, one per REQUIREMENTS.md §5 capability, responsible only for request validation, calling into the domain layer, and shaping the response. Route handlers must not contain business logic themselves (see §3.3's rationale).
2. **The domain layer** — a set of modules, one per DESIGN.md entity cluster (mirroring IMPLEMENTATION_PHASES.md's subcomponent boundaries almost exactly, since that document already did the work of partitioning DESIGN.md's entities into independently-reasoned-about groups), each owning the business rules, constraints, and multi-step operations for its cluster.
3. **The background worker layer** — the in-process async tasks that drive DELETION_QUEUE, THUMBNAIL_QUEUE, the EFFECTIVE_PERMISSIONS rebuild queue, UPLOAD_SESSIONS cleanup, and the 30-day trash purge (§7).

A single deployable was chosen over a microservices split for the same reason DESIGN.md gives for choosing a simpler design across many of its own decisions (e.g., a `role` column instead of an `ADMIN_ROLES` table, §4.2): the deployment target is a single self-hosted server, not a distributed SaaS. Splitting into separately-deployed services would add network calls, separate deployment/versioning coordination, and distributed-transaction concerns (e.g., the move-authorization check in §5.3 needs a consistent view across FOLDERS/FILES and PERMISSIONS in one transaction) with no corresponding benefit at this scale. This can be revisited if the deployment target ever changes — nothing about the domain-layer module boundaries below prevents extracting one later into its own service.

### 3.2 Domain modules (mirrors IMPLEMENTATION_PHASES.md's subcomponent split)

| Module | Owns (DESIGN.md entities) | Primary responsibility |
|---|---|---|
| `accounts` | USERS, SESSIONS | Registration, login/logout, session management, password reset, quota trigger logic, admin-demotion-safety check (REQUIREMENTS.md §4) |
| `filesystem` | FOLDERS, FILES, UPLOAD_SESSIONS | Create/rename/move/list, multipart upload orchestration, cycle detection, path-length/name-normalization enforcement |
| `access` | PERMISSIONS, EFFECTIVE_PERMISSIONS, SHARE_LINKS | The shared access-check function, granting-authority checks, `transfer_ownership()`, public link resolution and password throttling |
| `trash` | soft-delete fields on FOLDERS/FILES, DELETION_QUEUE | Trash/restore, immediate-purge request, the purge worker |
| `organization` | FAVORITES, TAGS, ITEM_TAGS | Favorite/unfavorite, tag CRUD, tag-application, lazy-prune-on-read |
| `previews` | THUMBNAIL_QUEUE, `FILES.thumbnail_status`/`thumbnail_key` | Thumbnail job enqueue, generation worker, restore-triggered regeneration |
| `admin` | (reads across all modules) | Admin-only endpoints; does not own tables, calls into other modules' domain functions with the admin-bypass flag set |
| `audit` | ACTIVITY_LOG | The single write path every other module calls to log an action; also serves admin usage-frequency queries |
| `storage` | (no DB entity — wraps MinIO) | The only module permitted to construct or dereference a `storage_key`/`thumbnail_key` against the object store |

This mapping is deliberately the same partition IMPLEMENTATION_PHASES.md already uses for build sequencing (§2 there), for a specific reason: keeping the module boundary and the build/ownership boundary identical means a team following IMPLEMENTATION_PHASES.md's dependency graph is, without extra translation, also respecting this document's module boundaries — there's no risk of the two documents implying different decompositions of the same system.

**Deviation from IMPLEMENTATION_PHASES.md's grouping:** that document groups "Admin & Audit" as one subcomponent (#6). This document splits it into two modules (`admin`, `audit`) because they have different callers and different natures — `audit` (ACTIVITY_LOG) is written to by nearly every other module on every mutating action, while `admin` is a thin layer of admin-only endpoints that mostly delegate into other modules with a bypass flag. Treating them as one module risked every module importing "the admin module" just to get audit logging, which inverts the intended dependency direction (§3.3).

### 3.3 Dependency direction and the shared access-check function

Modules depend downward only, in this order: `storage` and `audit` (leaf modules, no dependencies on other domain modules) → `accounts` → `filesystem` → `access` → `trash`/`organization`/`previews` (parallel) → `admin`. This mirrors IMPLEMENTATION_PHASES.md §2's dependency graph (Foundation → Core Filesystem → Permissions & Sharing → Trash/Favorites-Tags/Thumbnails → Admin & Audit → Account Lifecycle) exactly — DESIGN.md itself does not describe a module-layering order (its §4 covers only the admin feature's requirements and design decisions, not a dependency graph), so the layering claim here is credited to IMPLEMENTATION_PHASES.md alone, not DESIGN.md.

The one function every module above `access` calls into — and the one piece of this architecture with the highest correctness stakes — is `access.checkPermission(userId, itemType, itemId, requiredRole)`. Per DESIGN.md §3.7 and §4.2, this single function must:

1. Short-circuit to `true` if the acting user's `role = 'admin'` (the admin bypass, DESIGN.md §4.2) — but only for the specific set of operations REQUIREMENTS.md actually grants admins blanket access to (view, and permission/quota/lifecycle changes); it must **not** be used to bypass the granting-authority check in DESIGN.md §3.6, which has its own narrower exemption list (§5.4.2 below).
2. Otherwise attempt EFFECTIVE_PERMISSIONS first (the fast path).
3. Fall back to a synchronous, on-demand recomputation from PERMISSIONS (walking the folder ancestor chain) if the cache row is missing, or if the call site is flagged as security-sensitive (DESIGN.md §3.7's explicit requirement that the cache is never the sole source of truth).

**Why this must be one function, not one-per-module:** DESIGN.md §4.2 states the admin bypass "lives in one shared access-check function... so it's applied consistently rather than re-implemented per endpoint," and separately warns (§4.3) that a forgotten check on any new code path grants unauthenticated-equivalent access, not merely admin-level access, since there is no database-level backstop. Given that risk profile, this document's single highest architectural rule is: **no domain module, route handler, or worker may query PERMISSIONS or EFFECTIVE_PERMISSIONS directly for an authorization decision.** Every authorization decision — including inside the `filesystem` module's own move-authorization check, `organization`'s favorite/tag write checks, and `previews`' generation gating — must call `access.checkPermission()`. This is enforced procedurally (code review checklist, §10 open item) rather than by a language-level access control mechanism, since TypeScript has no way to prevent one module's code from importing another module's Prisma client.

---

## 4. API Design

### 4.1 Conventions

- **Style:** REST-ish JSON over HTTPS. Not a formally documented/versioned public API (REQUIREMENTS.md §3 excludes this from scope) — internal contract between this service and its own client(s), but designed cleanly enough that documenting it publicly later would be a documentation exercise, not a redesign.
- **Base path:** `/api/v1/...`. A version prefix is included from day one even though REQUIREMENTS.md doesn't require a public API, because it costs nothing now and avoids an awkward migration if a documented API is added later (REQUIREMENTS.md §8, deferred future consideration).
- **Auth:** every endpoint except registration, login, password-reset-request/confirm, and public share-link access requires a valid session, presented as an `httpOnly`, `Secure`, `SameSite=Lax` cookie carrying a reference to a SESSIONS row (not the raw refresh token — see §4.2). This is a deliberate choice over a bearer-token-in-header pattern: since REQUIREMENTS.md explicitly excludes a documented third-party API (§3), there's no requirement to support non-browser API clients that would need header-based auth, and cookies avoid the XSS-exposure risk of storing a session token in client-accessible JS storage.
- **Errors:** a consistent envelope — `{ "error": { "code": string, "message": string } }` — with HTTP status codes used semantically (400 validation, 401 unauthenticated, 403 unauthorized, 404 not found or not visible to this user — see the note on 403-vs-404 below, 409 conflict/collision, 422 quota/business-rule violation). REQUIREMENTS.md §5.12 requires the system to "distinguish at minimum between 'insufficient storage quota' and 'insufficient permission'" with a clear, specific reason — `error.code` values (`QUOTA_EXCEEDED`, `INSUFFICIENT_PERMISSION`, `NAME_COLLISION`, `PATH_TOO_LONG`, `NAME_TOO_LONG`, `CYCLE_DETECTED`, and so on, enumerated per-endpoint in §4.3) exist specifically to satisfy this requirement in a machine-checkable way, not just a human-readable `message` string that could drift or be inconsistently worded across endpoints.
- **403 vs. 404 for permission failures on existing items:** when a user requests an item they have no access to at all (not even to know it exists), the API returns **404**, not 403 — returning 403 would confirm the item's existence to a user with zero access, a minor information-disclosure gap DESIGN.md doesn't address (it operates below the API layer) but which this document treats as a default policy for every item-scoped endpoint. When a user has *some* access but not enough for the specific action (e.g., a viewer attempting a write), the API returns **403** with `INSUFFICIENT_PERMISSION`, since the item's existence is already known to them.
- **Pagination:** REQUIREMENTS.md §5.11 requires pagination on every unbounded listing. Cursor-based (opaque `nextCursor` token), not offset-based — chosen because several of these listings (trash, activity log) are backed by the partial/composite indexes DESIGN.md §5.4 defines specifically for ordered scans, and offset pagination degrades badly (and can skip/duplicate rows under concurrent writes) on exactly this kind of continuously-mutating, indexed-scan listing.
- **Idempotency:** mutating endpoints that DESIGN.md or REQUIREMENTS.md describe as needing to tolerate retries (multipart upload part completion, share-link creation, favorite/tag application) accept an optional `Idempotency-Key` header; the server deduplicates using a short-lived key store rather than relying on the client never double-submitting. This is an application-layer safety net layered on top of DESIGN.md's own database-level idempotency guards (e.g., DELETION_QUEUE's partial unique index) — it does not replace them, since a client retry can still race with e.g. two different app-server instances in a way only the database constraint fully closes.

### 4.2 Authentication and session endpoints (`accounts` module)

| Method & Path | Purpose | Notes |
|---|---|---|
| `POST /api/v1/auth/register` | Self-registration | Non-enumerating error on duplicate email (REQUIREMENTS.md §5.1); assigns default quota from system config; never accepts a `role` field from the client — admin is never self-grantable |
| `POST /api/v1/auth/login` | Authenticate, start a session | Issues the session cookie; records `device_info` from `User-Agent` |
| `GET /api/v1/auth/me` | Return the current session's user | **(Added — FRONTEND_DESIGN.md §6.2.)** Closes a real gap: nothing else lets a client re-establish who's logged in after a page refresh without re-submitting credentials, since `/login`'s response is the only other place the user object appears. Requires a valid session cookie; 401 `UNAUTHENTICATED` otherwise, same as every other session-gated endpoint here |
| `GET /api/v1/users/me/storage` | Return the current user's `storage_used_bytes`/`storage_quota_bytes` | **(Added — owner decision.)** Deliberately a separate route from `/auth/me`, not a field bolted onto it: quota needs to be refreshed independently and far more often (after every upload/delete) than identity does, and coupling them would mean re-fetching/re-rendering auth state just to refresh a byte count. Values are returned as strings (`bigint` doesn't survive JSON serialization as a number without precision loss at the sizes this schema allows) |
| `POST /api/v1/auth/logout` | End the current session only | Revokes exactly the current SESSIONS row |
| `GET /api/v1/auth/sessions` | List this user's active sessions/devices | Powers a "manage your devices" UI |
| `DELETE /api/v1/auth/sessions/:sessionId` | Revoke a specific other session | Lets a user log out one device remotely |
| `POST /api/v1/auth/password-reset/request` | Start self-service password reset | Always returns 200 regardless of whether the email exists, same non-enumeration rationale as registration |
| `POST /api/v1/auth/password-reset/confirm` | Complete password reset with a token | Invalidates all existing sessions for that user on success (a password reset is a reasonable signal to force re-login everywhere) |

### 4.3 Filesystem endpoints (`filesystem` module, gated through `access`)

| Method & Path | Purpose | Key checks (cited to source doc) |
|---|---|---|
| `GET /api/v1/folders/:id/contents` | List a folder's direct children (files + folders) | `access.checkPermission(..., 'viewer')`; paginated, default sort name-ascending, supports `sort=modified` (REQUIREMENTS.md §5.11) |
| `POST /api/v1/folders` | Create a folder | Sibling-name collision → 409 `NAME_COLLISION`; NFC-normalize+trim before the uniqueness check (DESIGN.md §3.3); path-length check (REQUIREMENTS.md §5.2) |
| `PATCH /api/v1/folders/:id` | Rename and/or move a folder | Rename: same collision/normalization rule. Move: full two-part authorization (DESIGN.md §3.3/§3.4, REQUIREMENTS.md §5.3) — editor-or-above on both source and destination, owner-only if the move would strip anyone else's access; cycle-detection advisory lock (§5.2 below); `materialized_path` subtree rewrite in the same transaction |
| `DELETE /api/v1/folders/:id` | Soft-delete (trash) a folder and its subtree | Cascades `deleted_at` to the whole subtree in one transaction (DESIGN.md §5.2) |
| `POST /api/v1/files` (multipart init) | Start a multipart upload session | Creates an UPLOAD_SESSIONS row with `target_folder_id`/`target_name`; pre-flight quota check |
| `PUT /api/v1/files/upload-sessions/:id/parts/:partNumber` | Upload one part | Per-part quota increment (DESIGN.md §3.5); re-verify destination validity (REQUIREMENTS.md §5.3 concurrent-mutation guard) |
| `POST /api/v1/files/upload-sessions/:id/complete` | Finalize a multipart upload | Final re-verification of destination/name/quota; transitions `upload_status` to `complete`; enqueues a THUMBNAIL_QUEUE job if `mime_type` qualifies |
| `DELETE /api/v1/files/upload-sessions/:id` | Explicitly cancel an in-progress upload | Same cleanup procedure as expiry (DESIGN.md §3.5) |
| `GET /api/v1/files/:id/download` | Request a download | Issues a short-lived, scoped download URL against `storage_key` after one authorization + `deleted_at IS NULL` check (DESIGN.md §3.4's download-time enforcement rule); the actual byte transfer happens directly against the object store using that URL, not proxied through this API |
| `PATCH /api/v1/files/:id` | Rename and/or move a file | Same rules as folder rename/move |
| `DELETE /api/v1/files/:id` | Soft-delete (trash) a file | |
| `GET /api/v1/search` | Name search across owned + accessible items | Uses the `pg_trgm` GIN indexes (DESIGN.md §5.4); partial, case-insensitive; paginated, no mandated sort order beyond relevance (REQUIREMENTS.md §5.2, §5.11) |

### 4.4 Sharing endpoints (`access` module)

| Method & Path | Purpose | Key checks |
|---|---|---|
| `POST /api/v1/items/:type/:id/permissions` | Grant direct access to another user | Granting-authority check: acting user must be editor-or-above (DESIGN.md §3.6); role can be `viewer` or `editor` only, never `owner`; self-share and share-with-current-owner are no-ops (REQUIREMENTS.md §5.5), not errors |
| `DELETE /api/v1/items/:type/:id/permissions/:userId` | Revoke a direct grant | Must trigger an immediate EFFECTIVE_PERMISSIONS rebuild enqueue (DESIGN.md §3.7) — but the revoking action's own subsequent reads must not rely on that rebuild having completed (REQUIREMENTS.md §5.5's "no acceptable delay" — enforced via the synchronous fallback, not by waiting on the async rebuild) |
| `GET /api/v1/shared-with-me` | List items shared with the current user | Paginated (REQUIREMENTS.md §5.11); resolves through EFFECTIVE_PERMISSIONS/PERMISSIONS, not a separate materialized list |
| `POST /api/v1/items/:type/:id/share-links` | Create a public share link | Same granting-authority check as direct grants (DESIGN.md §3.6); optional `password`, `expiresAt` |
| `DELETE /api/v1/share-links/:id` | Revoke a share link | Only the creator (or an admin) may revoke |
| `GET /api/v1/public/share-links/:token` | Anonymous access to a shared item | No session required; password-attempt throttling (DESIGN.md §3.8) applied here, keyed on the token itself, not the requester; joins `USERS.is_active` on `created_by` (DESIGN.md §3.8's deactivation-check) |
| `POST /api/v1/items/:type/:id/transfer-ownership` | Transfer ownership | Only current owner or admin; routes through `transfer_ownership()` (§5.4.1) |

### 4.5 Trash, favorites, tags, thumbnails (`trash`, `organization`, `previews` modules)

| Method & Path | Purpose | Key checks |
|---|---|---|
| `GET /api/v1/trash` | List the current user's trashed items | Paginated, uses the owner-scoped partial index (DESIGN.md §5.4) |
| `POST /api/v1/trash/:type/:id/restore` | Restore a trashed item | Must fail if a DELETION_QUEUE row already exists for it (DESIGN.md §5.2's restore-eligibility check); falls back to root-level restore per REQUIREMENTS.md §5.4 if the original parent is unavailable or still trashed |
| `DELETE /api/v1/trash/:type/:id` | Permanently delete now ("delete forever") | Enqueues DELETION_QUEUE immediately, bypassing the 30-day window |
| `POST /api/v1/items/:type/:id/favorite` | Favorite an item | Requires viewer-or-above (REQUIREMENTS.md §5.7) |
| `DELETE /api/v1/items/:type/:id/favorite` | Unfavorite | |
| `GET /api/v1/favorites` | List favorites | Lazy-prune-on-read (DESIGN.md §3.11) happens inside this handler |
| `POST /api/v1/tags` | Create a tag | |
| `POST /api/v1/items/:type/:id/tags/:tagId` | Apply a tag | Requires editor-or-above on the item (DESIGN.md §3.12) **and** `tag_id` ownership by the acting user (DESIGN.md §3.12 Pass 6 fix) |
| `DELETE /api/v1/items/:type/:id/tags/:tagId` | Remove a tag | |
| `GET /api/v1/files/:id/thumbnail` | Fetch a thumbnail | 404 if `thumbnail_status != 'ready'` or the file is trashed (REQUIREMENTS.md §5.9); otherwise a short-lived scoped URL, same pattern as file download |

### 4.6 Admin endpoints (`admin` module)

| Method & Path | Purpose | Key checks |
|---|---|---|
| `GET /api/v1/admin/users` | List all users, with usage stats | Admin-only. **Not** an ACTIVITY_LOG `view` trigger — REQUIREMENTS.md §5.10 requires logging only when an admin views another user's *file or folder contents*, not a roster/stats listing; logging every list-view here would over-log relative to that requirement |
| `GET /api/v1/admin/users/:id/files` | Browse a specific user's files/folders | Admin bypass through `access.checkPermission`; logs `view` with `subject_user_id` set (DESIGN.md §3.9) |
| `PATCH /api/v1/admin/users/:id/quota` | Change a user's quota | Rejects negative values (REQUIREMENTS.md §5.6); allowed to go below current usage |
| `PATCH /api/v1/admin/users/:id/role` | Promote/demote admin | Rejects if this would leave zero admins (REQUIREMENTS.md §4) |
| `POST /api/v1/admin/users/:id/deactivate` / `.../reactivate` | Toggle account deactivation | Deactivation: invalidate all sessions immediately, cascade-suspend shares (REQUIREMENTS.md §5.1) |
| `DELETE /api/v1/admin/users/:id` | Admin-initiated account deletion | Routes through the full account-deletion procedure (§5.4.3, DESIGN.md §7 item #6) |
| `DELETE /api/v1/users/me` | Self-service account deletion | Same procedure, forced to the default reassignment policy (REQUIREMENTS.md §5.1.1 — self-service cannot choose a specific replacement owner) |
| `GET /api/v1/admin/stats` | System-wide storage/usage statistics | Aggregates `SUM(storage_used_bytes)`, labeled as an approximation (DESIGN.md §3.10) |
| `GET /api/v1/admin/activity` | Query ACTIVITY_LOG | Paginated; admin-only view across all users |

### 4.7 API rate limiting (owner-added, beyond REQUIREMENTS.md's original deferral)

**Decision (owner-confirmed): general API rate limiting is in scope for this phase**, layered on top of everything else §4 defines, even though REQUIREMENTS.md §3/§8 frames rate limiting broadly as deferred and login-attempt lockout specifically stays deferred per §10 item 5. This section designs the mechanism; it is new relative to the rest of this document, not a restatement of something DESIGN.md or REQUIREMENTS.md already specifies.

**Layer:** a Fastify plugin (`@fastify/rate-limit` or equivalent), registered globally at the API layer (§3.1), not inside individual domain modules — consistent with this document's existing pattern of keeping request-shaping concerns in the API layer and business logic in the domain layer (§3.1's three-layer split). This keeps rate limiting a property of *how a request reaches the domain layer*, not something each module has to remember to apply. **It is not a domain module and is deliberately absent from §3.2's module table** — it has no owned DESIGN.md entities and no business logic, only request-shaping, so it doesn't fit that table's "owns / responsibility" shape; noted here explicitly rather than left for the reader to infer why it's missing there.

**Counter state storage — in-process memory, not Postgres.** Rate-limit counters are kept in the application process's own memory (the standard mode for `@fastify/rate-limit`), not written through Prisma or raw SQL — this is why §6's consolidated Prisma/raw-SQL list doesn't mention this mechanism at all; it uses neither. This choice is directly enabled by, and consistent with, §8.3's single-instance decision: in-memory counters would under-count (or simply not coordinate) across multiple processes, which is exactly the kind of state that breaks under multi-instance deployment. Because multi-instance is explicitly out of scope (§8.3), that failure mode is accepted as moot rather than needing a shared store (e.g., Redis) for counter state — but this is called out explicitly so that if the multi-instance decision is ever revisited, this rate-limiting design must be revisited in the same pass, not assumed to still work unchanged.

**Keying:** per-authenticated-user (by SESSIONS-derived user id) for all authenticated endpoints, since REQUIREMENTS.md's data-integrity and fairness concerns are about a given account's behavior, not a given network address (a shared office IP, or a NAT'd household, would otherwise unfairly throttle multiple distinct users together). For unauthenticated endpoints — registration, login, password-reset request, and public share-link access (§4.2, §4.4) — keying falls back to source IP, since there is no authenticated identity yet; the public share-link password-throttling mechanism (DESIGN.md §3.8) is a separate, already-designed, per-token limiter and is not replaced or duplicated by this general IP-based layer — both apply, in sequence, to a password-protected public link request.

**Scope and limits (defaults, tunable via configuration per §8.2's existing pattern — not fixed requirements):**

| Endpoint class | Suggested limit | Rationale |
|---|---|---|
| Unauthenticated (register, login, password-reset request) | 20 requests / 15 min / IP | Coarse abuse guard; deliberately looser than a dedicated login-lockout mechanism would be, since that specific mechanism (REQUIREMENTS.md §8) remains out of scope — this is general API hygiene, not a substitute for it |
| Authenticated, general (most of §4.3–§4.6) | 300 requests / min / user | High enough not to interfere with normal UI usage (folder listings, search-as-you-type, etc.) |
| Authenticated, write-heavy (folder/file create, move, share, tag) | 60 requests / min / user | Tighter bound on mutation volume specifically, separate from the general read-heavy ceiling above |
| Multipart upload part endpoints (§4.3) | Excluded from the general per-minute counters, bounded instead by `UPLOAD_SESSIONS.total_parts` and the upload session's own lifecycle (DESIGN.md §3.5) | A large legitimate upload can exceed a generic per-minute request count without being abusive; the existing session/quota mechanism is the correct control here, not a request-rate limiter layered on top of it |

**Response on limit exceeded:** HTTP 429, using the same error envelope as §4.1 (`{ "error": { "code": "RATE_LIMITED", "message": "..." } }`), with a `Retry-After` header — this is an addition to §4.1's error-code list, not a new envelope shape.

**Explicit non-goal of this addition:** this is a coarse, general-purpose API-abuse guard, not a replacement for REQUIREMENTS.md §8's deferred login-lockout feature (which would need to track failed-attempt *outcomes*, not just request volume, and would need account-level state analogous to SHARE_LINKS' `failed_password_attempts` pattern in DESIGN.md §3.8). If login lockout is picked up later, it is a distinct, additional mechanism layered on top of this one, not a superset this section already provides.

---

## 5. Cross-Cutting Application-Layer Mechanisms

This section is the application-layer counterpart to DESIGN.md §5 ("Cross-Cutting Design Patterns") — for each pattern DESIGN.md specifies at the data level, this section states exactly which module implements it, in what code shape, and using which of the two data-access strategies from §1.3 (Prisma vs. raw SQL).

### 5.1 The cycle-detection advisory lock (`filesystem` module)

DESIGN.md §3.3 calls this "the single highest-risk item flagged across three review passes" and specifies the exact locking requirement: `pg_advisory_xact_lock` (transaction-scoped, not session-scoped) on both the moved subtree's root and the target parent's own node id, in canonical sorted order, before the ancestor-walk cycle check runs.

**Implementation:** this must be raw SQL inside a single Prisma `$transaction` callback using `$queryRaw`, not a Prisma-modeled operation. Concretely:

```
BEGIN;
SELECT pg_advisory_xact_lock(least(hashtext($subtreeRoot), hashtext($targetParent)),
                              greatest(hashtext($subtreeRoot), hashtext($targetParent)));
-- ancestor-walk cycle check (recursive CTE or materialized_path prefix check)
-- move-authorization check (§5.3 below)
-- UPDATE FOLDERS SET parent_folder_id = ..., materialized_path = ... WHERE id = $subtreeRoot;
-- UPDATE FOLDERS SET materialized_path = ... WHERE materialized_path LIKE $oldPrefix || '%'; -- subtree rewrite
COMMIT;
```

**Why raw SQL and not Prisma's query builder:** `pg_advisory_xact_lock` has no Prisma-native representation, and even if it did, the requirement that the lock, the cycle check, the authorization check, and both `UPDATE`s all happen inside one transaction with the lock acquired *first* is exactly the kind of ordering-sensitive, must-not-be-abstracted-over operation where an ORM's automatic transaction management could silently reorder or split statements across round-trips in a way that reopens the race DESIGN.md's Pass 3/5/6 fixes closed. This is flagged again in §10 as the single highest-priority item for adversarial review of this document, mirroring DESIGN.md's own treatment of the underlying mechanism.

**Advisory lock key collision risk:** `hashtext()` on a UUID string is used to fold a 128-bit id into the 32-bit (or 64-bit, via the two-argument form used above) key space `pg_advisory_xact_lock` accepts. This introduces a theoretical hash-collision false-positive (two unrelated folders serializing against each other unnecessarily) but no false-negative risk (two operations that *should* serialize will always share a lock key if their ids match, since the hash is deterministic) — an acceptable trade-off flagged here rather than silently assumed, since DESIGN.md's own text (§3.3) discusses the locking *strategy* but not the mechanics of turning a UUID into an advisory-lock integer key.

### 5.2 The atomic conditional quota update (`accounts` module, called by `filesystem`)

DESIGN.md §3.1 and §5.3 require this to be a conditional update, not read-then-write, to avoid two concurrent uploads both reading a stale `storage_used_bytes`. Implementation: a single `UPDATE ... WHERE storage_used_bytes + $delta <= storage_quota_bytes RETURNING storage_used_bytes` (raw SQL via `$queryRaw`, for the same "no ORM round-trip splitting" reason as §5.1) — zero rows returned means the quota would be exceeded, which the calling code (in `filesystem`, for upload-part completion; in `trash`'s DELETION_QUEUE worker, for credit-back) treats as a rejection, mapped to the `QUOTA_EXCEEDED` API error code (§4.1). This same primitive is reused for the per-part multipart increment (DESIGN.md §3.5) and the DELETION_QUEUE worker's credit-back decrement — one function, `accounts.adjustStorageUsed(userId, deltaBytes)`, used everywhere `storage_used_bytes` changes, so there is exactly one place implementing DESIGN.md's "must only fire when `storage_used_bytes` increases" trigger-equivalent logic (an admin lowering `storage_quota_bytes` below current usage does not go through this function at all — it's a direct `UPDATE` on `storage_quota_bytes` alone, unconstrained, per DESIGN.md §3.1).

### 5.3 The move-authorization check (`access` module, called by `filesystem`)

Implemented as `access.checkMoveAuthorization(userId, itemType, itemId, destinationFolderId)`, called from inside the same transaction as §5.1's lock/cycle-check (for folders) or directly (for files, which have no cycle risk but the identical two-part authorization rule per DESIGN.md §3.4). It performs, in order: (a) `access.checkPermission(userId, ..., 'editor')` against both the item and the destination; (b) if either fails, reject with `INSUFFICIENT_PERMISSION`; (c) otherwise, compute the resolved-user-set at the current location vs. the resolved-user-set the destination would produce (both via EFFECTIVE_PERMISSIONS with synchronous fallback, per DESIGN.md §3.7) and, if any user other than the mover would lose access, additionally require the mover to be the item's owner. This function is the one and only call site for this specific two-part rule — it is not duplicated between the folder-move and file-move handlers.

### 5.4 Ownership and account-lifecycle procedures (`access` and `admin` modules)

#### 5.4.1 `transfer_ownership()`

A single database function (Postgres `PL/pgSQL`, invoked via `$queryRaw`, not reimplemented in application code) is the only code path permitted to change a PERMISSIONS `owner` row, per DESIGN.md §3.6's explicit requirement ("No code path — including admin actions — should ever `UPDATE`/`DELETE`/`INSERT` PERMISSIONS rows to change ownership except through this single routine"). Implementing this as a database function rather than an application-layer transaction was chosen specifically because DESIGN.md ties correctness here to the `DEFERRABLE INITIALLY DEFERRED` constraint's commit-time check (§3.6) — keeping the demote/promote pair and the constraint they satisfy in the same PL/pgSQL function makes it impossible for application code to insert other statements between the two writes within the same transaction, which a purely application-level "two Prisma calls in a `$transaction` block" pattern would not prevent (nothing stops a future engineer from adding a third statement in between).

#### 5.4.2 `reassign_all_owned_items()`

The bulk variant DESIGN.md §7 item #1 flags as needing full specification. Implemented as a second PL/pgSQL function that, within one transaction, calls `transfer_ownership()` once per item the departing user owns, then — per the granting-authority check's exemption #2 (DESIGN.md §3.6) — is the one place in the codebase permitted to invoke `transfer_ownership()` without the acting user holding prior access on each item, gated by an internal-only flag (not client-reachable) that only the account-deletion procedure below sets.

#### 5.4.3 Account deletion procedure

Implemented as `accounts.deleteAccount(userId, { replacementOwners? })`, following DESIGN.md §7 item #6's step ordering exactly: (1) `reassign_all_owned_items()`; (2) `accounts.revokeAllSessions(userId)`; (3) the single `DELETE FROM USERS WHERE id = $userId` statement, whose cascades (SHARE_LINKS, PERMISSIONS-as-grantee, TAGS→ITEM_TAGS, FAVORITES) are database-level `ON DELETE CASCADE` per DESIGN.md and therefore **not** separately implemented in application code — this function must not re-delete those rows itself, only trigger the one statement and then, for step (c)'s side effect, enqueue an EFFECTIVE_PERMISSIONS rebuild for every item that had a PERMISSIONS-as-grantee row just cascade-deleted (DESIGN.md §7 item #6(c)'s explicit requirement that the cascade alone doesn't update the derived cache). ACTIVITY_LOG rows referencing the deleted user are left untouched (DESIGN.md §7 item #6(f)) — `audit` module writes already snapshot a display name into `metadata` at write time for this reason, per that same section.

Both the self-service (`DELETE /api/v1/users/me`) and admin-initiated (`DELETE /api/v1/admin/users/:id`) endpoints call this same function — the only difference is that self-service always omits `replacementOwners` (forcing the default-admin-reassignment policy, REQUIREMENTS.md §5.1.1), while the admin path may supply explicit per-item replacement owners.

---

## 6. Data Access Strategy: Prisma vs. Raw SQL — Consolidated List

Gathering the raw-SQL requirement scattered through §5 into one place, for the same reason DESIGN.md consolidates its indexing requirements into one list at §5.4 rather than leaving them scattered through §3 — a future implementer or reviewer should be able to check this list once rather than re-derive it from every mechanism's individual description.

**Must be raw parameterized SQL (`$queryRaw`/`$executeRaw` inside a single Prisma `$transaction`), never Prisma's query builder:**

- The cycle-detection advisory lock sequence (§5.1) — lock, cycle check, authorization check, and both `materialized_path` updates, one transaction, lock acquired first.
- The atomic conditional quota update (§5.2) — `UPDATE ... WHERE ... RETURNING`, single round trip.
- `transfer_ownership()` and `reassign_all_owned_items()` (§5.4.1, §5.4.2) — implemented as PL/pgSQL functions, called via `$queryRaw('SELECT transfer_ownership($1, $2, $3, $4)', ...)`.
- The EFFECTIVE_PERMISSIONS synchronous-fallback ancestor walk, when the cache misses (DESIGN.md §3.7) — a recursive CTE over `materialized_path`, not something Prisma's relational query API expresses efficiently.
- The DELETION_QUEUE and THUMBNAIL_QUEUE claim step (`UPDATE ... SET status = 'processing' WHERE status = 'pending' ... LIMIT N FOR UPDATE SKIP LOCKED RETURNING ...`) — `SKIP LOCKED` has no Prisma equivalent and is required (§7.2) to let multiple in-process worker ticks claim disjoint rows safely.

**Everything else** — USERS/SESSIONS CRUD, FOLDERS/FILES simple reads and non-move writes, PERMISSIONS grant/revoke (outside of ownership), FAVORITES, TAGS/ITEM_TAGS, ACTIVITY_LOG writes and admin queries, SHARE_LINKS CRUD outside the password-throttle counters — is ordinary Prisma model access, since none of it has the same single-transaction/race-sensitive/lock-ordering requirements as the operations above.

---

## 7. Background Workers

### 7.1 Execution model: in-process async tasks

Per the system owner's specification (§1.3), all five asynchronous mechanisms run as scheduled async tasks inside the same Node.js process as the API server, using `setInterval`-driven polling loops (one per queue/job type) rather than a separate worker process or an external job-queue system (e.g., BullMQ/Redis).

**Trade-offs, stated explicitly since this is a real design choice with real consequences, not a default:**

- **Pro:** simplest possible deployment — one process, no additional infrastructure component (no Redis, no separate worker fleet to deploy/monitor), consistent with the single-server deployment shape both prior documents assume. Matches DESIGN.md §5.3's own framing that these mechanisms don't prescribe "any particular tool," only that they be asynchronous, decoupled, and retryable.
- **Con:** the worker loops and the API request handlers compete for the same event loop and the same database connection pool. A burst of API traffic can delay a worker tick (and vice versa — a long-running purge batch could add latency to concurrent API requests if not chunked carefully, see §7.3). This is judged acceptable at the stated deployment scale (self-hosted app, non-SaaS, DESIGN.md §1.3) but is the main reason §10 flags this as worth revisiting if the deployment target ever changes.
- **Con, specific to Supabase's pooler (§1.3):** Supabase's transaction-mode pooler (Supavisor) holds a pooled backend connection only for the duration of one transaction, then returns it — a worker tick that claims a batch via `SKIP LOCKED` (§7.2) and then processes each row slowly (e.g., a MinIO round-trip per DELETION_QUEUE row) inside one long transaction would hold that pooled connection, and its lock, for the whole batch, reducing the pool's effective capacity for concurrent API requests during that window. The mitigation is structural, not configuration: each worker's per-row processing (§7.2 step 3) must commit its own row's transaction before moving to the next claimed row, rather than processing an entire claimed batch inside one transaction — the claim step (`SKIP LOCKED`) and each row's processing step are already described as separate steps in §7.2, and this is the reason that separation matters, not just a stylistic choice.
- **Con:** a process crash or restart (deploy, crash-loop) stops both the API and every background worker simultaneously — there is no independent worker availability. DESIGN.md's queue-table design (durable rows in Postgres, not in-memory state) means no work is *lost* on a restart — every `pending` row is still there and gets picked up again — but there is a window of zero background processing during any restart. Acceptable for a self-hosted single-server deployment where some downtime during a deploy is already an accepted characteristic, but stated here rather than left implicit.
- **Migration path if this is revisited:** because every worker's actual logic (§7.2–§7.6 below) is written as a plain async function taking a Postgres connection/Prisma client, extracting these into a separate worker process later (or moving to an external queue) would only require changing *what schedules* the function call, not the function bodies themselves — the polling-loop wrapper is a thin, swappable layer specifically so this decision doesn't lock in a large rewrite later.

### 7.2 Common worker shape

Every worker (DELETION_QUEUE, THUMBNAIL_QUEUE, EFFECTIVE_PERMISSIONS rebuild, UPLOAD_SESSIONS cleanup, 30-day trash purge) follows the same shape, to avoid five subtly-different retry/claim implementations:

1. A `setInterval` tick (interval configurable per-worker; see §7.7 for suggested defaults) calls a `claimBatch(limit)` function.
2. `claimBatch` runs `UPDATE <queue_table> SET status = 'processing' WHERE id IN (SELECT id FROM <queue_table> WHERE status = 'pending' ORDER BY enqueued_at LIMIT $limit FOR UPDATE SKIP LOCKED) RETURNING *` — raw SQL (§6), because `SKIP LOCKED` is what makes it safe for this pattern to run concurrently with itself if a slow tick is still processing a prior batch when the next interval fires (an in-process safeguard also prevents overlapping ticks for the same worker, per §7.3, but the database-level guard is the one that actually matters if that safeguard is ever bypassed or removed).
3. Each claimed row is processed individually, wrapped in a `try`/`catch`; success moves it to `done`, a retryable failure increments `attempts` and moves it back to `pending`, and exceeding the configured max-attempts moves it to `failed` (DESIGN.md §3.10's retry policy, applied identically to §3.13's).
4. A `failed` row is surfaced via the admin "failed deletions" view (DESIGN.md §3.10) — `GET /api/v1/admin/failed-jobs`, added here as an endpoint not explicitly listed in §4 since it wasn't a REQUIREMENTS.md-level user-facing capability, only an operational necessity DESIGN.md itself calls for.

### 7.3 Overlap prevention within one process

Because all workers share one process, an explicit in-memory guard (a simple boolean-per-worker "tick in progress" flag, checked and set before each `claimBatch` call) prevents a worker's own next scheduled tick from starting while a prior tick (e.g., a large purge batch) is still running — this is a scheduling courtesy to avoid unbounded concurrent ticks piling up under load, distinct from and layered on top of the database-level `SKIP LOCKED` guard in §7.2, which protects correctness; this in-memory flag only protects the single process's own resource usage.

### 7.4 EFFECTIVE_PERMISSIONS rebuild worker — the one worker with an ordering requirement

DESIGN.md §3.7 (Pass 6 fix) requires this worker specifically to discard a job whose triggering-event timestamp is older than the target row's current `recomputed_at`, rather than blindly overwriting — the generic `claimBatch`/process/`done` shape in §7.2 is extended for this worker only: before writing a recomputed EFFECTIVE_PERMISSIONS row, the worker re-checks `recomputed_at` against the job's own carried event timestamp and no-ops (marks `done` without writing) if the existing row is already newer. This is the one place across all five workers where "processed" and "had an effect" are allowed to diverge, and is called out explicitly here so it isn't lost inside the shared §7.2 template.

### 7.5 THUMBNAIL_QUEUE worker — the one worker with a late re-check

Per DESIGN.md §3.13's orphaned-blob fix, this worker must re-check `FILES.deleted_at IS NULL` immediately before writing the generated thumbnail blob — not only at claim time. Implemented as a second, cheap `SELECT deleted_at FROM FILES WHERE id = $fileId` immediately preceding the MinIO `putObject` call inside the per-row processing step (§7.2 step 3), not merged into the initial claim query, since the whole point is to catch a deletion that happened *during* the (potentially slow) thumbnail-rendering step between claim and write.

### 7.6 Scheduled (time-based) vs. event-triggered workers

DELETION_QUEUE and THUMBNAIL_QUEUE are populated by two different triggering styles that this document's worker model must support side by side:

- **Event-triggered enqueue:** an API request handler (e.g., trash/delete, or upload-completion) inserts a `pending` row directly, inside the same transaction as the triggering write, so the enqueue can never be lost to a crash between the write and the enqueue.
- **Time-triggered enqueue:** the 30-day trash purge has no single triggering event — it's a separate `setInterval` tick (suggested: hourly) that queries `FILES`/`FOLDERS` for `deleted_at` older than 30 days with no existing `pending`/`processing` DELETION_QUEUE row (DESIGN.md §5.2's reworked per-item-clock mechanism) and inserts the missing rows, after which those rows flow through the exact same `claimBatch`/process/`done` pipeline as any explicitly-enqueued row — there is no separate "purge worker" distinct from the DELETION_QUEUE worker; the 30-day job's only job is populating the same queue table.
- Similarly, UPLOAD_SESSIONS cleanup (§3.5) is a time-triggered scan (suggested: every 5 minutes) for `status = 'pending' AND expires_at < now()`, performing the abort-and-credit-back procedure directly (it has no separate queue table of its own to enqueue into — DESIGN.md models this as a direct state transition on UPLOAD_SESSIONS itself, not a queue).

### 7.7 Suggested polling intervals

Stated as defaults, not requirements — none of REQUIREMENTS.md or DESIGN.md mandates a specific interval, and these are tunable via configuration:

| Worker | Interval | Rationale |
|---|---|---|
| DELETION_QUEUE | 10s | User-visible latency for "delete forever" completing; also processes 30-day-purge-populated rows |
| THUMBNAIL_QUEUE | 5s | Thumbnails are a UX nicety users notice quickly if slow |
| EFFECTIVE_PERMISSIONS rebuild | 2s | Cache staleness window — kept short even though the synchronous fallback (DESIGN.md §3.7) means correctness never depends on this being fast |
| UPLOAD_SESSIONS cleanup | 5 min | Abandoned-upload cleanup is not user-latency-sensitive |
| 30-day trash purge scan | 1 hour | A day-granularity deadline doesn't need sub-hour polling precision |

### 7.8 The reconciliation/repair job — not yet designed here either

DESIGN.md §5.3 and §7 item #2 flag, as an explicitly deferred (not forgotten) item, a periodic job to detect drift between the three denormalized values (`storage_used_bytes`, `materialized_path`, EFFECTIVE_PERMISSIONS) and their source-of-truth tables — DESIGN.md itself never specified this job, only named the need for one. This document's worker model (§7.1–§7.7) is built around the five mechanisms DESIGN.md *did* fully specify (DELETION_QUEUE, THUMBNAIL_QUEUE, EFFECTIVE_PERMISSIONS rebuild, UPLOAD_SESSIONS cleanup, 30-day purge) and does not extend that model to cover reconciliation, since there is nothing yet to schedule — no target drift-detection query or repair procedure has been designed, here or in DESIGN.md. IMPLEMENTATION_PHASES.md §2 already anticipates this as its own subcomponent (#9, "Reconciliation & Repair Job," explicitly sequenced last), so this is not a gap this document introduces — it inherits an already-acknowledged open item rather than silently dropping it. Flagged explicitly here (and in §10) so it isn't mistaken for coverage this document doesn't actually provide: when that job is designed, it fits the same `setInterval`-driven in-process worker shape as §7.1–§7.2 describe (a long-interval tick, e.g. daily, comparing derived values against a recomputation and either correcting or flagging drift), but the specific comparison logic and correction/flagging policy are new design work, not something this document's existing worker template already covers by extension.

---

## 8. Deployment and Infrastructure Shape

### 8.1 Process topology

**Owner decision: hosted on a single Ubuntu server, Docker wherever possible.** This supersedes this section's earlier framing — the application is no longer described as one undifferentiated "self-hosted runtime process" but as containerized services on that host, per FRONTEND_DESIGN.md §7's now-Docker-specific deployment section (that document owns the concrete `docker-compose.yml`/Dockerfile detail; this section states the resulting shape from the backend's point of view):

1. **The application (backend) process, containerized** — the single Node.js/Fastify deployable described in §3, containing the API layer, all domain modules, and all background workers (§7), built and run as a Docker image (root `Dockerfile`) rather than a bare Node process on the host. **Runs as a single container/instance — multi-instance deployment is explicitly out of scope for this design (§8.3, owner-confirmed)**, consistent with "Docker wherever possible" being a packaging/operability decision, not a move toward horizontal scaling.
2. **The frontend, containerized separately** — FRONTEND_DESIGN.md's Next.js application, its own image (`web/Dockerfile`), a distinct container from the backend, communicating with it over the Docker Compose network by service name (`http://backend:3000`) rather than `localhost` — the two are different containers, not two processes sharing a host network namespace the way local (non-Docker) development runs them.
3. **MinIO, also a container** — self-hosted, as specified by §1.3, run as the official `minio/minio` image alongside the two application containers, orchestrated by the same `docker-compose.yml` rather than provisioned separately. The sole blob store, reachable only from the `storage` module (§3.2), never directly from a client — download/thumbnail URLs are short-lived, scoped, presigned MinIO URLs generated by the application, not raw bucket exposure. **Not yet consumed by any code** — the `storage` module that will actually talk to it is part of Subcomponent 1 (Core Filesystem), not yet built; the container and its credentials exist in the compose topology now so they're already in place when that module lands.
4. **Supabase-hosted PostgreSQL — deliberately NOT containerized**, and not part of this Docker topology at all. It remains externally managed by Supabase (§1.3), reached exclusively through Supabase's connection pooler (§1.3.1) from the backend container — no direct/unpooled connection string is used anywhere in this design, including for the lock-sensitive raw-SQL operations in §5, since §1.3.1 establishes that the pooler is safe for those by construction. "Docker wherever possible" does not mean "Docker for Postgres too" — Supabase's hosting is a separate, already-settled decision (§1.3) this one doesn't reopen.

Four containers total (backend, frontend, minio, plus a one-shot `minio-init` that creates the app's bucket and exits), one externally-managed database. Concretely verified, not just designed on paper: all three long-running containers were built and brought up together via `docker compose up`, and a full login round trip (`POST /auth/login` → session cookie → `GET /auth/me`) was exercised through the frontend container's reverse proxy to the backend container, confirming the cross-container network path and cookie handling both work as designed.

**A real bug found only by actually running the built containers, not by reasoning about the config:** `next.config.js`'s `rewrites()` (FRONTEND_DESIGN.md §7) is evaluated once at `next build` time to produce Next's routes manifest — it is **not** re-read per-request at runtime. Setting `BACKEND_URL` as a Docker Compose runtime `environment:` variable therefore has no effect on an already-built image; the proxy kept resolving to `localhost:3000` (baked in from the environment the image happened to be built in) even though `printenv` inside the running container correctly showed `BACKEND_URL=http://backend:3000`. Fixed by making `BACKEND_URL` a Docker **build** argument (`web/Dockerfile`'s `ARG BACKEND_URL`, `docker-compose.yml`'s `build.args`) instead of a runtime environment variable — the frontend image is therefore specific to this compose topology (baked to expect the backend at `backend:3000`), which is fine since it's always deployed via this same `docker-compose.yml`, not reused across differently-shaped deployments.

### 8.2 Configuration

Environment-variable-driven configuration (12-factor style) for: the Supabase pooled-connection string (project ref, pooler host/port, and credentials — never the direct-connection string, per §8.1 item 4), MinIO endpoint/credentials/bucket name, session cookie signing secret, default new-user quota (REQUIREMENTS.md §5.1's "system-wide configuration" requirement), password-reset token TTL, worker polling intervals (§7.7's defaults, overridable), rate-limit thresholds (§4.7's per-endpoint-class limits table, overridable per class rather than as one global number), and the bootstrap-first-admin mechanism (REQUIREMENTS.md §5.1) — implemented as a one-time CLI command (`npm run bootstrap:admin`, runnable inside the deployed backend container via `docker compose exec backend`) run against the deployed database rather than an environment flag left permanently set, so there's no standing configuration that could be accidentally left enabled and allow repeated admin bootstrapping. Secrets (the Supabase connection string, MinIO root credentials) are supplied via a `.env` file read by `docker-compose.yml` at the repo root, gitignored, never baked into either image — the one exception being `BACKEND_URL` itself (§8.1's build-arg fix above), which is topology configuration, not a secret.

### 8.3 Multi-instance — decided out of scope

**Decision (owner-confirmed): the application process runs as a single instance. Multi-instance deployment is explicitly out of scope for this design.** This resolves what was previously an open caveat: §7.3's in-memory overlap-prevention flag being per-process rather than fleet-wide is a non-issue under this decision, since there is only ever one process. The `SKIP LOCKED` claim query in §7.2 would have kept multi-instance correctness intact regardless (it's instance-count-agnostic by design), but that safety net is now moot rather than merely unexercised. If the deployment target ever changes to require more than one instance, §7.3's flag and the worker-scheduling model in §7.1 would need revisiting (most likely a Postgres-advisory-lock-based single-leader-election for tick *scheduling*, not row claiming) — but that is future work triggered by a future decision, not a present gap.

### 8.4 Backups and the two-store consistency question — decided out of scope for now

**Decision (owner-confirmed): no backup/restore design is done in this phase.** The operator's stated plan is to duplicate the object store at the database layer at a later time — i.e., a future redesign that stores blob content (or a replicated copy of it) inside the same transactional boundary as the metadata, rather than solving today's two-independent-stores backup/restore gap as a bolt-on reconciliation mechanism. Until that redesign happens, Postgres (Supabase-managed) and MinIO (self-hosted) remain two independently-backed-up stores with no cross-store transaction, and the orphaned-reference/orphaned-blob risk across a backup/restore boundary described in the prior draft of this section is accepted, not mitigated, for this phase. This is a deliberate scope decision, not an oversight — recorded here so a future reader doesn't mistake the current design's silence on backup/restore for an unnoticed gap.

---

## 9. Consistency Check Against REQUIREMENTS.md and DESIGN.md

A deliberate self-check pass — walking REQUIREMENTS.md §5 section by section and confirming this document has a corresponding mechanism — rather than assuming coverage:

- §5.1 Accounts/Access → §4.2, §7.6 (session invalidation on deactivation via `accounts.revokeAllSessions`, called from `admin`'s deactivate endpoint, not yet explicitly cross-referenced above — noted as a gap closed here: the deactivate endpoint in §4.6 must call the same `revokeAllSessions` primitive §5.4.3 uses for deletion).
- §5.1.1 Account Deletion → §5.4.3.
- §5.2 Folders, §5.3 Files → §4.3, §5.1, §5.3.
- §5.4 Trash → §4.5, §7.6.
- §5.5 Sharing → §4.4, §5.3, §5.4.1.
- §5.6 Quotas → §5.2.
- §5.7 Favorites → §4.5.
- §5.8 Tags → §4.5.
- §5.9 Thumbnails → §4.5, §7.5.
- §5.10 Administration → §4.6.
- §5.11 Listing/pagination → §4.1 (cursor-based, applied per-endpoint in §4.3–§4.6).
- §5.12 Error feedback → §4.1's error envelope and code list.
- §5.13 Activity logging → the `audit` module (§3.2), called from every mutating handler — **not yet given its own dedicated subsection above**, flagged in §10.

**One correction made during this check:** the deactivation endpoint (§4.6) as originally drafted didn't explicitly state it calls `accounts.revokeAllSessions` — corrected in the bullet above. This is exactly the kind of gap DESIGN.md's own multi-pass process (§2 there) was built to catch, and its discovery here during a first self-check (rather than a later, separate review pass) is a data point for §10's "how much review this document still needs" question, not evidence the document is already sufficiently reviewed.

---

## 10. Open Items for the Next Design Phase

Mirroring DESIGN.md §7's structure — explicitly separating what's settled from what still needs resolution, so this document doesn't overstate its own maturity.

1. **This document has undergone one review pass (v1), but v2's Supabase revision (§1.3, §1.3.1, §8) has not itself been separately reviewed.** DESIGN.md reached its current state only after six passes, several of which found genuine, non-cosmetic bugs (the advisory-lock scope error, the granting-authority gap) that a single confident-sounding draft did not catch on its own — and DESIGN.md's own Pass 6 round 2 exists specifically because a *prior* pass's fixes needed their own regression check, which is exactly the situation v2 is now in relative to v1. Before implementation, this document should get a pass specifically re-checking §1.3.1's pooler/advisory-lock reasoning and §8's revised topology against the rest of the document (e.g., does anything in §5–§7 implicitly assume a directly-managed Postgres instance that the Supabase move invalidates?), plus the broader fresh-eyes pass against REQUIREMENTS.md and DESIGN.md together that v1 already received once.
2. **The `audit` module's write path is named but not designed.** §3.2 lists it, §9 flags that it has no dedicated subsection. It needs: where in each handler the log write happens (before or after the main operation commits — almost certainly must be in the same transaction, given ACTIVITY_LOG's audit-integrity purpose, but this hasn't been stated), and how "an admin viewing another user's files" (REQUIREMENTS.md §5.10) is batched into one `view` row per browsing session rather than per-request (DESIGN.md §3.9 specifies the *what*; this document hasn't yet specified the *how*, e.g. a session-scoped debounce).
3. **The advisory-lock-key hash-collision trade-off (§5.1)** is stated but not quantified — worth a brief analysis of whether `hashtext()`'s collision rate at expected folder-count scale is truly negligible, or whether a wider key (e.g., splitting the UUID into two 32-bit halves fed to the two-argument lock function, rather than hashing) would be safer with no real cost.
4. ~~**The two-store backup/restore consistency question (§8.4)** is flagged, not resolved.~~ **Resolved (decided out of scope for now, §8.4):** owner-confirmed — no backup/restore mechanism is designed in this phase; the operator's stated future plan is to duplicate the object store at the database layer rather than bolt on a reconciliation mechanism for the current two-store split. Removed from open items.
5. ~~**Rate limiting**~~ **Partially resolved, split in two:** **login-attempt throttling** stays deferred exactly as REQUIREMENTS.md §3/§8 states — owner-confirmed, no change. **General API rate limiting**, however, is now pulled into scope for this phase (owner-confirmed, reversing the initial "stay deferred" default) — see the new §4.7 for its design. This is a deliberate, scoped addition to REQUIREMENTS.md's stated non-goals: REQUIREMENTS.md §3/§8 frames rate limiting broadly as deferred, but the owner has now specifically requested API-level throttling be designed now, while leaving login-attempt lockout (a related but distinct mechanism, per the original open-item split) deferred. This document does not amend REQUIREMENTS.md itself — that document still lists rate limiting under deferred non-goals — but this application-layer design now includes the mechanism as an owner-directed addition on top of it.
6. ~~**Multi-instance deployment (§8.3)**~~ **Resolved (decided out of scope, §8.3):** owner-confirmed — single-instance only. Removed from open items; §7.3's per-process overlap-prevention flag is sufficient as designed, with no leader-election mechanism needed.
7. **API request/response JSON Schemas themselves are not written out** — §4 defines the endpoint inventory and the checks each performs, but not the literal field-level schema for each request/response body. That's the natural next drafting step once this document's higher-level shape is reviewed and confirmed, to avoid rework if the endpoint list itself changes during review.
8. **The reconciliation/repair job (§7.8) has no design here** — this document's worker model covers the five mechanisms DESIGN.md fully specified, but not the drift-detection/repair job DESIGN.md §7 item #2 leaves open. IMPLEMENTATION_PHASES.md already anticipates this as its own subcomponent (#9), sequenced last — this document should get a §7.8-equivalent full design (target queries, correction vs. flag-only policy, scheduling) once subcomponents 1–7 are stable enough to know what "drift" actually looks like in practice, consistent with IMPLEMENTATION_PHASES.md's own sequencing rationale for building it last.

---

*This document is a first-pass application-layer design intended to sit alongside DESIGN.md and REQUIREMENTS.md as a complete picture of the system (data model, product requirements, and now application architecture). It should not be treated as final — see §10 — and the next step is the same kind of adversarial review DESIGN.md underwent, followed by writing out the concrete API schemas §10 item #7 flags as not yet done.*
