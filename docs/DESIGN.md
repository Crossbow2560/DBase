# Self-Hosted Cloud File Storage — Database Design Document

**Status:** v7 (post six design-review passes; Pass 6 itself ran in two rounds). Pass 6 was a fresh-eyes adversarial review against both this document and the companion REQUIREMENTS.md together, run twice — the second round specifically re-checking the first round's own fixes for regressions in addition to scanning fresh ground. Combined, Pass 6 found and closed: a self-contradiction in THUMBNAIL_QUEUE's status enum; an ambiguous/partially-incorrect advisory-lock fix from Pass 5; a missing safety-critical index in the consolidated index list; a tag-ownership bypass in ITEM_TAGS; an unconstrained granting-authority gap in PERMISSIONS (extended in round 2 to also cover SHARE_LINKS creation, with explicit exemptions carved out for the initial owner grant and bulk ownership-reassignment); an ordering/idempotency gap in the EFFECTIVE_PERMISSIONS rebuild queue; a missing move-authorization check (both a widening-access direction closed in round 1 and a mirror-image access-stripping direction closed in round 2); the trash-retention scheduled-purge mechanism fully reworked to match REQUIREMENTS.md's per-item independent-clock policy (previously a flagged, unresolved cross-document mismatch — now resolved); the ACTIVITY_LOG action enum extended with `view` and account-lifecycle actions (also previously flagged, now resolved); and a batch of schema/index gaps where REQUIREMENTS.md's product requirements had grown ahead of this document's support (name-search indexing, session-invalidation indexing, multipart quota-check timing and resumability, concurrent-mutation guards on in-flight uploads and downloads, Unicode name normalization, path-length enforcement, share-link password-throttling storage, trash-listing pagination indexes, and a fully-specified account-deletion cascade with explicit step ordering). See the Pass 6 annotations throughout §2, §3, §5, and §7 below. This document is **no longer "final"** — three items remain genuinely open (§7 items #1, #2, #6's underlying stored-procedure implementation) and should be resolved before implementation begins, though none require further product-owner input; they are implementation-specification work.
**Scope:** Data model / database design only. Application architecture, API design, and infrastructure deployment are out of scope for this document.

---

## 1. Purpose and Goals

This document describes the database design for a self-hosted, multi-user cloud file storage system — functionally similar to a self-hosted Dropbox or Nextcloud. It captures every entity, field, constraint, and design decision made across the initial design and six subsequent adversarial review passes, along with the reasoning behind each fix.

### 1.1 Functional goals

- Multiple user accounts, each with their own private storage space.
- Hierarchical folder organization (nested folders, arbitrary depth).
- File upload, download, rename, move, and delete.
- Sharing: both direct per-user sharing (grant a specific person access) and public share links (anyone with the link/token).
- Per-user storage quotas, enforced on upload.
- An administrative "super-user" role that can view all files and users, see system-wide and per-user storage statistics, view usage-frequency data, and alter other users' permissions and quotas.
- Favorites/starred items, personal tags/labels, and generated thumbnails/previews for images, video, and PDFs.

### 1.2 Explicit non-goals

- **No file version history.** Overwriting a file replaces it; there is no "restore previous version" feature. This was an explicit scope decision, not an oversight — it significantly simplifies the FILES table and avoids an entire versioning subsystem.
- **No real-time collaborative editing** (e.g., simultaneous multi-cursor editing like Google Docs). This is a file store, not a document editor.
- **No end-to-end encryption** is modeled at the database layer. If required, it would be an application-layer concern (encrypt before upload) and is not reflected in this schema.
- **Storage-layer encryption at rest (tier 1)**, added later, is orthogonal to the point above and lives entirely outside this schema: MinIO's bucket-default SSE-S3, keyed by its built-in single-key KMS (`MINIO_KMS_SECRET_KEY`, wired up in `docker-compose.yml`'s `minio` and `minio-init` services). The database is unaffected — `storage_key` still just points at an object, and the object's bytes are transparently encrypted/decrypted by MinIO itself; the app never sees ciphertext or handles keys. This protects against disk theft or a leaked backup, not against the DBase server (or its operator) being compromised — the operator can still read anything, same trust model as the rest of this deployment shape (§1 below).
  - **Known limitation:** `mc encrypt set sse-s3` only affects objects written *after* it runs — any file uploaded before encryption was enabled stays unencrypted at rest indefinitely. Retroactively encrypting it requires a manual operator action (e.g. an in-place `mc cp` rewrite of the object, or a full re-upload), not something this system does automatically.
  - No key rotation in this single-key KMS mode — rotating means re-encrypting every existing object under a new key, not just swapping the env var. An external KMS (Vault + SSE-KMS) is the documented upgrade path if rotation/audit trail is ever needed; not built, since it's disproportionate for this deployment shape.
- **No team/group accounts.** Sharing is exclusively user-to-user (PERMISSIONS grantee is always an individual `user_id`) or via public SHARE_LINKS — there is no concept of a group with members that can be granted access as a single unit. **Confirmed out of scope by the system owner.** This also means TAGS' per-user scoping (§3.12) is not expected to need revisiting for a shared/team tag taxonomy.

### 1.3 Technology assumptions

- **Metadata store:** PostgreSQL. Chosen for strong relational integrity guarantees, partial/expression indexes, `CHECK` constraints, deferrable constraints, and native support for `jsonb` (used in the activity log).
- **Blob storage:** An S3-compatible object store (e.g., MinIO), self-hosted alongside the database. The database never stores file bytes — only a reference (`storage_key`) to the object in the store.
- **Deployment shape:** Single self-hosted server (or small cluster) — not a large multi-tenant SaaS. Several design decisions below (e.g., accepting pure application-layer authorization with no database-level backstop) are justified specifically by this deployment shape and would need revisiting at larger scale or in a less-trusted operating environment.

---

## 2. Design Process

This schema was not designed in a single pass. It has gone through seven iterations so far:

1. **Initial design** — the baseline entity set based on functional requirements (users, files, folders, sharing, activity).
2. **Review pass 1** — stress-tested the initial design against real implementation scenarios (concurrency, cascading deletes, orphaned data, missing indexes). Found 9 issues.
3. **Review pass 2** — cross-verified that the pass-1 fixes actually worked as designed, rather than just looking correct on paper. Found that several fixes were incomplete (e.g., a cache invalidation strategy that didn't specify what invalidated it). Found 7 issues.
4. **Review pass 3** — introduced the admin/super-user feature, then reviewed the *consequences* of that feature against the already-hardened schema (e.g., does admin editing permissions conflict with the "exactly one owner" constraint added in pass 2?). Found 6 issues, several of which were genuine new bugs introduced by the admin feature rather than pre-existing gaps.
5. **Review pass 4** — introduced three new features (favorites, tags, thumbnails) on top of the now-hardened schema, then reviewed those additions for consistency with every pattern established in passes 1–3 (the polymorphic reference pattern, the DELETION_QUEUE cascade responsibility, the ownership-reassignment-on-user-deletion rule). Found 6 issues, including one genuine race condition and one case where a previously-established pattern (PERMISSIONS ownership reassignment) was wrongly assumed to apply to a new entity (TAGS) where it didn't.
6. **Review pass 5** — after the system owner made the last six open decisions (cycle-check locking strategy, tag scope, team-account scope, trash retention window, admin audit sufficiency, deduplication deferral), this pass specifically checked whether *finalizing* those decisions exposed anything that had been masked by "TBD," rather than re-reviewing anything already settled. Found 4 concrete issues (two of them in the just-decided advisory-lock approach itself) and explicitly confirmed 2 of the six decisions introduced no new problems. This pass was originally labeled "(final)" — that label has since been superseded by Pass 6 below and is no longer accurate; it is retained in the historical description above only for the record.
7. **Review pass 6 (round 1)** — a fresh-eyes adversarial review conducted against both this document and the companion REQUIREMENTS.md together (rather than this document in isolation, as every prior pass had been), after REQUIREMENTS.md itself had independently grown substantially more detailed. Found 29 confirmed issues: a self-contradiction in THUMBNAIL_QUEUE's status enum, an ambiguous/partially-incorrect advisory-lock fix from Pass 5, a missing safety-critical index in the consolidated index list, a tag-ownership bypass in ITEM_TAGS, an unconstrained granting-authority gap in PERMISSIONS, an ordering/idempotency gap in the EFFECTIVE_PERMISSIONS rebuild queue, and several gaps where REQUIREMENTS.md had specified product behavior (name search, session invalidation on deactivation, multipart quota-check timing, share-link deactivation enforcement, bulk ownership reassignment for account deletion) that this document had no corresponding schema support for. **This is why the document is no longer considered final** — see the Status line above and the round-1 Pass 6 annotations throughout §3, §5, and §7.
8. **Review pass 6 (round 2)** — specifically re-checked round 1's own fixes for regressions (broken cross-references from renumbering, a fix in one place contradicting unedited text elsewhere, a fix that only partially closed what it claimed to), in addition to a fresh completeness scan of ground round 1 hadn't touched. Found and closed: three separate places where the document's own claimed pass count/finality contradicted each other (this section, the Status line, and the closing footer, before this round's correction); an unclosed mirror-image gap in the move-authorization rule (round 1 stopped an editor from *widening* an item's audience via move, but not from *stripping* other users' access via move); the granting-authority check's scope extended to SHARE_LINKS creation (round 1 only covered direct PERMISSIONS grants) with its owner-row exemption clarified against two cases it hadn't addressed (bulk ownership reassignment, and SHARE_LINKS having no equivalent exemption at all); the trash-retention scheduled-purge mechanism actually reworked to match REQUIREMENTS.md's per-item clock policy (round 1 correctly flagged this as a known mismatch but left it unresolved); the ACTIVITY_LOG `view` action actually added (same situation — flagged but not yet fixed after round 1); and a batch of schema support added for product requirements REQUIREMENTS.md had specified but this document never gained matching support for (resumable-upload part tracking, concurrent-mutation guards on in-flight uploads/downloads, Unicode name normalization, human-readable path-length enforcement, share-link password-throttling storage, trash-listing pagination indexes, and full step-ordering for the account-deletion cascade, including two entities — FAVORITES and PERMISSIONS-as-grantee — the round-1 cascade description had itself omitted).

Each fix below is labeled with which pass introduced it, because the reasoning ("why does this field exist") is often more valuable than the field itself when this schema is eventually translated into SQL.

---

## 3. Entity Reference

### 3.1 USERS

The account table. One row per person who can log in.

| Field | Type (conceptual) | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `email` | string, unique | Login identifier. |
| `password_hash` | string | Never store plaintext; hash with a slow algorithm (bcrypt/argon2) at the application layer. |
| `display_name` | string | |
| `role` | enum: `user`, `admin` | **(Pass 3 / admin feature)** Determines whether this account bypasses normal permission checks. See §4 for the full admin design. |
| `storage_quota_bytes` | bigint | Maximum bytes this user may store. |
| `storage_used_bytes` | bigint | Denormalized running total of bytes currently stored by this user. Updated on every upload and every completed deletion — never computed live via `SUM()`, for performance. |
| `created_at`, `updated_at` | timestamp | |
| `is_active` | boolean | Soft-disable an account without deleting it. |

**Constraints:**

- A rule ensures `storage_used_bytes` cannot exceed `storage_quota_bytes`, but — critically — **this rule must only fire when `storage_used_bytes` increases** (i.e., on the upload path). It must **not** block an administrator from lowering a user's `storage_quota_bytes` below their current usage. *(Pass 3 fix — the original naive version of this rule as a plain cross-column `CHECK` would have made it impossible for an admin to cap an abusive user's quota after the fact, since the `UPDATE` on `storage_quota_bytes` would fail the moment the new quota was below current usage.)* The correct behavior: lowering quota below current usage is **allowed**; it simply blocks *new* uploads until the user frees space.
  - **Implementation clarification:** because this rule depends on comparing the *new* `storage_used_bytes` against the row's *previous* value (to distinguish "this is an increase" from "this is a decrease" or "only the quota changed"), it **cannot be written as a plain `CHECK` constraint** — a `CHECK` in Postgres only sees the row being written, not its prior state. This must be implemented as a `BEFORE UPDATE` trigger (or, more simply, enforced entirely at the application layer via the same atomic conditional-update pattern described in §5.3) that inspects `OLD.storage_used_bytes` vs. `NEW.storage_used_bytes` before deciding whether to reject the write.
- **Quota is editable only by an admin.** This is an application-layer rule, not database-enforced — a regular user cannot change their own `storage_quota_bytes` through any normal code path.

---

### 3.2 SESSIONS

*(Added in Pass 1 — the original design had no authentication/session model at all, despite being a multi-user system with login.)*

Tracks active login sessions / refresh tokens, so users can be logged in on multiple devices and sessions can be individually revoked.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `user_id` | FK → USERS | |
| `refresh_token_hash` | string, unique | Store a hash of the token, never the token itself. |
| `device_info` | string | User-agent / device name, for a "manage your devices" UI. |
| `expires_at` | timestamp | |
| `created_at`, `revoked_at` | timestamp | `revoked_at` nullable; set on logout or admin-forced revocation. |

