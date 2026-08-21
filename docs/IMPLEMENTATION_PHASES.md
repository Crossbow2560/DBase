# DBase — Implementation Phase Breakdown

**Status:** Draft v1
**Related docs:** [DESIGN.md](./DESIGN.md) (data model), [REQUIREMENTS.md](./REQUIREMENTS.md) (product requirements)
**Purpose:** Break the implementation phase into subcomponents that can be built, tested, and reviewed largely independently, grouped around the entity clusters in DESIGN.md §3. Each subcomponent lists its scope, its dependencies on other subcomponents, the tables/entities it owns, and a concrete deliverable checklist. This document does not re-derive design decisions — it assumes DESIGN.md v7 and REQUIREMENTS.md v6 are the source of truth and only sequences the work.

Before starting implementation, note that DESIGN.md §7 still lists three genuinely open items (`transfer_ownership()` / bulk reassignment fully specified, the periodic reconciliation job, and the account-deletion cascade written as an actual procedure). These are folded into the subcomponents below rather than treated as a separate pre-phase, since none require further product-owner input — they're implementation-specification work that naturally belongs inside the subcomponent that owns the affected tables.

---

## 1. How to read this breakdown

Each subcomponent below is sized to be ownable by one engineer or one agent working in isolation, touching a bounded set of tables, with explicit inbound dependencies (what must exist first) and explicit outbound consumers (what later work depends on this). "Independently implementable" here means: can be built and unit-tested against a stubbed/mocked version of its dependencies without waiting for their real implementation — not that it has zero dependencies.

Every subcomponent should ship with:
- The `CREATE TABLE` / `CHECK` / trigger DDL for the tables it owns.
- Any stored procedures or application-transaction functions it's responsible for.
- Unit/integration tests covering the constraints and behavioral rules DESIGN.md documents for those tables (each rule below cites its DESIGN.md section so tests can be traced back to a documented requirement).
- Updated indexes per DESIGN.md §5.4 for the tables it owns.

---

## 2. Dependency graph

```
                         ┌─────────────────────┐
                         │  0. Foundation        │
                         │  (USERS, SESSIONS)    │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │  1. Core Filesystem    │
                         │  (FOLDERS, FILES,      │
                         │  UPLOAD_SESSIONS)      │
                         └──────────┬───────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
   ┌──────────▼──────────┐ ┌───────▼────────┐  ┌──────────▼──────────┐
   │ 2. Permissions &      │ │ 3. Trash &      │  │ 4. Favorites & Tags  │
   │    Sharing            │ │    Deletion     │  │                      │
   │ (PERMISSIONS,          │ │ (soft-delete    │  │ (FAVORITES, TAGS,    │
   │  EFFECTIVE_PERMISSIONS,│ │  fields,        │  │  ITEM_TAGS)          │
   │  SHARE_LINKS)          │ │  DELETION_QUEUE)│  │                      │
   └──────────┬────────────┘ └───────┬────────┘  └──────────┬───────────┘
              │                      │                       │
              │              ┌───────▼────────┐              │
              │              │ 5. Thumbnails   │              │
              │              │ (THUMBNAIL_     │              │
              │              │  QUEUE)         │              │
              │              └────────────────┘              │
              │                                               │
   ┌──────────▼───────────────────────────────────────────────▼──────────┐
   │ 6. Admin & Audit (role bypass, ACTIVITY_LOG, admin stats/actions)     │
   └──────────┬────────────────────────────────────────────────────────┘
              │
   ┌──────────▼───────────┐
   │ 7. Account Lifecycle   │
   │ (deactivation,         │
   │  deletion cascade,     │
   │  bulk reassignment)    │
   └────────────────────────┘

   (cross-cutting, can proceed in parallel with everything once
    subcomponent 1 exists — not gated on 2–7)
   ┌────────────────────────┐
   │ 8. Search & Listing     │
   │ (name indexes,          │
   │  pagination)            │
   └────────────────────────┘

   (cross-cutting, depends on all subcomponents that write data —
    build last, or stub against each subcomponent's own test fixtures)
   ┌────────────────────────┐
   │ 9. Reconciliation &     │
   │    Repair Job           │
   └────────────────────────┘
```