---

### 3.3 FOLDERS

Hierarchical containers. Self-referencing tree structure.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `name` | string | |
| `owner_id` | FK → USERS | |
| `parent_folder_id` | FK → FOLDERS, nullable | Null = root-level folder. |
| `materialized_path` | string | **(Pass 2)** A denormalized path of *ids* (e.g. `/root-id/child-id/grandchild-id/`) that lets the system answer "is X an ancestor of Y" and "list this entire subtree" with an indexed prefix query instead of a recursive tree walk on every request. **This is deliberately not the same thing as REQUIREMENTS.md's human-readable path-length limit (§5.2 there, 4096 UTF-8 bytes root-to-item) — see the clarification below.** |
| `created_at`, `updated_at` | timestamp | |
| `deleted_at` | timestamp, nullable | Soft-delete marker (see §5.2, Soft delete and trash). |

**Constraints and behavioral rules:**

- **Unique sibling names.** `UNIQUE(parent_folder_id, name) WHERE deleted_at IS NULL`. *(Pass 1 fix.)* This is a **partial** unique index specifically so that a trashed folder's name doesn't block a live folder from reusing it. Without this constraint, two concurrent "create folder" requests racing on the same name in the same parent would both succeed, producing silent duplicates.
  - **`name` must be stored in Unicode-normalized form (NFC), with leading/trailing whitespace already trimmed, before this constraint or any comparison sees it — not compared as raw stored bytes.** *(Pass 6 — closes a real gap.)* REQUIREMENTS.md's name-comparison rule (case-sensitive, but Unicode-normalized so visually-identical names composed of different code points collide, and whitespace-trimmed) is a text-normalization policy this plain `UNIQUE` constraint cannot express on its own — a raw `UNIQUE(parent_folder_id, name)` compares exact stored bytes under the column's default collation, which would treat two Unicode-equivalent-but-differently-encoded names as distinct and would not trim whitespace at all. **Fix: normalize (NFC) and trim `name` at the application layer before every write** (creation, rename, restore-into-a-new-location), so the column always stores the canonical form and the plain `UNIQUE` constraint is sufficient without needing a functional/expression index. The column's collation should remain the default binary/case-sensitive collation (no `CI`/case-insensitive collation), consistent with REQUIREMENTS.md's case-sensitive rule.