**Parallelization notes:**
- Subcomponents 2, 3, and 4 can be built in parallel by different people once subcomponent 1 lands — they don't depend on each other, only on FOLDERS/FILES existing.
- Subcomponent 5 (Thumbnails) depends on subcomponent 3 (Trash/Deletion) specifically for the `deleted_at`-recheck and DELETION_QUEUE cascade rules — it can be scaffolded in parallel but not finished/tested until 3 is stable.
- Subcomponent 6 (Admin) depends on subcomponent 2 (for the shared access-check function it plugs into) and reads from whatever ACTIVITY_LOG-emitting subcomponents exist, but its own tables/columns (USERS.role, ACTIVITY_LOG) can be scaffolded early.
- Subcomponent 7 (Account Lifecycle) is the last integration point — it touches USERS, PERMISSIONS, SHARE_LINKS, TAGS, FAVORITES, SESSIONS, ACTIVITY_LOG, so it necessarily depends on 2, 3, 4, and 6 all being in place.
- Subcomponent 8 (Search & Listing) is nearly fully independent — it's index/query work layered on top of subcomponent 1 and can proceed any time after.
- Subcomponent 9 (Reconciliation) should be built last since it exists to detect drift in state produced by 1–7.

---

## 3. Subcomponents

### 0. Foundation — USERS, SESSIONS

**Owns:** `USERS`, `SESSIONS`
**Depends on:** nothing
**Blocks:** everything else

**Scope:** Account model, authentication/session tracking. No sharing, no admin bypass logic yet (role column exists but bypass wiring belongs to subcomponent 6).

**Deliverables:**
- [ ] `USERS` table with `role`, `storage_quota_bytes`, `storage_used_bytes`, `is_active` (DESIGN.md §3.1)
- [ ] Quota `BEFORE UPDATE` trigger — blocks increase past quota, permits admin-driven decrease below current usage (§3.1)
- [ ] Registration flow: unique-email enforcement with non-enumerating error message, password strength check, default quota from system config (REQUIREMENTS.md §5.1)
- [ ] `SESSIONS` table, multi-device login/logout, refresh-token hashing (§3.2)
- [ ] `SESSIONS(refresh_token_hash)` unique index, `SESSIONS(user_id)` index for bulk invalidation (§5.4) — the bulk-invalidation *use* (deactivation) belongs to subcomponent 7, but the index and a `revoke_all_sessions(user_id)` primitive belong here
- [ ] Password reset self-service flow (REQUIREMENTS.md §5.1)
- [ ] Bootstrap mechanism for the first admin account on a fresh deployment (REQUIREMENTS.md §5.1)
- [ ] Tests: quota trigger fires only on increase; concurrent registration race on same email; session revocation is per-device

---

### 1. Core Filesystem — FOLDERS, FILES, UPLOAD_SESSIONS

**Owns:** `FOLDERS`, `FILES`, `UPLOAD_SESSIONS`
**Depends on:** 0 (Foundation)
**Blocks:** 2, 3, 4, 5, 6, 7, 8

**Scope:** The tree structure, file metadata, and multipart upload mechanics. This is the largest and highest-risk subcomponent — it owns the cycle-detection/advisory-lock logic, which DESIGN.md itself calls the highest-risk item across all review passes.

**Deliverables:**
- [ ] `FOLDERS` table with `materialized_path`, partial unique sibling-name index, Unicode NFC-normalize-and-trim write path (§3.3)
- [ ] `FILES` table with `upload_status`, partial unique sibling-name index, non-guessable `storage_key` generation (§3.4)
- [ ] Human-readable path-length enforcement (4096 UTF-8 bytes, walking `materialized_path` ancestor chain) and per-name 255-byte limit (§3.3, REQUIREMENTS.md §5.2)
- [ ] Cycle-prevention on folder move: full-ancestor-chain walk, `pg_advisory_xact_lock` on (subtree root, target parent node id) in canonical sorted order (§3.3 — this is the single highest-risk item flagged across DESIGN.md's review passes; budget extra review/test time here)
- [ ] `materialized_path` full-subtree rewrite on move, same transaction as the move (§3.3)
- [ ] `UPLOAD_SESSIONS` table with `target_folder_id`/`target_name`, per-part completion tracking (array or child table, not a bare counter) for real resumability (§3.5)
- [ ] Multipart quota-check timing: increment `storage_used_bytes` per completed part, not just at final assembly; decrement on explicit/expired abort (§3.5)
- [ ] Abandoned-upload-session cleanup job: `pending`→`aborted` transition, MinIO multipart abort, quota credit-back (§3.5, §5.4 index)
- [ ] Concurrent-mutation guards: re-verify destination folder/name validity before each part and at finalization (§3.5, REQUIREMENTS.md §5.3)
- [ ] Download-time enforcement: authorize once at request time, let in-flight transfers complete on stale-but-immutable `storage_key` content, reject new requests against trashed files immediately (§3.4)
- [ ] Note: this subcomponent stubs out permission checks (assume "always authorized") since PERMISSIONS/EFFECTIVE_PERMISSIONS belongs to subcomponent 2 — wire the real check in during subcomponent 2's integration pass
- [ ] Tests: concurrent move-into-each-other's-subtree race (the two-folder mutual-cycle scenario); resumed upload after interrupted part; sibling-name collision under concurrent create

---

### 2. Permissions & Sharing — PERMISSIONS, EFFECTIVE_PERMISSIONS, SHARE_LINKS

**Owns:** `PERMISSIONS`, `EFFECTIVE_PERMISSIONS`, `SHARE_LINKS`
**Depends on:** 1 (Core Filesystem)
**Blocks:** 4 (Favorites/Tags need the access-check function), 6 (Admin bypass routes through this), 7 (Account Lifecycle needs `transfer_ownership`/bulk reassignment)

**Scope:** All access control — direct grants, the resolved-access cache, public links, and the single shared access-check function every other subcomponent calls into. This is the subcomponent that produces the reusable authorization primitive the rest of the system depends on.

**Deliverables:**
- [ ] `PERMISSIONS` table, `UNIQUE(item_type, item_id, user_id)`, `UNIQUE(item_type, item_id) WHERE role='owner'` deferrable (§3.6)
- [ ] Initial owner-row creation wired into item creation (folder/file create) — self-referential `granted_by` (§3.6)
- [ ] `transfer_ownership()` as one atomic routine — the only code path permitted to touch ownership (§3.6, §7 item #1)
- [ ] Granting-authority check: editor-or-above required before any PERMISSIONS write or SHARE_LINKS creation, with its three documented exemptions (initial owner row; `transfer_ownership`/bulk reassignment when run by admin or account-deletion; nothing else) (§3.6)
- [ ] Move-authorization check (editor-or-above on both source and destination; owner-only if the move would strip anyone else's access) — this reads FOLDERS/FILES from subcomponent 1 and must be wired back into subcomponent 1's move code path (§3.3, §3.4)
- [ ] **The shared access-check function** — single code path for "can user X do Y on item Z," with admin bypass hook point for subcomponent 6, synchronous EFFECTIVE_PERMISSIONS-fallback-to-PERMISSIONS logic (§3.7, §5.3) — this is the primary deliverable other subcomponents integrate against
- [ ] `EFFECTIVE_PERMISSIONS` cache table, async rebuild job triggered by share/unshare/move/`transfer_ownership()`, cascade-to-subtree on folder-level change (§3.7)
- [ ] Rebuild-queue ordering fix: last-write-wins by event commit time, not job-completion time (§3.7)
- [ ] `SHARE_LINKS` table: token generation/indexing, password hash + throttling fields (`failed_password_attempts`, `failed_attempts_window_started_at`), 10-attempts/15-minute-window enforcement per token (§3.8, REQUIREMENTS.md §5.5)
- [ ] `is_active` join-check on every SHARE_LINKS access (deactivated creator → link denied) (§3.8)
- [ ] `SHARE_LINKS.created_by ON DELETE CASCADE` (§3.8)
- [ ] Re-share semantics: grant-up-to-own-level, merge-to-higher on conflict, no-op on self-share or owner-share (REQUIREMENTS.md §5.5)
- [ ] Tests: viewer attempting to grant access is rejected; revoke is enforced on the very next access attempt even with a stale cache; two folders moved into each other's subtree simultaneously cannot create a cycle; deactivated-creator link is denied mid-window and resumes on reactivation

---

### 3. Trash & Deletion — soft-delete fields, DELETION_QUEUE

**Owns:** `deleted_at` behavior on FOLDERS/FILES, `DELETION_QUEUE`
**Depends on:** 1 (Core Filesystem)
**Blocks:** 5 (Thumbnails' delete-race handling), 7 (Account Lifecycle's item cleanup)

**Scope:** Soft-delete cascade, per-item independent retention clocks, hard-delete worker, and the async cleanup contract every polymorphic table relies on.

**Deliverables:**
- [ ] Soft-delete cascade: trashing a folder recursively sets `deleted_at` on the whole subtree in one transaction, each item's own timestamp independently starting its own 30-day clock (§5.2, REQUIREMENTS.md §5.4)
- [ ] `DELETION_QUEUE` table, `UNIQUE(item_id) WHERE status IN ('pending','processing')` idempotent-enqueue guard, `processing` status (§3.10)
- [ ] Scheduled purge job: scans *all* items (any depth, not just top-level trashed roots) whose own `deleted_at` exceeds 30 days, per-item independent clock (§5.2 — this is the reworked mechanism, not the superseded "top-level roots only" version)
- [ ] "Delete forever" immediate-purge path, same idempotent-enqueue guard as the scheduled job
- [ ] Worker: delete blob → purge DB row → cascade-clean PERMISSIONS, SHARE_LINKS, ACTIVITY_LOG references (polymorphic, no FK) → credit `storage_used_bytes` back atomically (§3.10)
- [ ] Folder-purge enumerates every descendant file individually with its own queue row + `size_bytes`; folder's own row always `size_bytes = 0` (§3.10)
- [ ] Restore path: eligible only if not already enqueued (checks DELETION_QUEUE, not just `deleted_at`); restoring into an unavailable/still-trashed parent redirects to root without collision (§5.2, REQUIREMENTS.md §5.4)
- [ ] Retry policy: bounded attempts, terminal `failed` state surfaced on an admin-visible view (§3.10)
- [ ] Indexes: owner-scoped `WHERE deleted_at IS NOT NULL` pair (trash listing) + unqualified pair (scheduled job cross-user scan) (§5.4)
- [ ] Note: cascade cleanup for FAVORITES/ITEM_TAGS is listed here as the worker's responsibility, but the *tables* it cleans belong to subcomponent 4 — coordinate the cascade step's column/table names against subcomponent 4's schema before finalizing
- [ ] Tests: descendant reaches its own 30-day deadline before ancestor folder does; scheduled purge and explicit delete-now racing on the same item; restore attempted on an already-mid-purge item is rejected

---

### 4. Favorites & Tags — FAVORITES, TAGS, ITEM_TAGS

**Owns:** `FAVORITES`, `TAGS`, `ITEM_TAGS`
**Depends on:** 1 (Core Filesystem), 2 (needs the shared access-check function for lazy-prune-on-read and editor-check)
**Blocks:** 3's cascade-cleanup step needs these tables' final schema; 7 (Account Lifecycle's TAGS cascade-delete)

**Scope:** User conveniences layered on top of the core filesystem, both using the polymorphic reference pattern.

**Deliverables:**
- [ ] `FAVORITES` composite PK `(user_id, item_type, item_id)`, secondary index on `(item_type, item_id)` for DELETION_QUEUE reverse lookup (§3.11)
- [ ] `FAVORITES.user_id ON DELETE CASCADE` (fires on account deletion, not deactivation) (§3.11)
- [ ] Lazy prune-on-read: favorites list resolves through `deleted_at IS NULL` + EFFECTIVE_PERMISSIONS check, deleting the row on failure at render time rather than eagerly invalidating (§3.11)
- [ ] Deactivation-vs-deletion distinction for favorites: a favorite must survive a reversible deactivation of the sharing user's account (hidden, not deleted) and only be dropped on permanent/irreversible access loss (REQUIREMENTS.md §5.7) — this needs coordination with subcomponent 7 on how deactivation state is surfaced to the access-check function
- [ ] `TAGS` table, `UNIQUE(owner_id, name)`, per-user scoped (§3.12)
- [ ] `TAGS` cascade-delete (not reassignment) on user deletion, cascading further into ITEM_TAGS (§3.12)
- [ ] `ITEM_TAGS` composite PK `(tag_id, item_type, item_id)`, secondary index on `(item_type, item_id)`, `tag_id ON DELETE CASCADE` (§3.12)
- [ ] Write-path checks: editor-or-above on the target item (via access-check function from subcomponent 2) **and** `tag_id`'s owner must equal the acting user (§3.12 — two distinct checks, don't conflate them)
- [ ] Tests: user with only viewer access cannot tag; user cannot apply another user's tag_id even with editor access to the item; favorite reappears automatically after a deactivated sharer is reactivated, without action from the favoriting user

---

### 5. Thumbnails — FILES.thumbnail_status/thumbnail_key, THUMBNAIL_QUEUE

**Owns:** `THUMBNAIL_QUEUE`, `FILES.thumbnail_status`/`thumbnail_key` columns
**Depends on:** 1 (Core Filesystem), 3 (Trash/Deletion — for the delete-race recheck)
**Blocks:** nothing downstream

**Scope:** Background preview generation, fully decoupled from upload latency, with careful handling of the race against concurrent deletion.

**Deliverables:**
- [ ] `THUMBNAIL_QUEUE` table, `file_id ON DELETE CASCADE`, `UNIQUE(file_id) WHERE status='pending'`, `processing` status (§3.13)
- [ ] Enqueue only for `image/*`, `video/*`, `application/pdf` mime types, triggered post-upload-completion, never blocking the upload response (§3.13, REQUIREMENTS.md §5.9)
- [ ] Worker: claim (`pending`→`processing`) → generate → **re-check `FILES.deleted_at IS NULL` immediately before writing the blob** (not just at enqueue time) → write blob + set `thumbnail_key`/`ready`, or `failed` after bounded retries with no further escalation (§3.13)
- [ ] Non-guessable `thumbnail_key`, same bucket-policy requirement as `storage_key` (§3.4)
- [ ] Trash/restore interaction: a thumbnail must stop being served while the file is trashed and resume on restore without regeneration if it already completed; if generation never completed before trashing, restore triggers a fresh best-effort attempt (REQUIREMENTS.md §5.9)
- [ ] "No preview available" as a normal UI/API state, not an error, for unsupported subtypes (REQUIREMENTS.md §5.9)
- [ ] `INDEX(status, enqueued_at)` for worker polling (§5.4)
- [ ] Tests: file deleted while thumbnail job is still pending — worker must not write an orphaned blob after the delete-recheck; restore-with-existing-ready-thumbnail serves immediately with no regeneration; restore-with-no-prior-thumbnail re-triggers generation

---

### 6. Admin & Audit — role bypass, ACTIVITY_LOG, admin-facing views

**Owns:** `ACTIVITY_LOG`, the admin bypass wiring inside the access-check function, admin statistics queries
**Depends on:** 0 (USERS.role), 2 (the shared access-check function this plugs its bypass into)
**Blocks:** 7 (Account Lifecycle logs lifecycle actions here)

**Scope:** Everything specific to the administrative role — bypass logic, audit trail, and the read-only statistics/usage views. Does not include account deactivation/deletion mechanics themselves (those are subcomponent 7); this owns *logging* those actions and the admin UI/API surface for triggering them.

**Deliverables:**
- [ ] `ACTIVITY_LOG` table, `actor_id`/`subject_user_id` split, full closed action enum including `view` and the three account-lifecycle actions (§3.9)
- [ ] Admin bypass short-circuit inside subcomponent 2's shared access-check function — role='admin' bypasses PERMISSIONS/EFFECTIVE_PERMISSIONS entirely, applied consistently rather than per-endpoint (§4.2)
- [ ] `view` action logged once per admin browsing session of another user's content, not per file glanced at (§3.9)
- [ ] System-wide and per-user storage statistics, explicitly labeled as a point-in-time approximation (excludes in-flight UPLOAD_SESSIONS/DELETION_QUEUE bytes) (§3.10, §4.3)
- [ ] Usage-frequency stats computed via ACTIVITY_LOG aggregation, not a live counter table (§4.2)
- [ ] Admin-visible "failed deletions" view surfacing DELETION_QUEUE rows stuck in `failed` (§3.10)
- [ ] Last-admin-standing guard: reject any demote/deactivate/delete that would leave zero admin accounts, except the bootstrap case (REQUIREMENTS.md §4)
- [ ] Indexes: `ACTIVITY_LOG(item_type, item_id)`, `ACTIVITY_LOG(actor_id, created_at)`, `ACTIVITY_LOG(subject_user_id, created_at)` (§5.4)
- [ ] Tests: admin viewing a user's folder produces exactly one `view` row per session, not per file; last-admin-standing rejection; storage stats query excludes in-flight upload bytes as documented

---

### 7. Account Lifecycle — deactivation, deletion cascade, bulk reassignment

**Owns:** the deactivation/reactivation procedure, the account-deletion procedure, `reassign_all_owned_items()`
**Depends on:** 0, 1, 2, 3, 4, 6 (touches USERS, PERMISSIONS, SHARE_LINKS, TAGS, FAVORITES, SESSIONS, ACTIVITY_LOG)
**Blocks:** nothing — this is the integration capstone

**Scope:** The two irreversible/high-blast-radius account operations, both of which cut across nearly every other subcomponent's tables. Build this last, once the tables it touches are stable.

**Deliverables:**
- [ ] Deactivation: invalidate all sessions immediately (`SESSIONS(user_id)` bulk revoke from subcomponent 0), suspend the user's SHARE_LINKS via the `is_active` join-check (already built in subcomponent 2 — this just flips the flag), suspend direct shares to others, fully reversible with no data mutation (REQUIREMENTS.md §5.1)
- [ ] `reassign_all_owned_items(from_user_id, to_user_id)` — bulk variant of `transfer_ownership()` (subcomponent 2), one transaction, respects the deferrable owner-uniqueness constraint, triggers EFFECTIVE_PERMISSIONS rebuild per affected item (§7 item #1)
- [ ] Default-reassignment-to-system-admin policy vs. admin-chosen-explicit-reassignment (REQUIREMENTS.md §5.1.1)
- [ ] Full account-deletion procedure, assembled as one specified, atomic sequence, per DESIGN.md §7 item #6's documented ordering:
  - [ ] Pre-step (a): bulk reassignment must complete first
  - [ ] Pre-step (e): SESSIONS invalidation before `DELETE FROM USERS`
  - [ ] Automatic cascades wired via `ON DELETE CASCADE` on `DELETE FROM USERS`: (b) SHARE_LINKS.created_by, (c) PERMISSIONS.user_id-as-grantee **plus** an application-layer EFFECTIVE_PERMISSIONS rebuild for every item so cascade-deleted, (d) TAGS→ITEM_TAGS, (g) FAVORITES.user_id
  - [ ] (f) ACTIVITY_LOG rows must survive — no cascade, dangling-reference-tolerant FK or denormalized display-name snapshot in `metadata`
- [ ] Self-service deletion always uses default-reassignment policy; admin-initiated deletion may specify per-item replacement owners (REQUIREMENTS.md §5.1.1)
- [ ] Tests: deactivate → verify every dependent share/link/session goes down within the same check path, then reactivate → verify all resume automatically with no manual re-grant; full deletion end-to-end against a user who owns items, has tags, has favorites, has active sessions, and has created share links — verify each of the seven lettered steps lands correctly and ACTIVITY_LOG survives

---

### 8. Search & Listing

**Owns:** name-search indexes, pagination support across all listing views
**Depends on:** 1 (Core Filesystem) — otherwise independent, can proceed any time after
**Blocks:** nothing

**Scope:** Cross-cutting query-layer work: this is index and query design, not new tables, so it can be picked up by whoever has bandwidth once FOLDERS/FILES exist.

**Deliverables:**
- [ ] `FILES(name)`, `FOLDERS(name)` trigram (`pg_trgm` GIN) indexes, scoped `WHERE deleted_at IS NULL` (§5.4)
- [ ] Partial + case-insensitive name search across owned and accessible (shared) items (REQUIREMENTS.md §5.3)
- [ ] Pagination on every unbounded listing view: folder contents, search results, trash, "Shared with me," admin's per-user file view, activity log history (REQUIREMENTS.md §5.11)
- [ ] Explicit empty-state responses distinct from loading/error states (REQUIREMENTS.md §5.11)
- [ ] Default sort by name ascending, with a most-recently-modified option (REQUIREMENTS.md §5.11)
- [ ] Tests: substring/partial match returns expected results; pagination cursor stability under concurrent inserts; empty folder returns explicit empty state, not an empty array indistinguishable from a bug

---

### 9. Reconciliation & Repair Job

**Owns:** a new periodic job, no new core tables
**Depends on:** all of 1–7 (it exists to detect drift in state they produce)
**Blocks:** nothing — purely a safety net, ship after the rest is stable

**Scope:** DESIGN.md §5.3 and §7 item #2 flag that no reconciliation job exists yet for the three denormalized values. This wasn't a review-pass finding requiring a fix elsewhere — it's a deferred, not-yet-designed follow-up, so this subcomponent starts from a blank slate rather than a documented spec.

**Deliverables:**
- [ ] Design (not just implement) a periodic job that recomputes `storage_used_bytes` from actual FILES rows and compares against the stored value, flagging/correcting drift
- [ ] Same for `materialized_path` (recompute from parent chain, compare against stored value)
- [ ] Same for EFFECTIVE_PERMISSIONS (recompute from PERMISSIONS + folder ancestry, compare against cached rows) — lower urgency since this cache already has a synchronous fallback and is never trusted as source of truth, but drift here still degrades the fast-path's usefulness
- [ ] Decide and document: does this job auto-correct drift, or only alert an admin? (Not decided in DESIGN.md — needs a call here.)
- [ ] Tests: deliberately desync each of the three values in a test fixture and verify the job detects (and, per the above decision, corrects) each case

---

## 4. Suggested build order for a small team

1. **Subcomponent 0** (Foundation) — one engineer, first.
2. **Subcomponent 1** (Core Filesystem) — one engineer, immediately after, ideally the person most comfortable with concurrency/locking given the cycle-detection risk.
3. **Subcomponents 2, 3, 4 in parallel** — three engineers, once subcomponent 1's schema (not necessarily full implementation) is stable enough to code against.
4. **Subcomponent 5** — starts once 3 is far enough along to test the delete-race; can be the same engineer who did 3 once they're free, or run in parallel from the start and just gate final testing on 3.
5. **Subcomponent 8** — can be picked up by anyone with spare bandwidth any time after subcomponent 1; genuinely independent.
6. **Subcomponent 6** — starts once subcomponent 2's access-check function exists.
7. **Subcomponent 7** — last, once 0/1/2/3/4/6 are all stable; this is the integration/capstone piece and should get a dedicated full-system test pass.
8. **Subcomponent 9** — last of all, once the rest is stable enough that "drift" is a meaningful concept to test against.

---

*This document sequences DESIGN.md v7 and REQUIREMENTS.md v6 into implementable units. It does not introduce new design decisions — any ambiguity encountered while implementing a subcomponent should be resolved by re-reading the cited DESIGN.md/REQUIREMENTS.md section, not by improvising; if genuinely unspecified, raise it rather than assume.*