- **REQUIREMENTS.md's 4096-byte path-length limit must be enforced against the human-readable name path, not `materialized_path`.** *(Pass 6 — closes a real gap; this document had no field representing the thing the limit actually measures.)* `materialized_path` is an id-path, used purely for efficient ancestor/subtree queries — it is not what REQUIREMENTS.md's limit is measured against, and its own length (UUIDs are fixed-width) is not a proxy for the name-path length either, since names vary in byte length independently of nesting depth. **Fix: the human-readable path length must be computed at write time (on create, rename, or move) by walking the ancestor chain via `materialized_path` and summing each ancestor's `name` byte length plus separators, and the write must be rejected if the total exceeds 4096 UTF-8 bytes** — this is an application-layer computation, not a stored/denormalized column, since maintaining a second denormalized path purely for a length check would duplicate `materialized_path`'s entire sync-on-move burden (§5.3) for no benefit beyond a bound already checked at write time and never needed again until the next write.
- **materialized_path must be rewritten for the entire subtree on every move, in the same transaction as the move.** *(Pass 2 fix, refined in Pass 3.)* A naive implementation that only updates the moved folder's own path leaves every descendant's path stale, silently breaking any subtree query or permission-inheritance logic that relies on the path. Moving `/A/B/C` under `/X` must rewrite the path prefix on `C` **and every folder nested inside `C`**, as one atomic bulk update.
- **Move authorization.** *(Pass 6 — same gap and same fix as documented for FILES, §3.4.)* Moving a folder is subject to the identical two-part authorization check described under FILES: the acting user must hold `editor` role or above on both the folder being moved and the destination folder, and if the move would cause any other user to lose currently-held access, the acting user must additionally be the folder's owner. This check runs before the cycle-prevention check below, in the same transaction.
- **Cycle prevention on move.** A trigger (or equivalent application-transaction check) must reject any update to `parent_folder_id` that would make a folder its own ancestor. Two important refinements came out of review:
  - **(Pass 2)** Checking only the *direct* parent is insufficient — it only catches the immediate case (`A` becomes child of `A`), not a folder being moved several levels down into its own descendant tree (`A` moved to be a child of its own grandchild `C`). The check must walk the **full ancestor chain** from the proposed new parent up to the root (or use the materialized_path prefix, once that exists) and reject if the moved folder's own id appears anywhere in that chain.
  - **(Pass 3 — highest-risk item, now resolved)** This check has a concurrency hole: two unrelated concurrent move operations (e.g., moving `A` under `B` while moving `B` under `A`) can each read a stale ancestor chain and both pass validation before either commits, producing a cycle despite the trigger. **Decision (owner-confirmed): a Postgres advisory lock, keyed on the subtree root being moved, is taken before the ancestor-walk cycle check runs.** This was chosen over `SERIALIZABLE` isolation + retry (no isolation-level change or app-side retry logic required, simpler to reason about) and over row-level `FOR UPDATE` locking up the full ancestor chain (avoids the deadlock-ordering complexity of locking multiple rows across concurrent transactions) as the best fit for a self-hosted, low-concurrency deployment.
  - **(Pass 5 — two corrections found while finalizing this decision)**
    1. **Must be `pg_advisory_xact_lock`, not the plain session-scoped `pg_advisory_lock`.** Session-scoped advisory locks are tied to the physical database connection, not the logical transaction. Any connection pooler running in transaction-pooling mode (e.g., PgBouncer in `transaction` mode — a common, often default, setup for a web app) can hand that same backend connection to a *different* request the moment the current transaction commits, and session-level locks are explicitly documented as unsafe under transaction-mode pooling. If the app crashes or a connection is returned to the pool before an explicit unlock, the lock leaks until the underlying backend connection itself closes. `pg_advisory_xact_lock` avoids all of this — it automatically releases at transaction end (commit or rollback), matching the exact lifetime the move operation needs, with no explicit unlock call required.
    2. **Locking only the moved node's own subtree root is not sufficient** to prevent the specific case of two folders being moved into each other's subtrees simultaneously (`A` moved into `B` while `B` is concurrently moved into `A`). Each transaction would acquire a *different* lock key (its own subtree root), so there's no mutual exclusion between them — both locks succeed, both ancestor-walks run before either commits, and neither walk can see the other's not-yet-committed move, so both can pass validation and a real cycle gets created. **The correct fix: lock both the moved node's subtree root and the target parent's *own node id* — not the root of the target parent's ancestor chain — in a canonical order (e.g., sorted by folder id) before running the ancestor walk.**
       - **(Pass 6 clarification — the phrase "target parent's ancestry root" in the original Pass 5 fix was ambiguous and, under one reading, incorrect.** If "ancestry root" is read as "the root of the target parent's ancestor chain" (i.e., walk `B`'s ancestors up to the top-level folder and lock *that*), the fix fails to restore mutual exclusion whenever `A` and `B` sit under two different top-level trees at the time the moves are issued: `A move into B` locks (`A`'s subtree root, root-of-`B`'s-tree), while `B move into A` locks (`B`'s subtree root, root-of-`A`'s-tree) — two lock-key pairs that don't intersect, so both transactions can still proceed concurrently and the original race reopens. The fix only works if "ancestry root" means the target parent node itself (`B`, not the root of `B`'s tree) — locking (`A`'s subtree root, `B`) on one side and (`B`'s subtree root, `A`) on the other gives both transactions a shared lock key (`A` and `B` both appear in both key sets), forcing serialization regardless of which pre-existing trees `A` and `B` started under. **The requirement is restated above using the unambiguous phrasing (target parent's own node id) to remove this ambiguity.**)*

---

### 3.4 FILES

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `name` | string | |
| `owner_id` | FK → USERS | |
| `folder_id` | FK → FOLDERS, nullable | Null = file lives at the user's root. |
| `size_bytes` | bigint | |
| `mime_type` | string | |
| `checksum` | string | SHA-256 (or similar) of the file content. Useful for integrity verification and as a building block for future deduplication, even though dedup itself is out of scope. |
| `storage_key` | string | The object key/path in the S3-compatible blob store. |
| `upload_status` | enum | **(Pass 1, tied to UPLOAD_SESSIONS)** e.g. `pending`, `complete` — a file row can exist before its bytes are fully uploaded (multipart uploads), and the app needs to distinguish a real, downloadable file from one still being assembled. |
| `thumbnail_status` | enum: `none`, `pending`, `ready`, `failed` | **(Pass 4 / thumbnails feature)** Tracks the state of an asynchronously generated preview image. See §3.13 (THUMBNAIL_QUEUE) for the generation mechanism. |
| `thumbnail_key` | string, nullable | **(Pass 4)** The object key of the generated thumbnail in the blob store, once ready. Null until generation completes. |
| `created_at`, `updated_at` | timestamp | |
| `deleted_at` | timestamp, nullable | Soft-delete marker. |

**Constraints and behavioral rules:**

- **Unique sibling names.** `UNIQUE(folder_id, name) WHERE deleted_at IS NULL` — same reasoning as FOLDERS above. *(Pass 1.)* **Same Unicode-normalization-and-trim-before-write requirement as FOLDERS.name (§3.3) applies here identically.** *(Pass 6.)*
- **Moving a file to a different folder must invalidate any EFFECTIVE_PERMISSIONS rows it inherited from its old folder.** *(Pass 2.)* Without this, a user who had access only because the file used to live in a folder shared with them would silently retain that access after the file moves elsewhere.
- **A move must be authorized before it is performed — this document only specifies what happens to the permission cache afterward, never the precondition check that should gate the move itself.** *(Pass 6 — a real gap; added here for completeness, not previously documented anywhere.)* Per REQUIREMENTS.md, a move requires the acting user to hold `editor` role or above on both the item being moved and the destination folder (via EFFECTIVE_PERMISSIONS, same pattern as the PERMISSIONS/ITEM_TAGS/SHARE_LINKS authority checks above), **and**, separately, if the move would cause any other user to lose access they currently hold, the acting user must additionally be the item's owner. Both checks are application-layer, evaluated before the move transaction begins (computing "would this move cause someone else to lose access" requires comparing the current resolved EFFECTIVE_PERMISSIONS set of users on the item's old location against what the destination folder's sharing would resolve to, for every user other than the actor) — a move failing either check must be rejected before `parent_folder_id`/`folder_id` and `materialized_path` are touched, consistent with the cycle-detection check already gating folder moves (§3.3).
- **`storage_key` must be non-guessable** — a random UUID or content-hash-derived key, **not** a predictable pattern like `{folder_id}/{filename}`. *(Pass 3.)* Combined with a MinIO bucket policy that denies anonymous/public reads, this ensures the application is the *only* path to a file's bytes; nothing about the key itself should let someone enumerate or guess other users' files.
- **Download-time enforcement point.** *(Pass 6 — added; this document previously never specified how a download request resolves against `deleted_at`/DELETION_QUEUE state.)* A download request is resolved in two steps: (1) a permission check (owner/EFFECTIVE_PERMISSIONS/admin bypass, as elsewhere) **and** a `deleted_at IS NULL` check, both evaluated once, at the moment the download *request* is authorized and a short-lived, scoped download URL or stream to `storage_key` is issued; (2) the actual byte transfer, which — once step 1 has authorized it — is allowed to run to completion using the file's content as of that moment, even if the file is renamed, moved, or trashed by someone else while bytes are still in flight, per REQUIREMENTS.md §5.3. This is safe without extra locking because `storage_key`'s content is immutable for the life of a FILES row (this schema has no versioning, §1.2) — a rename/move only changes `FILES.name`/`folder_id`, never `storage_key`, so an in-flight transfer reading from the object store by key is unaffected by concurrent metadata changes. A **new** download request that arrives after `deleted_at` has been set (even if the item hasn't reached DELETION_QUEUE processing yet) fails step 1 and is rejected — trashing a file takes effect for new download attempts immediately, with no dependency on DELETION_QUEUE's asynchronous purge timeline.
- **`thumbnail_key` must follow the exact same non-guessability and bucket-policy rule as `storage_key`.** *(Pass 4.)* A thumbnail is still a rendering of potentially sensitive content — it should not get a weaker access-control story than the original file just because it's "only a preview."
- **A file move or rename does not invalidate or require regenerating the thumbnail** — thumbnails are keyed by `file_id`, not by path. *(Pass 4.)* Since this schema has no versioning, a content change is always a new FILES row (delete + re-upload), which naturally gets its own fresh thumbnail; there is no "same file, new content" case to handle.

---

### 3.5 UPLOAD_SESSIONS

*(Added in Pass 2 — the original design had no support for uploading anything larger than a single request body.)*

Tracks in-progress multipart/chunked uploads against the blob store.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `file_id` | FK → FILES, nullable | Nullable because the FILES row may not exist yet when the upload session starts. |
| `user_id` | FK → USERS | |
| `target_folder_id` | FK → FOLDERS, nullable | **(Pass 6 — added.)** Null = uploading to the user's root, same convention as `FILES.folder_id`. Needed so the worker/finalization step can re-check the destination is still valid (see the concurrent-mutation rule below); without recording this, there is nothing to check against once the session has been running for a while. |
| `target_name` | string | **(Pass 6 — added.)** The filename this upload will occupy once complete. Needed for the same reason as `target_folder_id`, and to re-run the sibling-uniqueness check at finalization time (a colliding file could have been created in the destination folder after the session started). |
| `minio_upload_id` | string | The underlying object-store's multipart upload identifier. |
| `total_parts` | integer | Progress tracking. |
| `parts_completed` | integer[] (array of part numbers), or a separate `UPLOAD_SESSION_PARTS(session_id, part_number)` table | **(Pass 6 — replaces the old plain `parts_received` counter.)** A bare count cannot tell a resuming client *which* specific part numbers already succeeded if parts complete out of order or an acknowledgment is lost (e.g., part 7 succeeds but the client never receives confirmation and retries it, or parts are uploaded by a client that parallelizes and part 3 completes before part 2). Tracking the actual set of completed part numbers — either as an array column or a small child table — lets a resumed upload correctly skip only the parts truly already stored, rather than guessing from a count alone. `total_parts` is retained for progress display and completion detection (`len(parts_completed) == total_parts`).|
| `status` | enum: `pending`, `complete`, `aborted` | |
| `expires_at` | timestamp | Abandoned upload sessions should expire and be cleaned up; otherwise they'd accumulate as orphaned partial uploads in the blob store forever. |
| `created_at` | timestamp | |

**Relevant to admin stats (§4):** an in-progress upload session represents bytes that are neither fully "used" nor "free" from the user's quota perspective — see the caveat under §4.3.

**Quota-check timing (Pass 6 — added to close a real ambiguity).** REQUIREMENTS.md requires that each individual part of a multipart upload be checked against quota as it completes, and rejected at the point where it would cause the total to exceed quota — not allowed to complete and only fail at final assembly. To satisfy this, `USERS.storage_used_bytes` must be incremented as each part completes (not only once, at final upload completion), with the same atomic conditional-update / `BEFORE UPDATE` trigger pattern described in §3.1 firing on every part, not just on the row's final transition to `complete`. Concretely: each part-completion event on UPLOAD_SESSIONS must be paired, in the same transaction, with an attempted increment of the owner's `storage_used_bytes` by that part's byte size; if the quota trigger rejects the increment, that part upload fails immediately and the multipart upload is aborted (with whatever bytes were already accepted for prior parts remaining counted until the session is explicitly aborted — see below). On explicit abort of an UPLOAD_SESSIONS row, any `storage_used_bytes` already credited toward that session's completed parts must be decremented back out in the same operation that marks the session `aborted`, so a failed or abandoned multipart upload never leaves the user's quota worse off than before it began.

**Abandoned-session cleanup and the `pending`/`aborted` transition (Pass 6 — closes a real gap between this table's own two mechanisms).** The quota-decrement rule above triggers "in the same operation that marks the session `aborted`," but the abandoned-upload cleanup job (§5.4) only *finds* sessions that are still `status = 'pending'` and past `expires_at` — nothing previously stated that this job actually transitions them to `aborted`. **Fix: the cleanup job's job is exactly that transition** — for each expired, still-`pending` session it finds, it must, in one transaction per session: decrement `storage_used_bytes` by the sum of bytes already credited for that session's completed parts, abort the underlying MinIO multipart upload (freeing the object-store-side partial data), and set `status = 'aborted'`. A session a client explicitly cancels (REQUIREMENTS.md §5.3) follows the identical procedure, just triggered immediately rather than by the scheduled job finding it past `expires_at`.

**Concurrent mutation against an in-flight upload (Pass 6 — added to support REQUIREMENTS.md §5.3).** Before accepting each part, and again at final-assembly time, the application must re-verify that `target_folder_id` still resolves to a live (non-trashed) folder the uploading user still has write access to, and that no other live file now occupies `target_name` within it. If either check fails, the part/finalization is rejected and the session is aborted via the same procedure above (quota credited back, MinIO upload aborted, `status = 'aborted'`) — an in-flight upload is never allowed to silently complete into an unexpected location or silently collide with something that came to occupy its original target while it was in progress.

---

### 3.6 PERMISSIONS

Direct, per-user access grants on a file or folder.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `item_type` | enum: `file`, `folder` | Part of a polymorphic reference — see §5 for a full discussion of this pattern. |
| `item_id` | UUID | The id of the file or folder, interpreted according to `item_type`. No real foreign key (Postgres cannot FK against "one of two tables"), so referential integrity here is an application/trigger responsibility. |
| `user_id` | FK → USERS, `ON DELETE CASCADE` | The grantee — who is being given access. **(`ON DELETE CASCADE` added — Pass 6.)** A grant *to* a user no longer covers the "owner" case (owner rows are keyed by a different, non-cascading relationship handled through the bulk-reassignment procedure, §7 item #1, which must run *before* this cascade fires) — a `viewer`/`editor` grant to a since-deleted user is meaningless and should be removed automatically. This closes a gap in the account-deletion procedure (§7 item #6) that previously had no specified mechanism for cleaning up PERMISSIONS rows where the deleted user was the grantee rather than the owner. **This cascade must fire only after ownership reassignment has already completed** (§7 item #6's ordering), since a still-in-progress reassignment may itself be represented as transient PERMISSIONS activity that shouldn't be swept up by this same-column cascade. |
| `role` | enum: `owner`, `editor`, `viewer` | |
| `granted_by` | FK → USERS | Who granted this access — for audit purposes. |
| `created_at` | timestamp | |

**Clarification on the initial `owner` row:** when a file or folder is created, exactly one PERMISSIONS row must be inserted immediately, with `role = 'owner'`, `user_id` = the creator, and **`granted_by` = the creator as well (self-referential)** — this satisfies the "exactly one owner" invariant (below) from the moment the item exists, rather than leaving a window where a newly created item has zero PERMISSIONS rows. `granted_by` is never null; there is no code path that creates an item without simultaneously creating its owner grant.

**Constraints and behavioral rules:**

- **`UNIQUE(item_type, item_id, user_id)`** *(Pass 1)* — a user can only have one role per item; granting a new role should update the existing row, not create a duplicate.
- **`UNIQUE(item_type, item_id) WHERE role = 'owner'`** *(Pass 2)* — enforces that an item has **exactly one** owner at any time. Without this, nothing prevented an item from ending up with zero owners (e.g., if the owning user's account is deleted) or, in principle, multiple.
- **This owner-uniqueness constraint must be declared `DEFERRABLE INITIALLY DEFERRED`, and ownership transfer must go through one single, atomic operation** *(Pass 3)*. This was a genuine bug found by the third review pass: since transferring ownership from user A to user B necessarily involves two logical writes (demote A, promote B), doing this as two separate ad-hoc statements — as an admin editing permissions directly might naturally do — creates a moment where the constraint would see either zero owners or two owners, depending on statement order. Making the constraint deferrable (checked at transaction commit, not after each statement) and centralizing the operation into one dedicated "transfer ownership" routine closes this gap. **No code path — including admin actions — should ever `UPDATE`/`DELETE`/`INSERT` PERMISSIONS rows to change ownership except through this single routine.**
- **Deleting a user must reassign their owned items, not cascade-delete the permission grants.** *(Pass 2.)* A naive `ON DELETE CASCADE` from USERS to PERMISSIONS would silently orphan every file/folder the deleted user owned (leaving them with zero owners, violating the very invariant the constraint above exists to protect). Account deletion needs an explicit "reassign ownership" or "transfer to admin" step before the user row itself is removed.
- **Granting authority is not constrained anywhere in this design and must be added.** *(Pass 6 — closes a real gap.)* Nothing above restricts who may create a PERMISSIONS row naming themselves as `granted_by` — as specified through Pass 5, a user holding only `viewer` access to an item could grant a third party `editor` or `viewer` access to that same item, since no constraint or documented application-layer rule requires the granter to hold `editor` or above (or be the owner) on the target item first. This directly contradicts REQUIREMENTS.md's sharing model, where only an editor-or-above (or the owner) is meant to be able to grant access to others. **Fix: every write to PERMISSIONS that creates or updates a grant must be preceded by an application-layer check that the acting user (the prospective `granted_by`) currently holds `editor` role or above on the target item via EFFECTIVE_PERMISSIONS — the same check pattern already used for ITEM_TAGS writes (§3.12) — rejecting the write otherwise.** This is an application-layer rule, consistent with how quota-editability and other authority checks are enforced elsewhere in this design (§3.1); it is not database-enforced, since — like the ITEM_TAGS tag-ownership check — it depends on evaluating the *acting user's own* resolved access level, which a static schema constraint cannot express.
  - **This check has three distinct exemptions, and only these three** *(Pass 6 clarification — the original Pass 6 fix named only the first, leaving the other two ambiguous)*: (1) the initial self-granted owner row created at item creation (§3.6 above), where the "acting user" and the grantee are the same person and no prior access is possible since the item didn't exist a moment before; (2) `transfer_ownership()` and its bulk counterpart `reassign_all_owned_items()` (§7 item #1) when invoked by an admin or an automated account-deletion process, where the acting party is specifically *not* required to hold prior access on the affected items — this is the entire point of the admin bypass (§4.2) and of account-deletion reassignment, both of which must be able to move ownership regardless of the actor's own resolved role; and (3) none of REQUIREMENTS.md's account-deletion or ownership-transfer flows otherwise. Every other PERMISSIONS write, with no further exemptions, requires the editor-or-above check above.
- **The same granting-authority check applies to SHARE_LINKS creation, not just PERMISSIONS writes.** *(Pass 6 — closes a related gap the original fix didn't cover.)* REQUIREMENTS.md's sharing model gives editors the same re-share right whether "granting to another specific user or creating a public link" — the two are the same authority question and must be governed by the same rule. **Fix: creating a SHARE_LINKS row requires the same application-layer check as a PERMISSIONS grant — the acting user (the `created_by` value being written) must hold `editor` role or above on the target item via EFFECTIVE_PERMISSIONS at the moment of creation** — with no equivalent to the owner-row exemption above, since a SHARE_LINKS row is never auto-created at item-creation time the way an owner's PERMISSIONS row is.

---

### 3.7 EFFECTIVE_PERMISSIONS (cache)

*(Added in Pass 2.)* A denormalized, precomputed cache of each user's *resolved* access level on each item, accounting for folder-level sharing that cascades down to contents without literally copying a PERMISSIONS row for every file in a shared folder.

| Field | Type | Notes |
|---|---|---|
| `item_type, item_id, user_id` | composite PK | |
| `role` | enum | The resolved/highest applicable role. |
| `source_permission_id` | FK → PERMISSIONS | Which grant this resolution came from — useful for explaining "why do I have access to this" in a UI. |
| `recomputed_at` | timestamp | |

**Why this table exists:** the underlying design choice — sharing a folder does *not* copy a PERMISSIONS row down to every file inside it, to keep the PERMISSIONS table small and avoid rewriting thousands of rows every time someone shares a large folder — means that "can user X read file Y" naturally requires walking up the folder ancestor chain checking for a grant at each level. Doing that walk synchronously on every single file access is expensive at real folder depths. This cache exists purely to make that check fast.

**Rebuild mechanism (clarification):** "a background job" rebuilds this cache — concretely, this means every PERMISSIONS-affecting write (share, unshare/revoke, ownership transfer) and every FOLDERS/FILES move, after committing its own transaction, enqueues a small unit of work (e.g., "recompute effective permissions for subtree rooted at item X") onto an application-level job queue, which a worker process picks up and processes by walking the affected subtree and upserting EFFECTIVE_PERMISSIONS rows. This document does not prescribe a specific queue technology (the same durable-queue *pattern* already used for DELETION_QUEUE and THUMBNAIL_QUEUE is the natural fit, and could plausibly be the same underlying mechanism); the requirement is only that the rebuild is asynchronous, decoupled from the triggering transaction, and retryable — not that it uses any particular tool.

**Constraints and behavioral rules — this is the most heavily revised entity in the whole document:**

- **(Pass 2, initial version)** The cache is rebuilt by a background job whenever a share, unshare, or move event occurs.
- **(Pass 2 review's own follow-up finding)** The initial description didn't actually specify that revoke/unshare is one of the triggering events, nor that a rebuild triggered by a *folder*-level change must cascade the rebuild down to every descendant file and folder, not just the one item that changed. Both are now explicit requirements: **revoking access to a folder must cascade the cache rebuild to its entire subtree**, and **moving a file must trigger a rebuild reflecting its new location**, not just leave the file processed once at its original path.
- **(Pass 2 — the single most important correctness fix in the whole schema)** Because the rebuild is asynchronous, there is an unavoidable staleness window between a permission change committing and the cache reflecting it. For a sharing feature, this matters enormously: a user who has just been unshared from a folder could, in the naive design, retain read access to files inside it for as long as the rebuild job takes to run. **The fix: this cache must never be treated as the source of truth for an access-control decision.** It is a read-path performance optimization only. Every actual permission check (can this user read/write this file right now) must be able to fall back to a synchronous, on-demand recomputation from the real PERMISSIONS table if the cache is missing, stale, or the check is for something security-sensitive. The cache makes the common case fast; it must never be the only thing standing between a user and unauthorized access.
- **(Pass 3)** The admin bypass (§4) must route through this *same* access-check function/code path — with `role = admin` short-circuiting the check inside it — rather than being a separate, hand-rolled check on individual endpoints. This avoids a class of bug where a new admin-only feature forgets to implement the bypass correctly, or implements it inconsistently with how regular access checks work.
- **(Pass 4)** FAVORITES visibility (§3.11) must also resolve through this same check, not just through `deleted_at IS NULL`. A favorited item that still exists but that the user has since lost access to (permission revoked, share link expired) should not silently keep surfacing in their favorites list.
- **(Pass 6 — a real gap in the rebuild queue itself, not just what triggers it.)** Nothing above specifies that rebuild jobs for the same `(item_type, item_id)` subtree are processed in the order they were enqueued, nor that a job is idempotent/safe to discard if a newer job for the same subtree has already completed. Concretely: if a share event enqueues rebuild job J1, and a subsequent revoke event enqueues rebuild job J2 for the same item shortly after, a worker pool processing jobs out of order (J2 completes before J1, e.g. because J1's worker was slower or retried) would leave EFFECTIVE_PERMISSIONS reflecting the *share*, not the revoke that logically happened after it — even though the revoke is the more recent, authoritative state. Before this fix, that meant the cache could sit in an incorrect state indefinitely (not just transiently stale) until some later, unrelated event happened to re-trigger a rebuild for the same item — which undermined the cache's entire purpose as a fast, "usually correct" read path, even though it could never by itself grant unauthorized access (the synchronous fallback described two bullets above still gates every actual access decision). **Fix: each rebuild job must carry the triggering event's commit timestamp (or a monotonic sequence number), and the worker must discard (no-op) a job whose timestamp is older than EFFECTIVE_PERMISSIONS' current `recomputed_at` for that `(item_type, item_id, user_id)` row — i.e., last-write-wins by event time, not by processing-completion time. This fully resolves the J1/J2 scenario above: regardless of which job's worker finishes first, the row converges to reflect whichever event actually committed last, and stays converged — there is no remaining window where the cache can be permanently stuck on stale data once both jobs have run.**
- **(Pass 5 — final-pass finding)** `transfer_ownership()` (§3.6) must also be added to the list of events that trigger an EFFECTIVE_PERMISSIONS rebuild, alongside share/unshare/move. It was omitted from that list because it was designed and reviewed separately (as a fix for the ownership-uniqueness race, §3.6) and never explicitly cross-referenced against the cache-invalidation rule established here. Functionally this gap is low-severity — because the cache is never trusted as a source of truth and every access check has a synchronous fallback (the rule directly above), a stale cache row here cannot itself grant incorrect access — but it does leave EFFECTIVE_PERMISSIONS rows referencing a `source_permission_id` that ownership transfer just invalidated, contradicting the "cascades to descendants" invariant this table is supposed to uphold. **Fix: `transfer_ownership()` must either invoke the same rebuild routine used for share/unshare/move, or be added explicitly to the trigger list wherever that routine is wired up.**

---

### 3.8 SHARE_LINKS

Public, tokenized share links — access without requiring a user account.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `item_type`, `item_id` | polymorphic | Same pattern as PERMISSIONS. |
| `token` | string, unique, indexed | The secret in the shareable URL. |
| `role` | enum: `viewer`, `editor` | Deliberately excludes `owner` — ownership (§3.6) is a stronger relationship than any share can confer, since it carries responsibilities (exactly one per item, transferable only via `transfer_ownership()`) that don't make sense for an anonymous link recipient with no account. |
| `password_hash` | string, nullable | Optional extra protection on top of the token. |
| `failed_password_attempts` | integer, default 0 | **(Pass 6 — added.)** Count of consecutive failed password attempts against this link since the window below started, supporting REQUIREMENTS.md's per-link throttling rule (10 failures / 15-minute window). |
| `failed_attempts_window_started_at` | timestamp, nullable | **(Pass 6 — added.)** When the current failure-counting window began; a failed attempt outside this window resets both fields rather than accumulating indefinitely. |
| `expires_at` | timestamp, nullable | |
| `created_by` | FK → USERS | |
| `created_at` | timestamp | |

**Password-attempt throttling (Pass 6 — added to support REQUIREMENTS.md §5.5).** On each password attempt against a protected link: if `failed_attempts_window_started_at` is null or more than 15 minutes old, reset it to now and set `failed_password_attempts = 0` before evaluating the attempt. If the attempt fails, atomically increment `failed_password_attempts`; if it now exceeds 10, reject the attempt (and all further attempts against this token) until the window naturally expires, regardless of whether the password supplied is actually correct. If the attempt succeeds, reset both fields to their empty state. This state lives on the SHARE_LINKS row itself rather than a separate table, since it is scoped 1:1 to a single link token and needs no history beyond the current window.

**(Pass 6 — one structural issue found, closing a real cross-document gap.)** REQUIREMENTS.md requires that a public share link stop granting access immediately while its creator's account is deactivated, and resume working immediately on reactivation, and separately requires that deleting the creator's account permanently invalidate the link. Neither behavior has a supporting mechanism above: `created_by` is a plain FK with no described `ON DELETE` behavior, and nothing in this table or the access-check path joins back to `USERS.is_active`. **Fix: every access attempt against a SHARE_LINKS token must join to `USERS` on `created_by` and check `is_active = true` in the same access-check path used for authenticated permission checks (§3.7) — a deactivated creator's links fail this join-check and are denied, with no schema change needed since the check is read-time, not a stored state on SHARE_LINKS itself.** For account *deletion* specifically, `created_by` should be declared `ON DELETE CASCADE` (unlike PERMISSIONS' owner grants, a SHARE_LINK has no "must always have a value" invariant analogous to PERMISSIONS' exactly-one-owner rule — a link with no valid creator is simply meaningless and should cease to exist), which directly and automatically satisfies REQUIREMENTS.md's "permanently invalidates every public share link that user created" rule at the database level without requiring DELETION_QUEUE involvement.

**(Pass 6 clarification — confirmed deliberate, not a gap.)** Since REQUIREMENTS.md allows any editor, not only the item's owner, to create a public link (§5.5 there), this `created_by`-scoped check means a link's availability tracks whichever individual actually created it, not the item's owner — so an editor's own deactivation takes down a link they created on someone else's file, even though the file's owner never lost anything. **This is the confirmed, intended policy** (one consistent rule: a link goes down whenever its own specific creator, whoever that is, is deactivated) rather than an accidental side effect of allowing editors to create links — REQUIREMENTS.md §5.5 has been updated to state this explicitly rather than leave it implicit.

---

### 3.9 ACTIVITY_LOG

An append-only record of actions taken in the system.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `actor_id` | FK → USERS | **(Pass 3, renamed/split from a single `user_id`)** Who performed the action. |
| `subject_user_id` | FK → USERS | **(Pass 3, new)** Whose account or item was affected by the action. Equal to `actor_id` for ordinary self-service actions (a user uploading their own file); diverges from it when an admin acts on another user's behalf or data. |
| `item_type`, `item_id` | polymorphic, indexed | What the action was performed on. |
| `action` | enum | The complete set of loggable actions: `upload`, `download`, `rename`, `move`, `delete` (soft), `restore`, `purge` (hard delete completion), `share`, `unshare`, `create_share_link`, `revoke_share_link`, `favorite`, `unfavorite`, `tag`, `untag`, `quota_change`, `permission_change`, `ownership_transfer`, `view` (**added — Pass 6**), `account_deactivate`, `account_reactivate`, `account_delete` (**added — Pass 6**). This list is closed for the purposes of this design — any new user-facing action added later should extend this enum explicitly rather than relying on `metadata` alone to carry it. |
| `metadata` | jsonb | Free-form extra context (e.g., old/new values for a rename or quota change). |
| `created_at` | timestamp, indexed | |

**Why the actor/subject split matters** *(Pass 3 finding)*: with a single `user_id` column, there was no way to correctly log an admin action. Logging it as the admin loses the record of *whose* account was affected (an audit trail that can't answer "show me every change made to user X's account" is not much of an audit trail). Logging it as the affected user falsely attributes the admin's action to the victim, defeating the entire purpose of an admin audit trail. The two-column design resolves this cleanly.

**`view` and account-lifecycle actions (Pass 6 — closes a real, previously-flagged gap).** REQUIREMENTS.md requires that an admin viewing another user's files/folders be logged as a distinct action ("regardless of ownership or sharing settings" — no scope qualifier), and that account deactivation/reactivation/deletion be logged. This action enum previously had no `view`, `account_deactivate`, `account_reactivate`, or `account_delete` values, despite being described elsewhere in this document as "closed" — that closure predates REQUIREMENTS.md's admin-view-logging and account-lifecycle requirements, both added after this enum was originally finalized. **A `view` row is written once per admin browsing session of another user's content** (not once per individual file glanced at within that session — the practical unit is "an admin opened user X's folder/file browser," recorded via `actor_id` = the admin, `subject_user_id` = the viewed user, `item_type`/`item_id` identifying what was opened), consistent with how every other write-style action here is logged once per user-initiated operation rather than once per underlying row touched.

**Confirmed by the system owner: this actor/subject split is sufficient for the admin audit trail as-is** — no additional reason/comment field or stronger audit guarantee (e.g., requiring justification text on quota changes or permission overrides) is needed beyond what `actor_id`, `subject_user_id`, `action`, and `metadata` already capture.

**Also serves as the data source for admin "usage frequency" statistics** *(admin feature requirement)* — computed via aggregation (count of actions grouped by item and/or action type over a time window), rather than a separate always-maintained counter table. This was a deliberate simplicity trade-off: it's slower on a very large history than a dedicated counter table would be, but avoids introducing yet another denormalized cache that needs its own invalidation story.

---

### 3.10 DELETION_QUEUE

*(Added in Pass 1, substantially extended in Pass 2.)* A durable work queue for asynchronous cleanup after a hard delete.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `item_type`, `item_id` | polymorphic | What's being deleted. |
| `storage_key` | string, nullable | The blob to remove from the object store. |
| `thumbnail_key` | string, nullable | **(Pass 4)** The thumbnail blob to remove alongside the main object, in the same worker pass. |
| `owner_id` | FK → USERS | **(Pass 2, added)** Needed so the worker knows whose quota to credit back. |
| `size_bytes` | bigint | **(Pass 2, added)** Needed for the same reason. **A folder's own queue row (as opposed to one of its descendant files' rows) always has `size_bytes = 0` — Pass 6 clarification.** §3.10's folder-purge rule requires enumerating every descendant *file* individually with its own queue row (each carrying that file's real `size_bytes`), in addition to one row for the folder item itself (needed to purge the folder's own metadata/PERMISSIONS/ACTIVITY_LOG rows via the same cascade mechanism). Folders consume no blob storage and never count toward quota, so the folder's own row contributes `0` to the quota-credit step — it exists for cascade cleanup of the folder's own polymorphic references, not for a quota adjustment. |
| `status` | enum: `pending`, `processing`, `done`, `failed` | **(`processing` added in Pass 5** to support the idempotent-enqueue constraint below — a status of just `pending`/`done`/`failed` can't distinguish "not yet claimed by a worker" from "a worker has it right now," which the uniqueness guard needs to protect against both.) |
| `attempts` | integer | Retry counter. |
| `enqueued_at`, `processed_at` | timestamp | |

**`UNIQUE(item_id) WHERE status IN ('pending', 'processing')`** *(Pass 5.)* Prevents the 30-day scheduled purge job and an explicit "delete now" action from both successfully enqueueing the same item — see §5.2 for the full scenario. A second enqueue attempt while one is already in flight becomes a no-op rather than a duplicate row.

**Retry policy (clarification):** a row moves `pending → processing` when a worker claims it, then to `done` on success or back to `pending` (with `attempts` incremented) on a retryable failure — e.g., a transient MinIO connection error. After a fixed maximum number of attempts (an application-level constant, not modeled as a schema field), the worker instead sets `status = 'failed'` and stops retrying automatically. A `failed` row is not silently dropped: it should surface on an admin-visible "failed deletions" view for manual investigation, since a permanently stuck deletion means a blob or database row is not being cleaned up as expected. The same retry pattern (bounded automatic retries, then a terminal `failed` state requiring attention) applies identically to THUMBNAIL_QUEUE (§3.13), with the difference that a failed thumbnail job is lower-stakes — it can reasonably just leave `FILES.thumbnail_status = 'failed'` with no further escalation, since a missing preview image is a cosmetic gap, not a resource leak or security concern.

**Why this table exists at all** *(Pass 1 finding)*: the original design deleted a FILES row and expected the application to separately delete the corresponding object from the blob store in the same request. This is unsafe — if the app crashes or errors between the two operations, the blob is either orphaned forever (DB row gone, object still consuming storage) or the DB row survives pointing at a now-missing object. A durable queue with retry lets deletion be safely decoupled and recovered from failure.

**Behavioral rules:**

- **The worker's job, in order: delete the object from the blob store, then purge the database row, and cascade-clean any PERMISSIONS, SHARE_LINKS, and ACTIVITY_LOG rows that reference the deleted item.** *(Pass 1.)* Because PERMISSIONS/SHARE_LINKS/ACTIVITY_LOG reference items polymorphically with no real foreign key, nothing else in the database will clean these up automatically — this queue is the only place that cascade happens.
- **When a folder is purged, every descendant file must be enumerated individually and given its own queue row — not just one row for the folder itself.** *(Pass 2 — this closed a real orphaned-blob bug.)* The original round-1 description of this worker only mentioned purging "the item," which for a folder would delete the folder's own metadata but leave every child file's blob permanently orphaned in the object store, since nothing had ever enqueued their storage keys individually.
- **On successful completion, the worker must atomically decrement the owner's `storage_used_bytes` by `size_bytes`, in the same transaction as marking the queue row done.** *(Pass 2 — this closed a real "quota never frees up" bug.)* The original design updated `storage_used_bytes` on upload but nothing in the deletion path ever credited it back, meaning a user's available quota would only ever shrink over the lifetime of the account.
- **System-wide storage statistics have a caveat.** *(Pass 3.)* `SUM(storage_used_bytes)` across all users is the cheapest way to compute total storage used, but it does not account for bytes tied up in in-flight UPLOAD_SESSIONS or DELETION_QUEUE rows that are still `pending`. Any admin-facing "total storage used" figure should be labeled as a settled/point-in-time approximation, not represented as an exact real-time number.
- **The cascade cleanup responsibility now also covers FAVORITES and ITEM_TAGS.** *(Pass 4.)* When these two entities were added, the worker's existing cascade step (previously "clean up PERMISSIONS, SHARE_LINKS, ACTIVITY_LOG") was extended to also delete any FAVORITES or ITEM_TAGS rows referencing the purged item — otherwise both would silently accumulate references to items that no longer exist, the same class of bug the original DELETION_QUEUE design was built to prevent for the first three tables.
- **THUMBNAIL_QUEUE is deliberately *not* part of this manual cascade list, and this is correct — not an oversight.** *(Pass 5 — clarified during final review, since the omission was ambiguous without this note.)* Every table in the manual cascade list (PERMISSIONS, SHARE_LINKS, ACTIVITY_LOG, FAVORITES, ITEM_TAGS) uses the polymorphic `(item_type, item_id)` pattern with no real database foreign key, which is exactly *why* they need this worker to clean them up explicitly — nothing else will. THUMBNAIL_QUEUE is different: it has a real `file_id` foreign key back to FILES declared `ON DELETE CASCADE` (§3.13), so the database itself automatically removes any THUMBNAIL_QUEUE row the moment DELETION_QUEUE's worker purges the corresponding FILES row — no manual cleanup step is needed or should be added.

---

### 3.11 FAVORITES

*(Added in Pass 4.)* Lets a user mark a file or folder as a personal favorite/starred item, independent of who owns it.

| Field | Type | Notes |
|---|---|---|
| `user_id` | FK → USERS, `ON DELETE CASCADE` | **(`ON DELETE CASCADE` added — Pass 6.)** A favorite has no independent meaning once its favoriting user's account is deleted (account *deactivation*, which does not delete the USERS row, is unaffected by this — see §5.7 of REQUIREMENTS.md, where a favorite must survive a reversible deactivation of someone else's account; this FK only fires on the favoriting user's own account being permanently deleted). This closes a gap where FAVORITES was previously omitted from the account-deletion cascade discussion entirely (§7 item #6). |
| `item_type`, `item_id` | polymorphic | Same pattern as PERMISSIONS. |
| `created_at` | timestamp | |

**Primary key:** `(user_id, item_type, item_id)` — this composite key is itself the uniqueness guarantee; a user cannot favorite the same item twice, and no separate surrogate `id` is needed.

**Constraints and behavioral rules:**

- **A secondary index on `(item_type, item_id)` is required, separate from the primary key.** *(Pass 4 review finding.)* Because `item_type`/`item_id` are the *trailing* columns of the primary key (not the leading ones), the PK alone does not efficiently serve the reverse lookup "what favorited this item" — which DELETION_QUEUE's cascade cleanup needs on every purge. Without this explicit secondary index, that cleanup step degrades to a full table scan.
- **Favoriting a folder does not require re-validating access on every subsequent view — visibility is resolved lazily, not enforced eagerly.** *(Pass 4 — this was the most significant finding for this entity.)* If a user favorites a folder and later loses access to it (their PERMISSIONS grant is revoked, or a SHARE_LINK expires), nothing about that revocation event touches FAVORITES — it isn't a DELETION_QUEUE trigger, since the item itself hasn't been deleted, only the user's visibility into it has changed. The correct design is **not** to try to eagerly detect every access-loss event (that would require hanging a new side effect off of every permission-revocation code path, a disproportionate amount of new complexity for a "starred items" feature). Instead: when rendering a user's favorites list, resolve each entry through the same visibility check as everywhere else — `deleted_at IS NULL` **and** an EFFECTIVE_PERMISSIONS check (§3.7) — and if a row fails that check, delete it from FAVORITES at that point (a lazy prune-on-read), rather than merely hiding it in the UI. This keeps FAVORITES consistent without adding a new invalidation trigger to the permissions system.

---

### 3.12 TAGS and ITEM_TAGS

*(Added in Pass 4.)* User-defined labels that can be applied to files and folders. Two tables, because a tag is a reusable named object distinct from any single application of it.

**TAGS** — the tag definitions themselves:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `owner_id` | FK → USERS | The tag's creator. |
| `name` | string | |
| `color` | string, nullable | For UI display. |
| `created_at` | timestamp | |

- **`UNIQUE(owner_id, name)`** — tags are scoped **per-user**, not global. **Confirmed by the system owner as the intended design, not just a placeholder default.** This sidesteps a much bigger design question: if tags were shared/global, two different users' "Work" tags would either collide (forcing a decision about whether they mean the same thing) or need some other disambiguation mechanism. Per-user scoping avoids that entirely at the cost of users not being able to share a tag taxonomy — an accepted trade-off, consistent with team/group accounts being explicitly out of scope (§1.2).
- **On user deletion, TAGS rows are cascade-deleted — they are NOT reassigned to another user.** *(Pass 4 — this was an explicit correction of an initially-proposed design.)* The initial draft of this feature assumed TAGS should follow the same "reassign on user deletion" pattern established for PERMISSIONS ownership (§3.6). Review found this analogy doesn't hold: the PERMISSIONS reassignment rule exists because a file or folder is a shared resource that persists independently of any one user's relationship to it, and *must* always have exactly one owner (a database constraint enforces this). A tag has no such independent existence and no other stakeholders — it is a personal label with meaning only to its creator. Reassigning someone's "Work" tag to an arbitrary remaining user would be semantically meaningless (whose tag is it now, and why?). The correct rule is simply: deleting a user cascade-deletes their TAGS, which in turn cascade-deletes the associated ITEM_TAGS rows (below) — the tagged items themselves are entirely unaffected; they simply lose that tag.

**ITEM_TAGS** — the application of a tag to a specific file or folder:

| Field | Type | Notes |
|---|---|---|
| `tag_id` | FK → TAGS, `ON DELETE CASCADE` | |
| `item_type`, `item_id` | polymorphic | Same pattern as PERMISSIONS. |
| `created_at` | timestamp | |

- **Primary key:** `(tag_id, item_type, item_id)`.
- **A secondary index on `(item_type, item_id)` is required** — same reasoning as FAVORITES above: the PK's column order doesn't serve the "what tags does this item have" / DELETION_QUEUE reverse-lookup direction.
- **Writing to ITEM_TAGS requires the acting user to hold `editor` role or above on the target item, via EFFECTIVE_PERMISSIONS.** *(Pass 4 — this closed a real gap, not a hypothetical one.)* The initial draft specified `TAGS.owner_id` (who created the tag) but never specified any permission check on the *item* being tagged. As drafted, this would have allowed a user with only `viewer` access to a shared file to tag it — despite having no write access to the file itself — which is inconsistent with every other write operation in this schema. The fix makes tagging follow the same write-permission rule as renaming, moving, or deleting: `editor` or above.
- **A row's `tag_id` must belong to a TAGS row owned by the acting user — this is a separate constraint from the item-permission check above, not the same rule restated.** *(Pass 6 — this closes a real gap the Pass 4 fix left open.)* The item-permission check above governs write access to the *item* being tagged; it says nothing about which *tag* may be applied. As specified through Pass 5, nothing prevented a user with editor access to an item from applying a `tag_id` belonging to a completely different user's TAGS row — for example, User A (with editor access to User B's file) supplying a `tag_id` that actually belongs to User C, if A can discover or guess C's tag UUID. Since §3.12's TAGS section repeatedly characterizes tags as strictly personal to their creator ("a personal label with meaning only to its creator"), allowing a write path that references another user's tag row directly contradicts that invariant — it lets one user attach a label they don't own and can't see (TAGS has no cross-user visibility, §3.12) onto an item, and lets them probe for the existence of another user's tag UUIDs by observing whether the write succeeds. **Fix: the application-layer write path for ITEM_TAGS must additionally verify `tag_id`'s `TAGS.owner_id` equals the acting user's id, rejecting the write otherwise; this is enforceable at the database level too, via a `CHECK`-adjacent trigger or a join-based `INSERT ... SELECT` that filters on `TAGS.owner_id = :acting_user_id`, since a plain foreign key cannot express a same-owner constraint across two tables.**

---

### 3.13 THUMBNAIL_QUEUE

*(Added in Pass 4.)* An asynchronous work queue for generating preview thumbnails, structurally identical in spirit to DELETION_QUEUE (§3.10) — decoupling a slow, failure-prone operation (image/video/PDF rendering) from the request that triggered it.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID, PK | |
| `file_id` | FK → FILES, `ON DELETE CASCADE` | |
| `status` | enum: `pending`, `processing`, `done`, `failed` | **(`processing` added — Pass 6 correction.)** §3.10's retry-policy text states the `pending → processing → done/failed` pattern "applies identically to THUMBNAIL_QUEUE," and the worker mechanism described below (claim a row, generate, re-check `deleted_at`, write) needs a way to mark a row as claimed/in-progress — a `pending`/`done`/`failed` enum alone cannot represent "a worker has this right now," the same gap `processing` was added to DELETION_QUEUE to close (§3.10). This corrects §6's Pass 5 addendum, which incorrectly concluded this table did not need a `processing` status because it "has no equivalent dual-trigger race" — that reasoning conflated two different problems. THUMBNAIL_QUEUE's `UNIQUE(file_id) WHERE status = 'pending'` already prevents duplicate *enqueueing* (the dual-trigger race), but it does nothing to represent in-progress work once a worker claims a row, which is what `processing` is actually for. |
| `attempts` | integer | Retry counter. |
| `enqueued_at`, `processed_at` | timestamp | |

**Constraints and behavioral rules:**

- **A row is only enqueued for `image`, `video`, and `pdf` `mime_type` values** — there's no meaningful thumbnail to generate for, e.g., a `.zip` or a plain text file.
- **`UNIQUE(file_id) WHERE status = 'pending'`** *(Pass 4 — this closed a real concurrency bug.)* Nothing in the initial draft prevented two concurrent upload-completion handlers from both enqueueing a thumbnail job for the same file — for example, a retried request or a race between two app server instances. Without this partial unique index, that produces duplicate queue rows, duplicated worker effort, and a possible last-writer-wins clobber of `thumbnail_key` if both workers happen to run close together. With it, a second enqueue attempt while one is already pending is a no-op (constraint conflict, handled as "already queued") rather than a duplicate.
- **`INDEX(status, enqueued_at)`** for the worker to efficiently find and process pending rows in order.
- **A row moves `pending → processing` when a worker claims it**, mirroring DELETION_QUEUE's retry lifecycle (§3.10), then to `done` on success or back to `pending` (with `attempts` incremented) on a retryable failure, or to `failed` after the same bounded-retry policy described in §3.10 — with the difference (already noted in §3.10) that a `failed` thumbnail job is lower-stakes and can simply leave `FILES.thumbnail_status = 'failed'` with no further escalation.
- **The worker must re-check `FILES.deleted_at IS NULL` immediately before writing the generated thumbnail blob to the object store — not just when the job was first enqueued.** *(Pass 4 — this closed a real orphaned-blob bug, found by explicitly tracing the race between this queue and DELETION_QUEUE.)* Concrete failure scenario without this check: a file is uploaded, a thumbnail job is enqueued, and the file is deleted before the worker gets to it. The worker, still holding the original `file_id` and unaware of the deletion, can finish generating and writing a thumbnail blob to MinIO *after* the file has already been purged — producing a real, permanently orphaned object with no reference anywhere pointing back to it (since the FILES row that would have carried `thumbnail_key` is already gone). Re-checking immediately before the write — combined with `ON DELETE CASCADE` on `file_id` so the queue row itself vanishes when the FILES row is hard-deleted — closes this. This works together with DELETION_QUEUE's `thumbnail_key` column (§3.10) to also purge whatever thumbnail *did* successfully complete before a subsequent deletion.

---

## 4. The Admin / Super-User Feature

This section consolidates every design decision specific to the administrative role, since it was added after the base schema and reviewed separately.

### 4.1 Requirements

An admin can:

- View all files and folders across all users, regardless of ownership or sharing.
- See per-user and system-wide storage statistics (used, remaining/quota).
- See "usage frequency" — how often files are accessed, derived from ACTIVITY_LOG.
- Alter other users' permissions (including reassigning ownership).
- Change other users' storage quotas.

### 4.2 Design decisions

| Decision | Rationale |
|---|---|
| Admin status is a `role` column directly on USERS, not a separate `ADMIN_ROLES` grant table. | The requirement is a simple binary (is/isn't an admin), not a system needing multiple admin tiers or revocable/audited admin grants. A column is the simplest thing that satisfies the requirement; a join table would be premature generality. |
| Admin's ability to view any file bypasses PERMISSIONS/EFFECTIVE_PERMISSIONS checks entirely at the application layer — there are no database rows granting admin access to every item. | Avoids having to backfill a PERMISSIONS row per item per admin (which would also need to stay in sync as new items are created). The bypass logic lives in one shared access-check function (see §3.7) so it's applied consistently rather than re-implemented per endpoint. |
| "Usage frequency" is computed by aggregating ACTIVITY_LOG rather than maintained as a live counter table. | Simplicity — avoids introducing another denormalized cache with its own invalidation rules, at the cost of being slower to compute over very large histories. Acceptable trade-off for a self-hosted deployment's scale. |

### 4.3 Known, accepted risks of this design

These were surfaced during review and are being documented as **conscious trade-offs**, not silently accepted gaps:

- **Pure application-layer bypass has no database-level backstop.** If a new API endpoint, background job, or an ad-hoc SQL script forgets to apply the admin/permission check, that code path has *no* access control at all — not "admin gets extra access," but "anyone who can reach it gets full access," since there's no PERMISSIONS row to fall back to either. This is judged an acceptable trade-off specifically because of the single-server, small-trusted-admin-surface deployment shape (§1.3). Mitigations: route every access check through one shared authorization function (§3.7), and keep any direct/raw-SQL admin database access on a separate credential from the application's own runtime database connection, so that kind of access is a deliberate, distinguishable action rather than something indistinguishable from normal app traffic.
- **SHARE_LINKS' `is_active` deactivation check (§3.8, Pass 6) carries this same category of risk and is called out here explicitly rather than left implicit.** *(Pass 6 — cross-reference added.)* Like the admin bypass above, the join-time `USERS.is_active` check gating a public share link's availability is a pure application-layer rule with no database-level backstop (e.g., nothing prevents a code path from fetching a SHARE_LINKS row and serving its target without performing the join-check first). This is accepted for the same reason and under the same mitigation as the admin bypass: route every SHARE_LINKS access through the one shared authorization function (§3.7), rather than re-implementing the `is_active` join ad hoc per endpoint.
- **`storage_key` plus direct object-store access bypasses the entire permission model.** Nothing about PERMISSIONS or EFFECTIVE_PERMISSIONS constrains the object store itself — anyone with direct MinIO bucket access, or who obtains a `storage_key` through some other means, can fetch the raw bytes with no regard for who's supposed to have access. This is extremely common and generally accepted for self-hosted single-tenant deployments, but it's a stated assumption, not an oversight: it requires that MinIO credentials are scoped only to the application service (not shared with, e.g., an admin's personal tooling) and that the bucket policy denies anonymous/public reads (see §3.4).
- **"Total storage used" system-wide stats are an approximation**, not an exact real-time figure, for the reasons described in §3.10.

---

## 5. Cross-Cutting Design Patterns

### 5.1 The polymorphic `item_type` / `item_id` pattern

PERMISSIONS, SHARE_LINKS, ACTIVITY_LOG, DELETION_QUEUE, FAVORITES, and ITEM_TAGS all need to reference "either a file or a folder." Two alternatives were considered and rejected:

- **A single unified `ITEMS` table** with a `type` discriminator, merging FILES and FOLDERS into one entity. This would give a clean foreign key target for the polymorphic tables, but was rejected to keep file-specific fields (size, checksum, storage_key, mime_type) and folder-specific fields (materialized_path) from living awkwardly in one table with a lot of nullable columns, and to keep queries for "list files in this folder" simple rather than needing a type filter on every query.
- **Two separate junction tables per relationship** (e.g. `FILE_PERMISSIONS` and `FOLDER_PERMISSIONS`), doubling the number of tables for every relationship that needs to target either type.

The chosen approach — a `(item_type, item_id)` pair with no real database-level foreign key (Postgres cannot express a foreign key against "one of two tables") — is the pragmatic middle ground. Its costs, which are accepted as a deliberate trade-off, are:

- No referential integrity from the database itself; an orphaned `item_id` pointing at a deleted item is possible if the DELETION_QUEUE cascade cleanup (§3.10) is ever skipped or fails.
- Every query joining against "the actual item" needs an application-level `CASE`/`UNION` to resolve into FILES or FOLDERS, rather than a simple join.
- Composite indexes on `(item_type, item_id)` are mandatory on every table using this pattern (PERMISSIONS, SHARE_LINKS, ACTIVITY_LOG, DELETION_QUEUE, FAVORITES, ITEM_TAGS) — without them, resolving "everything shared with this item" requires a full table scan. Note that for FAVORITES and ITEM_TAGS specifically, this index must be a distinct *secondary* index rather than relying on the primary key, since `item_type`/`item_id` are the trailing columns of those tables' composite primary keys (§3.11, §3.12) and therefore don't serve this lookup direction on their own — a subtlety the polymorphic pattern makes easy to miss when adding a new table that uses it.

### 5.2 Soft delete and trash

FILES and FOLDERS both use a `deleted_at` timestamp rather than a separate TRASH table. A null value means the item is live; a non-null value means it's in the trash. This was a deliberate simplification — a separate trash table would need to duplicate most of the same fields and be kept in sync, for no real benefit over a nullable column with a partial index (`WHERE deleted_at IS NULL`) used throughout the schema to exclude trashed items from normal queries.

**Two-stage deletion lifecycle:**

1. **Soft delete (trash):** setting `deleted_at` on a folder must cascade to its entire subtree in the same transaction (a recursive operation, not a single-row update) — otherwise child items remain "live" (`deleted_at IS NULL`) while being unreachable through a trashed parent, an inconsistent state. **Each descendant item's `deleted_at` is set to the same timestamp as the moment this cascade runs — i.e., all items caught up in one trashing operation share the same trashing instant — but each item's own `deleted_at` is what its individual 30-day retention clock is measured from, per REQUIREMENTS.md §5.4 (see the Pass 6 rework immediately below); items do not defer to an ancestor's `deleted_at` for this purpose.**
2. **Hard delete (purge):** triggered one of two ways — **(a)** a scheduled job that automatically purges anything that has sat in trash for **30 days** (the confirmed retention window), or **(b)** the user explicitly choosing to permanently delete an item immediately, bypassing the retention window. **Both paths are required — the retention window is a default grace period, not the only way to purge; the user must always have the option to force an immediate permanent delete rather than wait out the 30 days.** Either way, this is where DELETION_QUEUE (§3.10) takes over — enumerating the full subtree, enqueuing blob deletion and cascade cleanup for every descendant, and crediting quota back on completion.
   - **(Pass 6 — reworked; supersedes the Pass 5 "top-level trashed roots only" design below.)** REQUIREMENTS.md §5.4 specifies that each file/folder tracks its **own independent** 30-day trash retention clock, measured from that specific item's own trashing time — not inherited from, or deferred to, any ancestor folder's trashing time. This means the scheduled 30-day job can no longer restrict itself to top-level trashed roots (items not descended from another already-trashed item), because a descendant item can independently reach its own 30-day deadline *before* its ancestor folder does, even though the descendant is not currently reachable as a "root." **Fix: the scheduled job must instead query every item (file or folder, at any depth, trashed or not-a-root) whose own `deleted_at` is more than 30 days old and which does not already have a `pending`/`processing` DELETION_QUEUE row (per the idempotent-enqueue guard below), and enqueue each such item individually** — this requires the partial indexes added in §5.4 (`FILES(owner_id, deleted_at) WHERE deleted_at IS NOT NULL`, `FOLDERS(owner_id, deleted_at) WHERE deleted_at IS NOT NULL`, generalized here to an unqualified `deleted_at`-based index usable by the scheduled job across all owners, not just per-user trash listings) to run efficiently at scale. **A consequence worth being explicit about:** when a folder is trashed and, independently, one of its descendants is separately force-deleted or simply reaches its own 30-day deadline first, DELETION_QUEUE's worker purging that one descendant must not assume the rest of the (still-trashed, not-yet-expired) subtree is being purged alongside it — the worker's existing subtree-enumeration behavior for a folder purge (§3.10) already only enumerates *that* item's own descendants when *that* item is the one being purged, so this composes correctly without further change; it is called out here only because the "top-level roots only" framing this replaces made it easy to assume purges only ever happen at subtree granularity, which is no longer true.
   - **(Pass 5 finding — superseded by the Pass 6 rework immediately above; retained for historical context only.)** ~~The scheduled 30-day job should enumerate and enqueue only top-level trashed roots (items whose `deleted_at` is set but which are not themselves a descendant of another already-trashed item) — it should not re-derive DELETION_QUEUE's descendant-enumeration logic; that walk already happens once, inside the queue's own worker, regardless of which path triggered the enqueue.~~
   - **(Pass 5 finding — real race, now closed)** Because both the scheduled job and the explicit "delete now" action can target the same item, they can race each other — both attempting to enqueue the same item around the same time, which without a guard could cause DELETION_QUEUE's worker to process the same subtree twice (double-decrementing `storage_used_bytes`, or erroring on an already-purged row/object). **Fix: DELETION_QUEUE needs `UNIQUE(item_id) WHERE status IN ('pending', 'processing')`**, so a second enqueue attempt for an item already in flight is a no-op (`ON CONFLICT DO NOTHING`) rather than a duplicate.
   - **(Pass 5 finding)** Because purge processing is asynchronous, there's an inherent — and acceptable — brief window between an item being enqueued for permanent deletion and a worker actually completing that purge, during which the UI could still show it as "in trash" if it derives that state naively from `deleted_at` alone. **The restore-eligibility check must also test for the absence of a pending/processing DELETION_QUEUE row for that item, not just `deleted_at IS NOT NULL`** — otherwise a user could click "restore" on an item that is already mid-purge.

### 5.3 Denormalized counters and caches — and why none of them are trusted blindly

This schema deliberately uses three pieces of denormalized/derived state for performance: `storage_used_bytes` (USERS), `materialized_path` (FOLDERS), and EFFECTIVE_PERMISSIONS. Each exists purely because computing the equivalent value live (via `SUM()`, a recursive ancestor query, or a permission tree-walk) would be too slow to do on every relevant request.

The recurring lesson across all three review passes is the same: **a derived value is only safe if there's a precise answer to "what keeps this in sync, and what happens if it's temporarily wrong."** For each of the three:

- `storage_used_bytes` is kept in sync by requiring every mutation (upload, deletion-queue completion) to update it atomically, in the same transaction, using a conditional update rather than a read-then-write (to avoid a race where two concurrent uploads both check quota against a stale value and both succeed, together exceeding it).
- `materialized_path` is kept in sync by requiring a full-subtree rewrite inside the same transaction as any folder move.
- EFFECTIVE_PERMISSIONS is *not* fully trusted — it's explicitly designated a read-optimization with a synchronous-recompute fallback, precisely because "what keeps this in sync" (an async background job) cannot give an airtight answer to "what happens if it's temporarily wrong" for something as sensitive as an access-control decision.

No periodic reconciliation/repair job (recomputing all derived state from source tables to catch drift) has been designed yet; this is a reasonable follow-up but wasn't specified in detail. It's flagged here as an intentionally deferred item rather than a review finding.

### 5.4 Indexing

Indexes required by the design, consolidated from every entity above (these are conceptual requirements — see §3 for context on why each exists):

- `FOLDERS(parent_folder_id)`, `FOLDERS(materialized_path)` (prefix-searchable)
- `FILES(folder_id)`, `FILES(owner_id)`
- `FOLDERS(owner_id)`
- Partial indexes `WHERE deleted_at IS NULL` on both FILES and FOLDERS — nearly every query filters out trashed items, and the partial unique-name constraints (§3.3, §3.4) depend on this filter too.
- **`FILES(owner_id, deleted_at) WHERE deleted_at IS NOT NULL` and `FOLDERS(owner_id, deleted_at) WHERE deleted_at IS NOT NULL`** — **(Pass 6 — added.)** the inverse-condition partial indexes needed to efficiently paginate a user's own trash listing, ordered by trashing time. Every other partial index in this list serves the far more common "exclude trashed items" case; without this pair, "list my trashed items" (a listing view REQUIREMENTS.md §5.11 explicitly requires pagination support for) has no efficient path and would fall back to a full scan of the user's rows filtered after the fact. **A second, unqualified `FILES(deleted_at) WHERE deleted_at IS NOT NULL` and `FOLDERS(deleted_at) WHERE deleted_at IS NOT NULL` pair (i.e., the same partial condition, without leading `owner_id`) is additionally needed for the scheduled 30-day purge job (§5.2, reworked in Pass 6), which scans for expired items across *all* owners at once, not scoped to one user's trash — the owner-scoped pair above does not efficiently serve that cross-user scan.**
- `PERMISSIONS(item_type, item_id)`, `PERMISSIONS(user_id)`
- `SHARE_LINKS(token)` (should be backed by an index, not merely a uniqueness constraint, since it's looked up on every public link access), `SHARE_LINKS(item_type, item_id)`
- `ACTIVITY_LOG(item_type, item_id)`, `ACTIVITY_LOG(actor_id, created_at)`, `ACTIVITY_LOG(subject_user_id, created_at)`
- `EFFECTIVE_PERMISSIONS` primary key `(item_type, item_id, user_id)` doubles as its own lookup index.
- `DELETION_QUEUE(status)` — the worker needs to efficiently find pending rows.
- `DELETION_QUEUE` partial unique index `UNIQUE(item_id) WHERE status IN ('pending', 'processing')` — the idempotent-enqueue guard (§3.10, §5.2) that prevents the 30-day scheduled purge and an explicit "delete now" action from double-enqueueing the same item; doubles as a lookup index, same pattern as THUMBNAIL_QUEUE's equivalent index below. **(Pass 6 — this was omitted from this consolidated list despite being explicitly specified in §3.10 and §5.2; the omission is corrected here since it is one of the more safety-critical indexes in the design.)**
- `FAVORITES(item_type, item_id)` — secondary index, required for the DELETION_QUEUE reverse-lookup cascade (§5.1).
- `TAGS(owner_id)` — for "list this user's tags."
- `ITEM_TAGS(item_type, item_id)` — secondary index, same reverse-lookup reasoning as FAVORITES; `ITEM_TAGS(tag_id)` for "show all items with this tag."
- `THUMBNAIL_QUEUE(file_id) WHERE status = 'pending'` — the partial unique index doubles as the concurrency guard (§3.13) and a lookup index.
- `THUMBNAIL_QUEUE(status, enqueued_at)` — for worker polling, same pattern as DELETION_QUEUE.
- `SESSIONS(refresh_token_hash)` — already required by its `UNIQUE` constraint, but called out explicitly here since it's looked up on every authenticated request and must stay fast.
- `UPLOAD_SESSIONS(user_id)`, `UPLOAD_SESSIONS(expires_at) WHERE status = 'pending'` — needed for the abandoned-upload cleanup job referenced in §3.5, which must efficiently find expired-but-still-pending sessions.
- **(Pass 6 — added to support REQUIREMENTS.md's name-search requirement.)** `FILES(name)` and `FOLDERS(name)`, both trigram (`pg_trgm` `GIN`) indexes rather than plain B-tree, since the search requirement mandates partial and case-insensitive matching (a prefix-only B-tree index cannot serve a substring/`ILIKE '%term%'`-style query efficiently). Both should additionally be scoped `WHERE deleted_at IS NULL` for the same reason as the other partial indexes in this list — search results should exclude trashed items by default.
- `SESSIONS(user_id)` — **(Pass 6 — added.)** required to efficiently invalidate every active session belonging to a user in one operation (e.g., on account deactivation or deletion), which is not an access pattern `SESSIONS(refresh_token_hash)` alone serves.

---

## 6. Summary of All Fixes by Review Pass

For quick reference — every change made, grouped by which pass introduced it.

**Pass 1 (initial hardening):**
- Unique partial index on sibling names for both FILES and FOLDERS.
- DELETION_QUEUE introduced, to decouple blob deletion from DB row deletion and make it retryable.
- Cascade-delete semantics defined: folder trash/purge must recursively affect the whole subtree; nothing cascades automatically for the polymorphic tables, so DELETION_QUEUE must explicitly clean up PERMISSIONS/SHARE_LINKS/ACTIVITY_LOG.
- Cycle-prevention trigger on folder moves (first version — later found incomplete in Pass 2).
- Atomic, conditional quota update pattern instead of read-then-write, to close a race condition.
- SESSIONS, UPLOAD_SESSIONS added — nothing previously modeled authentication or multipart uploads.
- Full indexing pass.

**Pass 2 (verifying Pass 1's fixes actually work):**
- `materialized_path` added to FOLDERS, with the requirement that a move rewrites the *entire subtree's* paths in one transaction.
- Cycle-check trigger upgraded from "checks direct parent" to "must walk the full ancestor chain."
- EFFECTIVE_PERMISSIONS cache introduced, explicitly designed as a read-optimization only, never a source of truth — access checks always retain a synchronous fallback.
- File moves invalidate inherited EFFECTIVE_PERMISSIONS from the old folder.
- Exactly-one-owner constraint added to PERMISSIONS.
- User deletion must reassign owned items rather than cascade-delete grants.
- DELETION_QUEUE's folder-purge behavior corrected to enumerate every descendant file individually, closing an orphaned-blob bug.
- DELETION_QUEUE worker wired to credit storage back to the owner's quota on completion, closing a "quota never frees up" bug.

**Pass 3 (reviewing the admin feature's consequences):**
- Admin role added as a `role` column on USERS.
- Quota `CHECK` constraint scoped to fire only on increases, so admin can legitimately lower a user's quota below current usage.
- Owner-uniqueness constraint made `DEFERRABLE INITIALLY DEFERRED`; ownership transfer centralized into a single atomic operation, closing a race condition specific to admin-driven permission changes.
- Admin's access bypass explicitly routed through the same shared access-check function as regular users, rather than a separately hand-rolled check.
- ACTIVITY_LOG split into `actor_id` / `subject_user_id` to correctly audit admin actions taken on other users' behalf.
- `storage_key` non-guessability and MinIO bucket-policy requirements documented, since admin's "view all files" capability made it worth stating explicitly that the object store itself is not access-controlled.
- Cycle-detection trigger's concurrency gap flagged as the single highest-risk item still left as a design note rather than a fully specified mechanism.
- System-wide storage stats caveat documented (excludes in-flight uploads/pending deletions).

**Owner decisions (post-Pass-4, resolving remaining open items):**
- Cycle-check locking strategy decided: **advisory lock on the subtree root** before the ancestor-walk check, over `SERIALIZABLE`+retry or row-level `FOR UPDATE` locking — chosen for implementation simplicity at this deployment's expected concurrency level. This closes the single highest-risk open item flagged across three review passes.
- Tag scope confirmed as **per-user** (not global/shared) — consistent with team/group accounts being out of scope.
- Team/group accounts confirmed **out of scope** — sharing remains exclusively individual-user-to-user or via public SHARE_LINKS.
- Trash retention window set to **30 days**, with an explicit requirement that users can **permanently delete immediately**, bypassing the retention window, rather than the 30-day window being the only path to a hard purge.
- Admin audit trail (the `actor_id`/`subject_user_id` split on ACTIVITY_LOG) confirmed **sufficient as designed** — no additional reason/justification field required.
- Deduplication **held, not designed** — explicitly deferred rather than built now, revisit later if needed. The `checksum` field on FILES remains in place as a low-cost stepping stone for whenever that design work happens.

**Pass 4 (adding favorites, tags, and thumbnails; reviewing them against the established patterns):**
- FAVORITES table added; visibility resolved through the same EFFECTIVE_PERMISSIONS check as everything else, with lost-access favorites lazily pruned on read rather than eagerly invalidated.
- FAVORITES given a required secondary index on `(item_type, item_id)`, since its primary key's column order doesn't serve the DELETION_QUEUE reverse lookup.
- TAGS and ITEM_TAGS added; tags scoped per-user to avoid a cross-user tag-collision design question.
- TAGS given cascade-delete (not reassignment) semantics on user deletion — an explicit correction after review found the PERMISSIONS ownership-reassignment pattern didn't actually apply to a tag, which (unlike a file or folder) has no stakeholders beyond its creator.
- ITEM_TAGS write path given an explicit `editor`-or-above permission check, independent of tag ownership — closing a gap where any user with any access level could have tagged an item they couldn't otherwise modify.
- FILES extended with `thumbnail_status` / `thumbnail_key`; THUMBNAIL_QUEUE added, modeled directly on the DELETION_QUEUE pattern.
- `thumbnail_key` given the same non-guessability / bucket-policy requirement as `storage_key`.
- A concurrency bug closed with `UNIQUE(file_id) WHERE status = 'pending'` on THUMBNAIL_QUEUE, preventing duplicate concurrent thumbnail jobs for the same file.
- A genuine race condition between THUMBNAIL_QUEUE and DELETION_QUEUE identified and closed: a file deleted while its thumbnail job is still pending could previously result in a thumbnail blob being written to the object store *after* the file itself was purged, with nothing ever referencing it again. Fixed via `ON DELETE CASCADE` on the queue row plus a mandatory re-check of `FILES.deleted_at` immediately before the worker writes the blob.
- DELETION_QUEUE's cascade-cleanup responsibility extended to also cover FAVORITES, ITEM_TAGS, and the `thumbnail_key` blob.

**Pass 5 / final (verifying the owner's six closing decisions):**
- Advisory lock corrected from the plain session-scoped variant to `pg_advisory_xact_lock` — the originally decided approach would have leaked or misbehaved under transaction-mode connection pooling (e.g., PgBouncer), since session locks are tied to the physical connection, not the transaction.
- Cycle-check locking scope corrected: locking only the moved node's own subtree root does not prevent two folders being moved into each other's subtrees simultaneously. Fixed by locking both the moved node's subtree root and the target parent's ancestry root, in a canonical (sorted) order.
- DELETION_QUEUE given `UNIQUE(item_id) WHERE status IN ('pending', 'processing')` (and a new `processing` status value) to make enqueueing idempotent — closing a real race between the 30-day scheduled purge job and the explicit "delete now" bypass both targeting the same item.
- Restore-eligibility check requirement added: must test for an in-flight DELETION_QUEUE row, not just `deleted_at`, so a user can't restore an item that's already mid-purge.
- Team/group accounts being out of scope confirmed as introducing no hedging artifacts in the existing schema — `PERMISSIONS.user_id` as a single non-nullable grantee required no changes.
- Deduplication deferral confirmed as fully neutral — nothing in the current design (in particular, `checksum` sitting unused today) needs to change to make future dedup adoption smoother; it would be purely additive.

**Pass 5 addendum — final internal-consistency audit (checking the accumulated fixes against each other, not new functionality):**
- `transfer_ownership()` (§3.6) was missing from EFFECTIVE_PERMISSIONS' list of cache-rebuild trigger events — added, since ownership transfer is a PERMISSIONS write of the same category as share/unshare and was only omitted because it was designed and reviewed as a separate fix for a different problem (the ownership-uniqueness race) and never explicitly cross-referenced against the cache-invalidation rule.
- THUMBNAIL_QUEUE's absence from DELETION_QUEUE's manual cascade list was confirmed correct (its `ON DELETE CASCADE` foreign key already handles this automatically) but was ambiguous as previously documented — a clarifying note was added so a reader doesn't mistake the omission for a gap.
- Three other potential inconsistencies were explicitly checked; two were confirmed clean and one was not: the advisory-lock scope (subtree root + target parent's ancestry root) and the materialized_path rewrite scope (full subtree of the moved node) were verified to compose correctly rather than having silently diverged across passes; and no two fixes from different passes were found to directly contradict each other anywhere in the final design. The third check — whether THUMBNAIL_QUEUE needed the same `processing` status as DELETION_QUEUE — was answered incorrectly at the time ("no, since it has no equivalent dual-trigger race") by conflating the dual-trigger idempotent-enqueue problem with the separate need to mark an in-flight job as claimed by a worker. **Corrected in Pass 6 (§3.13): `processing` was in fact missing and has been added,** since §3.10's own retry-policy text already claimed the full `pending → processing → done/failed` lifecycle "applies identically to THUMBNAIL_QUEUE" — a claim the schema didn't support until this fix.

**Pass 6 (fresh-eyes review against this document and REQUIREMENTS.md together — 29 confirmed issues):**
- THUMBNAIL_QUEUE given a `processing` status (§3.13), correcting the Pass 5 addendum's own incorrect conclusion that it wasn't needed (see immediately above).
- Advisory-lock fix from Pass 5 (§3.3) clarified: "target parent's ancestry root" was ambiguous and, under one reading, didn't actually restore mutual exclusion between two folders being moved into each other's subtrees when they started under different top-level trees; corrected to lock the target parent's own node id.
- The consolidated index list (§5.4) was missing DELETION_QUEUE's own safety-critical partial unique index (the idempotent-enqueue guard), despite listing THUMBNAIL_QUEUE's structurally identical index — added.
- ITEM_TAGS' write-permission check (§3.12) governed access to the *item* being tagged but never constrained which *tag* could be applied — a user with editor access to an item could apply another user's private tag to it. Added: `tag_id` must belong to a TAGS row owned by the acting user.
- PERMISSIONS had no constraint on who may act as `granted_by` (§3.6) — nothing stopped a viewer from granting access to a third party, contradicting REQUIREMENTS.md's sharing model. Added an application-layer check requiring `editor`-or-above before any grant (other than the initial self-granted owner row).
- DELETION_QUEUE's `size_bytes` (§3.10) was undefined for a folder's own queue row (folders have no blob storage) — clarified as always `0` for that row.
- EFFECTIVE_PERMISSIONS' rebuild queue (§3.7) had no ordering/idempotency guarantee — an out-of-order worker could leave the cache reflecting a stale share after a more recent revoke. Added a last-write-wins-by-event-time rule.
- SHARE_LINKS (§3.8) had no mechanism to stop granting access when its creator's account is deactivated, and no `ON DELETE` behavior specified for account deletion — added an `is_active` join-check and `ON DELETE CASCADE` on `created_by`.
- Several indexes and mechanisms added purely to support REQUIREMENTS.md's independently-evolved product requirements, which this document had no corresponding support for: `FILES(name)`/`FOLDERS(name)` trigram indexes for name search (§5.4); `SESSIONS(user_id)` for bulk session invalidation on deactivation (§5.4); per-part quota-check timing for multipart uploads (§3.5); the scope of `transfer_ownership()` clarified as single-item only, with bulk reassignment for account deletion flagged as a new, distinct, not-yet-designed operation (§7 item #1).
- A new open item added: a full account-deletion cascade, touching more tables than DELETION_QUEUE's item-keyed cleanup covers, has not yet been assembled into one specified, atomic procedure (§7 item #6).

**Pass 6, round 2 (regression check on round 1's own fixes, plus a fresh completeness scan):**
- Document-wide finality/pass-count self-contradiction fixed: §2, the Status line, and the closing footer previously gave three different, disagreeing accounts of how many passes had run and whether the document was final — all three now agree.
- Move-authorization rule (§3.3, §3.4) extended to close the mirror-image gap round 1 left open: a non-owner editor could still strip *other* users' access by moving an item into a folder only the mover controls. A move that would cause anyone besides the mover to lose currently-held access now requires the mover to be the item's owner.
- Granting-authority check (§3.6) extended to also govern SHARE_LINKS creation, not just direct PERMISSIONS grants — round 1's fix only covered the latter, leaving public-link creation by an unauthorized user just as open as the direct-grant bug it was meant to close. The check's exemptions were also made explicit for the first time: the initial self-granted owner row, and `transfer_ownership()`/bulk reassignment when run by an admin or the account-deletion process (which must be exempt from holding prior access by design).
- SHARE_LINKS' `created_by`-scoped deactivation check (§3.8) clarified as deliberate, not a gap: since REQUIREMENTS.md allows any editor to create a public link, a link's availability now explicitly tracks its own specific creator (owner or not), confirmed as the intended single consistent rule rather than an accidental side effect of allowing non-owner link creation.
- The trash-retention scheduled-purge mechanism (§5.2) actually reworked to match REQUIREMENTS.md's per-item independent-clock policy — round 1 correctly identified this as a mismatch and flagged it prominently, but left the mechanism itself unchanged; it no longer enumerates only top-level trashed roots.
- ACTIVITY_LOG's `action` enum (§3.9) actually extended with `view` and account-lifecycle values — same situation as the trash-purge item: flagged as needed in round 1, not actually added until this round.
- UPLOAD_SESSIONS (§3.5) extended with `target_folder_id`/`target_name` (to support the new concurrent-mutation-during-upload guard) and per-part completion tracking replacing a bare counter (to support real resumability, not just progress display); the abandoned-session cleanup job's `pending`→`aborted` transition, previously only implied, made explicit.
- Download-time access-check semantics specified for the first time (§3.4): an in-flight download completes using the file's state as of authorization time; a new download request after trashing is rejected immediately, independent of DELETION_QUEUE's asynchronous purge timeline.
- Unicode normalization (NFC) and whitespace-trimming specified as an application-layer write-time requirement for FILES.name/FOLDERS.name (§3.3, §3.4), closing a gap where REQUIREMENTS.md's name-comparison policy had no corresponding collation/normalization treatment.
- REQUIREMENTS.md's human-readable path-length limit clarified as distinct from `materialized_path` (§3.3), which stores an id-path, not a name-path — the byte-length check must be computed by walking the ancestor chain and summing name lengths, not read off `materialized_path` directly.
- SHARE_LINKS extended with password-attempt-throttling state (`failed_password_attempts`, `failed_attempts_window_started_at`, §3.8), closing a gap where REQUIREMENTS.md's throttling rule had no supporting schema at all.
- Trash-listing pagination indexes added (§5.4: owner-scoped for user-facing trash views, unqualified for the scheduled purge job's cross-user scan).
- The account-deletion cascade (§7 item #6) given explicit step ordering (which steps are manual pre-conditions vs. automatic `ON DELETE` side effects of the `DELETE FROM USERS` statement itself) and two previously-omitted entities added to it: FAVORITES (given `ON DELETE CASCADE` on `user_id`, §3.11) and PERMISSIONS-as-grantee (given `ON DELETE CASCADE` on `user_id`, §3.6, ordered to fire only after ownership reassignment completes).

---

## 7. Open Items for the Next Design Phase

The folder-move locking strategy, tag scope, team/group accounts, trash retention, admin audit sufficiency, and deduplication have all now been decided by the system owner and verified in Pass 5 (see the decisions blocks in §6) and are no longer open. What remains genuinely open — all implementation-level decisions, none requiring further owner input:

1. **The `transfer_ownership()` operation** needs to be fully specified (as a stored procedure/function or an application-transaction pattern) rather than just named. **(Pass 6 — scope clarification.)** As referenced throughout this document, `transfer_ownership()` is described only as a single-item, two-party operation (demote user A, promote user B, on one file or folder). REQUIREMENTS.md's account-deletion policy (§5.1.1 there) requires reassigning *every* item a deleted user owns to a replacement owner as an atomic precondition of deletion — this is a distinct, larger operation than a single `transfer_ownership()` call, and needs its own specification: most likely a bulk variant (e.g., `reassign_all_owned_items(from_user_id, to_user_id)`) that, within one transaction, either calls `transfer_ownership()` once per owned item or performs the equivalent bulk `UPDATE` directly against PERMISSIONS while still respecting the `DEFERRABLE INITIALLY DEFERRED` owner-uniqueness constraint (§3.6) and still triggering an EFFECTIVE_PERMISSIONS rebuild for every affected item (§3.7). This bulk operation is not yet designed and should be added as its own open item alongside `transfer_ownership()` itself.
2. **A periodic reconciliation/repair job** for the three denormalized values (`storage_used_bytes`, `materialized_path`, EFFECTIVE_PERMISSIONS) has not been designed — currently there is no detector for drift between derived state and source-of-truth tables if an event-driven update is ever missed.
3. **Rate limiting, and any admin-tier granularity beyond a single binary role**, were both explicitly out of scope for this pass.
4. **Thumbnail generation itself** (which library/service renders images, video frames, and PDF first-pages into a preview) is an implementation detail deliberately left unspecified here — this document only covers the queue/storage data model around it, not the rendering mechanism.
5. ~~**The 30-day trash retention window's scheduled-purge mechanism** needs to be specified...~~ **Resolved in Pass 6 (§5.2):** the mechanism is now specified to key each item's own 30-day deadline off that item's own individual trashing time (per REQUIREMENTS.md §5.4), scanning across all owners via the new unqualified `deleted_at`-based partial indexes (§5.4) rather than enumerating only top-level trashed roots. Removed from this open-items list.
6. **A full account-deletion cascade needs to be specified end to end.** *(Pass 6 — new open item; steps and ordering clarified across both rounds of this pass.)* Account deletion (a REQUIREMENTS.md-level feature, §5.1.1 there) touches more tables than DELETION_QUEUE's existing item-keyed cascade cleanup covers, since DELETION_QUEUE is scoped to cleaning up references to a deleted *item*, not a deleted *user*. The procedure has two kinds of steps — those that must run as explicit application-layer steps **before** the `DELETE FROM USERS` statement, and those that fire automatically as a database-level `ON DELETE CASCADE` side effect **of** that statement — and the two must not be confused with each other:
   - **Pre-steps, run in this order, before `DELETE FROM USERS` is issued (every other lettered step below fires automatically once this statement runs, and must not be manually duplicated):**
     1. **(a)** The bulk ownership-reassignment operation described in item #1 above, for every item the user owns — this must complete first, since it is the precondition the granting-authority check (§3.6) and step (c) below both depend on: `reassign_all_owned_items()` must finish moving ownership away from the deleted user *before* PERMISSIONS-as-grantee rows are cascade-deleted, so the reassignment's own PERMISSIONS writes (which still reference the outgoing owner mid-operation) aren't caught by that same cascade prematurely.
     2. **(e)** `SESSIONS` invalidation for the user (already efficient once `SESSIONS(user_id)` exists, §5.4) — must happen before the `DELETE FROM USERS` statement, since `SESSIONS.user_id` is a hard FK with no stated `ON DELETE` behavior and would otherwise block the delete or need its own cascade; explicit invalidation-then-deletion here is simpler than adding cascade behavior for a table that's about to be made moot anyway.
   - **The `DELETE FROM USERS` statement itself**, which triggers, automatically, at the database level, in whatever order Postgres processes the row's foreign keys (no ordering dependency exists between these, since each is independent): **(b)** `SHARE_LINKS` rows where `created_by` is the deleted user (`ON DELETE CASCADE`, §3.8); **(c)** `PERMISSIONS` rows where the deleted user is the *grantee* (`user_id`, as opposed to owner) — `ON DELETE CASCADE`, §3.6, added in Pass 6 round 2 — which must additionally trigger an application-layer EFFECTIVE_PERMISSIONS rebuild for every item so cascade-deleted, since the cascade itself only removes the source-of-truth PERMISSIONS row and does not touch the derived cache (§3.7); **(d)** `TAGS` cascade-delete, which in turn cascades to `ITEM_TAGS` (§3.12, already specified); and **(g)** `FAVORITES` rows where `user_id` is the deleted user (`ON DELETE CASCADE`, §3.11, added in Pass 6 round 2).
   - **(f)** `ACTIVITY_LOG` rows referencing the user as `actor_id` or `subject_user_id` are the one category that must survive the user row's deletion — per this document's own append-only/audit-trail design (§3.9), these rows should **not** be deleted or reassigned even though the user they reference is gone. This means `ACTIVITY_LOG.actor_id`/`subject_user_id` cannot be a hard, cascading foreign key; it must instead tolerate a dangling reference (`ON DELETE NO ACTION`/leave the FK nullable with no cascade) or, better, capture a denormalized display-name snapshot into `ACTIVITY_LOG.metadata` at write time so historical entries remain human-readable after the referenced user is long gone. This step requires no ordering relative to the others — it is a schema property (how the FK behaves), not an action performed during the deletion procedure.

   None of the above had been assembled into one specified, atomic account-deletion procedure prior to Pass 6; the ordering and per-step mechanism are now fully specified (round 2 closed the remaining gaps: (c) and (g) previously had no mechanism at all, and the pre-step/automatic-cascade distinction itself was previously unstated, leaving the relative ordering of all seven steps ambiguous) — but the procedure should still be written out as an actual stored procedure or application-transaction function before implementation, per item #1's bulk-reassignment operation which this procedure depends on.

---

*This document reflects the schema as of the seventh design iteration (v7), following six adversarial review passes. Every owner-level decision has been resolved, but — unlike the prior v6 revision of this document — this version is **not** described as final: Pass 6 left several substantive items open (see §7, items #1, #5, and #6 in particular) that should be resolved before implementation begins. It is intended as a complete conceptual reference in the areas that are settled — the next step is resolving the remaining §7 open items, then translating each entity, constraint, and behavioral rule described here into actual PostgreSQL DDL (`CREATE TABLE`, `CHECK`, trigger, and function definitions).*
