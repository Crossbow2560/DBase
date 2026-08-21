# DBase — Project Requirements

**Status:** Draft v6 — revised after a second fresh-eyes review (regression check on the prior pass's own fixes, plus a fresh completeness scan) covering both this document and DESIGN.md together. Closed a further batch of findings, including two long-standing cross-document mismatches that are now fully resolved in DESIGN.md (trash-retention clock rework, admin-view logging) rather than left as flagged open notes, plus a move-based access-stripping gap, a share-link-creator-vs-owner deactivation ambiguity, and several DESIGN.md-side gaps where this document's product requirements had outpaced the schema's support (resumable uploads, concurrent-mutation guards, name normalization, path-length enforcement, password-attempt throttling storage).
**Related doc:** [DESIGN.md](./DESIGN.md) — database design for this system (implementation detail; not duplicated here)

---

## 1. Overview

DBase is a self-hosted, multi-user cloud file storage system — functionally comparable to a self-hosted Dropbox or Nextcloud. It gives each user private, quota-limited storage with folder organization, sharing, and basic file-management conveniences, plus an administrative role for oversight.

This document defines *what* the system must do. It does not prescribe database schema, API design, or infrastructure — see DESIGN.md for the data model.

## 2. Goals

1. Support multiple independent user accounts, each with a private storage space.
2. Allow hierarchical, nested folder organization of arbitrary depth.
3. Support core file operations: upload, download, rename, move, delete, and search by name.
4. Support sharing, both to specific people and via public links.
5. Enforce per-user storage quotas at upload time.
6. Provide an admin role with system-wide visibility and control.
7. Provide favorites, tags, and generated thumbnails/previews as user conveniences.

## 3. Non-Goals

The following are explicitly out of scope for this phase:

- **File version history.** Overwriting a file's content requires deleting and re-uploading; there is no "restore a previous version" capability, and same-name uploads are rejected rather than silently creating a new version (see §5.3).
- **Real-time collaborative editing.** This is a file store, not a document editor.
- **End-to-end encryption.** If required, it is the user's/application's responsibility, not a system guarantee.
- **Team or group accounts.** Sharing is always to an individual person or via a public link — there is no concept of a group with shared access.
- **Notifications.** The system does not need to proactively notify users of sharing events, access changes, or expiring links. Users can discover shares via the "Shared with me" view (§5.5). May be reconsidered later.
- **Rate limiting / lockout on login attempts.** Not required in this phase (password reset *is* required — see §5.1). May be reconsidered later.
- **Multi-factor authentication (MFA).** Not required in this phase. May be reconsidered later.
- **A documented public API for third-party/programmatic clients.** Not required in this phase; the system needs only whatever interface its own client(s) use internally.
- **Internationalization/localization of the UI.** Not required in this phase. (Filename character-set handling is still in scope — see §5.3.)

---

## 4. User Roles

| Role | Description |
|---|---|
| **User** | A standard account holder. Has a private storage space, a quota, and full control over their own files/folders and what they choose to share. |
| **Admin** | A super-user role. Can see all users' files, storage usage, and activity; can change any user's quota or permissions. Intended for system oversight, not day-to-day file use. |

Any authenticated user can hold either role; role is a simple binary flag, not a spectrum of admin tiers.

An admin can demote another admin back to a regular user, or demote themselves. **The system must never allow an action that would leave zero admin accounts in the system.** An attempt to demote, deactivate, or delete the last remaining admin account must be rejected with a clear error explaining why, unless and until at least one other admin account exists. (This does not apply to the very first admin's creation on a brand-new deployment, per §5.1 — that is the bootstrap case where zero admins is the expected starting state.)

---

## 5. Functional Requirements

### 5.1 Accounts and Access

- **Registration is open:** any visitor can self-register a new account without an invitation or admin approval. The `admin` role is not grantable through self-registration — it must be assigned by an existing admin after the account exists. (The very first admin account's creation, for a brand-new deployment with zero existing admins, is an operational/setup concern outside this document's scope — e.g. a one-time setup step or config flag — but the system must provide *some* mechanism for it, since without one no admin could ever be created.)
- **Registration requirements:** each account requires a unique email address — attempting to register with an email already in use must be rejected with a clear error, without confirming or denying whether that email belongs to an existing account in a way that would let an attacker enumerate registered users (a generic "unable to complete registration" message satisfies this). A password must meet a minimum strength policy (at minimum: 8+ characters); the exact policy is an implementation detail, not fixed by this document. Email verification (confirming the registrant controls the email address before the account is fully usable) is not required in this phase — deferred, see §8.
- **New account default state:** a newly self-registered account is assigned a default storage quota, set by system-wide configuration (not by the registering user), which an admin can subsequently change per-user per §5.6. The default quota's specific value is a deployment/operational configuration choice, not fixed by this document — the requirement is only that every new account starts with *some* defined, non-negative quota rather than an undefined or unlimited one.
- Users must be able to log in and maintain sessions across multiple devices.
- Users must be able to log out of individual devices/sessions without affecting others.
- **Password reset:** users must be able to reset a forgotten password through a self-service flow (e.g., an emailed reset link), without administrator involvement.
- Each account has its own private storage space, not visible to other users by default.
- **Account deactivation** (soft-disable) is an admin-only action, distinct from account deletion (§5.1.1). The moment an account is deactivated:
  - Every active session belonging to that user is immediately invalidated; the user is logged out everywhere and cannot log back in until reactivated.
  - Any public share link created by that user immediately stops granting access (requests against it must be denied), for as long as the account remains deactivated.
  - Any item that user directly shared with other users immediately stops granting those other users access, for as long as the account remains deactivated.
  - None of the deactivated user's data (files, folders, metadata, ownership) is deleted or altered — deactivation is fully reversible by an admin reactivating the account, which restores all of the above.

#### 5.1.1 Account Deletion

Account deletion is a distinct, harder, and irreversible action — separate from deactivation above.

- Account deletion can be performed by an admin, or requested by the user themselves for their own account (self-service). Either path requires the same handling below.
- Before an account can be deleted, every file and folder it owns must be reassigned to a new owner. Deletion must not proceed while any owned item remains without a valid replacement owner (this preserves DESIGN.md's "every item has exactly one owner at all times" invariant).
  - **Default policy:** if the deleting party (user or admin) does not explicitly choose a replacement owner for each item, all of the deleted user's owned files and folders are reassigned to a designated system admin account.
  - An admin performing the deletion may instead explicitly reassign some or all of the user's items to a specific other user before or as part of the deletion.
  - A self-service deletion always uses the default policy (reassignment to the designated system admin account) — a departing user cannot choose who inherits their files.
- Deleting an account cascade-deletes that user's own tags (per DESIGN.md §3.12) without affecting the files/folders those tags were applied to.
- Deleting an account permanently invalidates every public share link that user created, and permanently removes every direct share grant that user had made to others or that others had made to them, effective immediately.
- Account deletion cannot be undone. There is no trash/recovery period for a deleted account itself (individual files owned by that account, if already in the file-level trash at the time of deletion, still follow the normal file trash/retention rules in §5.4 under their new owner).

### 5.2 Folders

- Users can create nested folders to any depth, subject only to the filename/path-length limit below (there is no separate, independently-enforced maximum *depth* count).
- Individual file and folder names are limited to **255 bytes when UTF-8 encoded** (matching common filesystem/object-store limits), and the fully-qualified path from root to any item must not exceed **4096 bytes** UTF-8 encoded. An operation (create, rename, or move) that would exceed either limit is rejected with a clear error (per §5.12) rather than silently truncated.
- Users can rename and move folders, including moving a folder into another folder.
- Folder names are compared **case-sensitively** and after Unicode normalization (so visually-identical names composed of different Unicode code points are treated as the same name, but names differing only in letter case are treated as different names). Leading/trailing whitespace is trimmed before comparison.
- Two live (non-trashed) folders with the same name cannot exist side-by-side in the same parent. Attempting to create or move a folder into a position that would collide with an existing live folder's name is rejected with an error; the system never silently renames or silently overwrites.
- Moving a folder must move its entire contents with it; a folder can never end up nested inside itself or one of its own subfolders (attempting this is rejected with an error).

### 5.3 Files

- Users can upload files, including large files that may need to be uploaded in parts.
- **Interrupted uploads:** if a multipart upload is interrupted (network drop, client crash, browser closed) before completion, the parts already successfully transferred are not lost — the same upload session can be resumed from the next unsent part, provided the client resumes within the upload session's expiration window (an operational/implementation-level duration, not fixed by this document). An upload session that is never resumed before it expires is automatically abandoned and cleaned up (its partially-transferred bytes removed from storage and not counted against the user's quota, per §5.6). Users must be able to explicitly cancel an in-progress or resumable upload themselves, which triggers the same cleanup immediately rather than waiting for expiration.
- Users can download, rename, move, and delete their own files, plus any file another user has shared with them at editor level or above (per §5.5).
- File names follow the same case-sensitive, Unicode-normalized, whitespace-trimmed comparison rule as folder names (§5.2).
- Two live (non-trashed) files with the same name cannot exist side-by-side in the same folder. **Uploading a file whose name collides with an existing live file in the same target folder is rejected with an error before any bytes are transferred; the existing file is never silently overwritten or auto-renamed, and no new version is created.** The uploading user must rename the incoming file, remove/rename the existing one, or choose a different destination folder.
- A file's access permissions must always reflect its *current* folder location: moving a file into a folder shared with other users immediately grants those users access per that folder's sharing (subject to the permission-conflict rule in §5.5), and moving it out of a shared folder immediately removes any access those users held solely because of that folder location.
- **Moving an item requires editor-or-above access to both the item being moved and the destination folder.** Editor access to an item alone is not sufficient to move it into an arbitrary destination — the mover must also independently hold at least editor access on the destination folder (as its owner, a direct grantee, or via an inherited share). This prevents an editor who only has rights on the item itself from using a move to expose it to a wider audience than the item's owner intended (e.g., moving someone else's shared file into an unrelated folder the mover happens to control, including one exposed via a public share link) — without this rule, editor rights on a file alone would let its access be effectively widened by a move, bypassing the owner's original sharing decision entirely.
- **A move that would cause anyone other than the mover to lose access they currently hold requires the mover to be the item's owner — a non-owner editor may not perform such a move.** This closes the mirror-image gap the rule above doesn't cover: without it, a non-owner editor could move a file out of a folder shared with many people into a folder only the mover controls, unilaterally stripping every other user's access with no say from the item's actual owner. A non-owner editor may still move an item to a destination that grants the *same or a broader* set of users access (including moving it somewhere only they themselves control, if no one else currently has access to strip); only a move that would remove someone else's existing access requires owner-level authority.
- Users can search their own accessible files and folders (owned, or shared with them) by name. Search matches on filename/foldername; partial and case-insensitive matching must be supported at minimum.
- **Concurrent mutation during an active download:** renaming, moving, or trashing a file does not need to interrupt a download of that file already in progress — a download that has already started is allowed to complete using the file's content and identity as of when the download began, even if the file is renamed, moved, or trashed by someone else during the transfer. A download attempt that *starts* after the file has been trashed or permanently deleted must fail with a clear "no longer available" error rather than serving stale content.
- **Concurrent mutation during an active upload:** an in-flight multipart upload session is tied to the destination folder and filename chosen at the time the session started. If that destination folder is trashed, or renamed/moved in a way that would now collide with the in-progress upload's target name, while the upload is still in flight, the upload session must fail cleanly on its next part (or at completion, whichever comes first) with a clear error, rather than silently succeeding into an unexpected location or silently colliding with something else that now occupies the original target.

### 5.4 Deletion and Trash

- Deleting a file or folder moves it to a trash/recoverable state (soft delete) rather than deleting it immediately. Trashing a folder trashes its entire contents in the same action.
- Items in trash can be restored to their original location and state, **provided restoration is requested before that item's permanent deletion has been enqueued** (see below) — once enqueued, restoration is no longer possible, regardless of whether the underlying data has actually been erased yet.
- **Each file and folder tracks its own independent 30-day trash retention clock**, starting from the moment that specific item was individually placed in trash — not from when any ancestor folder was trashed. (Concretely: if a folder is trashed and, three days later, a file inside it is separately force-deleted, the file's permanent deletion is unaffected by the folder's own 30-day clock, and vice versa — each item's clock runs independently to its own 30-day deadline.) DESIGN.md's scheduled-purge mechanism (§5.2 there) has been reworked to match this rule.
- An item remaining in trash for 30 days from its own individual trashing time is automatically and permanently deleted.
- Users must also be able to permanently delete an item immediately ("delete forever"), without waiting for the 30-day window. Requesting immediate permanent deletion is what starts the "enqueued" state referenced above — from that moment, the item can no longer be restored, even before the underlying data is physically erased.
- Restoring a file or folder whose original parent folder is unavailable — either because that parent has itself since been permanently deleted (gone for good), **or because that parent is still merely trashed and has not itself been restored** — restores the item to the user's root-level space instead, without overwriting anything, so it never silently collides with a newer item that may since occupy the same name/location. (A still-trashed-but-not-yet-purged parent is deliberately treated the same as a permanently-deleted one for this purpose: restoring a child *into* a still-trashed parent would recreate exactly the inconsistent "live item unreachable through a trashed ancestor" state the trashing operation itself is required to prevent — restoring to root avoids that, and the user can manually move the item back under its original parent once that parent is also restored, if they still want that structure.)

### 5.5 Sharing

- Users can grant another specific registered user access to a file or folder, at one of exactly two **grantable** permission levels: **viewer** (read/download only) or **editor** (read/download, rename, move, delete, re-share at viewer or editor level, and any other write action defined elsewhere in this document as requiring editor access). No other grantable permission levels exist in this phase (e.g., no comment-only, no download-disabled-view-only). This is distinct from **owner** (§5.5 below), which is not something one user grants another — every item always has exactly one owner, and that role carries responsibilities (transferable only as a whole, never shared) that don't apply to a viewer/editor grant.
- Users can revoke access they've previously granted. Revocation must be enforced on every subsequent access attempt starting immediately after the revoking action completes — there is no acceptable delay window; any internal caching used for performance must never allow a revoked user to successfully read or write the item after revocation, even if that requires falling back to a slower, authoritative check.
- Users can view a **"Shared with me"** listing of every file and folder that has been directly shared with them or that they have access to via a shared folder, distinct from their own owned items.
- Users can generate a public share link for a file or folder that allows access without requiring an account, at **viewer** or **editor** level, optionally protected by a password and/or an expiration date. There is no limit on the number of public share links a user may create. **Both the owner and any editor-level user on the item may create a public share link for it** (public-link creation is one of the write actions an editor's re-share right, above, covers — it is not restricted to the owner alone). **A link's availability is tied to its own specific creator, not to the item's owner: if a non-owner editor creates a link and that editor's account is later deactivated (§5.1) or deleted (§5.1.1), the link goes down or is permanently invalidated exactly as if that editor were the owner — the item's actual owner keeping their own account active does not keep a link some other editor created alive.** This is a deliberate, single consistent rule (a link's fate always follows its own creator) rather than a gap introduced by allowing non-owner editors to create links.
- **Re-sharing rules for an editor (whether granting to another specific user or creating a public link):** an editor can grant a permission level up to and including their own (viewer or editor) — never higher, and never `owner`, which is not a grantable level at all (§5.5 above). Sharing an item with a user who already has access simply updates that user's grant to the higher of the two levels, per the conflict-resolution rule above — it is not an error. Sharing an item with its own current owner is a no-op with no effect (the owner already has implicit full access via ownership and gains nothing from an explicit grant). A user cannot grant access to themselves (self-sharing is meaningless and must be rejected or silently ignored, consistently with how the system already handles any other no-op grant).
- Repeated failed password attempts against a password-protected public share link must be throttled per link, identified by the link's own token — not per requester identity, IP address, or any other client-supplied signal that could be trivially rotated or spoofed to bypass a per-requester limit. Specifically: after no more than **10 consecutive failed password attempts against the same link token within a 15-minute window**, further attempts against that token must be rejected (independent of who or what is making them) for at least the remainder of that window, regardless of source. This throttling applies to the link's password only, not to the unguessable link token itself.
- Public share links can be revoked (deleted) by their creator at any time, with the same immediate-enforcement guarantee as direct-share revocation above.
- **A public link on a folder grants the anonymous visitor the ability to browse and access every item currently inside that folder** (files and subfolders alike, per the dynamic-sharing rule below), navigating the folder's contents the same way an authenticated viewer/editor would, at the link's own permission level. A public link exists only on the specific item it was created for — there is no independent, separately-generated public link automatically created for each nested subfolder; an anonymous visitor reaches nested items only by navigating through the originally-linked folder. Downloading the folder as a single packaged archive (e.g., a .zip) is not required in this phase; downloading individual files within it is sufficient.
- **Folder sharing is dynamic, not a point-in-time snapshot:** sharing a folder extends the same access to everything currently inside it and to anything added to it later, for as long as the share remains in effect.
- **Permission conflict resolution:** when a user has access to the same file or folder through more than one path at once (e.g., a direct share on the item itself, and separately an inherited grant from a shared ancestor folder), the **highest** of the applicable permission levels always applies. A user's effective access to an item is never lower than the highest level granted to them through any path.
- Every file and folder has exactly one owner at all times; ownership can be transferred to another registered user by the current owner or by an admin.
- Deleting the owner's account is handled per §5.1.1 (ownership reassignment), not by this section.

### 5.6 Storage Quotas

- Each user has a maximum amount of storage, in bytes, they may use.
- A quota of exactly **0 bytes** is a valid, admin-settable value; it blocks any action that would increase the user's stored byte count (uploads, and completing an upload session), but does **not** block actions that consume no additional bytes (creating an empty folder, renaming, moving, tagging, favoriting, or deleting/trashing existing items). Negative quota values are invalid and must be rejected as input.
- Any upload — including each part of a multipart/chunked upload — that would cause the user's stored byte total to exceed their quota upon that part's completion must be rejected at the point the excess would occur, not allowed to complete and fail/roll back afterward. A multipart upload that is rejected partway through must not leave the user's usage or quota state worse off than before the upload began (any partial bytes already transferred for the rejected upload must not count toward or block future uploads).
- Only an admin can change a user's quota; a user cannot change their own quota through any self-service path.
- An admin must be able to reduce a user's quota below their current usage (to cap further uploads) without that action failing or corrupting existing data. A user already over their (newly-lowered) quota keeps full access to their existing files (view, download, rename, move, delete) but cannot add further bytes until they free up enough space to be at or under quota again.
- Permanently deleting a file (i.e., completion of its purge from trash, not merely trashing it) frees up the corresponding quota for future uploads. Merely trashing a file does **not** free quota — a trashed file still counts against the owner's usage until it is permanently deleted or restored.

### 5.7 Favorites

- An authenticated user can mark any file or folder they currently have at least **viewer**-level access to (as an owner, direct grant, or inherited folder share) as a favorite, independent of who owns it. Access via an anonymous public share link does not qualify — favoriting requires the actor to be a logged-in registered user with a permission grant on the item.
- Users can unmark a favorite at any time.
- Favorites are resolved for display the same way any other access check is — at the time the favorites list (or any other view surfacing a favorited item) is rendered. If a user has lost the access that qualified an item as a favorite, that item must not appear the next time their favorites are displayed. This does not require the system to eagerly detect and react to the exact moment access is lost — the guarantee applies to what is shown/returned at time of viewing, not a continuously real-time-updated background state.
- **The favorite record itself must only be permanently removed when the access loss is itself permanent** (e.g., the item was permanently deleted, or the specific grant was explicitly revoked by the person who made it) **— not when the access loss is a side effect of a reversible state elsewhere in the system, such as the item owner's or a sharing user's account being deactivated (§5.1).** Concretely: if User B favorited a folder that User A shared with them, and User A's account is later deactivated (which per §5.1 immediately and temporarily suspends A's shares to others), B's favorite entry must be hidden from B's favorites list for as long as A stays deactivated, but must **not** be deleted outright — it must reappear automatically, with no action required from B, the moment A's account is reactivated and the share resumes. A favorite may only be silently dropped from storage (not merely hidden) when the underlying reason access was lost cannot itself be reversed by another party's later action.

### 5.8 Tags

- Users can create their own personal tags/labels and apply them to files and folders they have at least **editor**-level access to.
- Tags are personal to the user who created them — not shared or visible to other users, even on items that user doesn't own.
- Deleting a user's account removes their tags (per §5.1.1); it does not affect the tagged files/folders themselves.

### 5.9 Thumbnails and Previews

- The system must generate a preview thumbnail, on a best-effort basis, for any file whose declared type is an image, a video, or a PDF (i.e., any file with an `image/*`, `video/*`, or `application/pdf` type). "Best-effort" means: the system must attempt generation for every file of these general categories, but a specific format/subtype/codec the thumbnailing mechanism does not support is an acceptable failure, not a requirements violation — the file remains fully usable, only its preview is unavailable, and this must be surfaced to the user as a normal "no preview available" state rather than an error.
- Thumbnail generation must not block or delay the upload itself — it happens in the background, after the upload completes.
- A file's thumbnail must never be generated, or served to any user, once that file has been **either soft-deleted (trashed) or permanently deleted.** A thumbnail-generation job still in progress when a file is trashed must not write a thumbnail for it; a previously-generated thumbnail for a trashed file must stop being served for as long as the file remains trashed, and must become available again if the file is restored.
- **On restore, if a ready thumbnail for the file still exists in storage, it must simply resume being served (no regeneration needed).** If no thumbnail was ever successfully generated before the file was trashed (generation was still pending, or had already failed, or was skipped by the trashing-in-progress rule above), restoring the file must trigger a fresh thumbnail-generation attempt, following the same best-effort background process as a new upload (§5.9 above) — a restored file is never left permanently without a preview attempt just because its original generation window was interrupted by a trash/restore cycle.

### 5.10 Administration

Admins must be able to:

- View any user's files and folders, regardless of ownership or sharing settings. Every instance of an admin viewing another user's file or folder contents (not just mutating actions) must be recorded in the activity log, distinctly attributable to that admin, per §5.13 — "view" is itself a loggable action, not merely the write actions below.
- See system-wide and per-user storage usage statistics.
- See usage-frequency data (how often files/folders are accessed).
- Change any user's permissions, including reassigning ownership of an item.
- Change any user's storage quota, subject to the bounds in §5.6.
- Deactivate, reactivate, and delete any user account, per §5.1 and §5.1.1.
- All admin actions taken on another user's account or data — including viewing — must be auditable: recorded in a way that clearly shows who performed the action (the admin) and whose account/data was affected (the other user), distinct from that user's own self-service actions on their own data. No additional justification/reason text is required beyond this who-did-what-to-whom-and-when record.

### 5.11 Listing Behavior

- Any view that lists a potentially unbounded set of items (a folder's contents, search results, trash, "Shared with me," an admin's view of a user's files, activity log history) must support pagination rather than requiring the entire result set to be returned or rendered at once.
- An empty result (an empty folder, no search matches, empty trash, nothing shared with the user, no activity in a given window) must be displayed as a clear, explicit empty state — distinct from a loading state or an error state — never left blank or ambiguous as to whether the emptiness is expected or a failure.
- Default sort order for folder contents is by name, ascending; users must be able to change this to at least sort by most-recently-modified. No specific sort order is mandated for search results beyond relevance to the search term.

### 5.12 Error Feedback

- When an action fails because it would exceed the user's storage quota, or because the acting user lacks sufficient permission on the target item, the system must surface a clear, specific, human-readable reason to the user — distinguishing at minimum between "insufficient storage quota" and "insufficient permission" — rather than a generic or unexplained failure. This applies to every user-facing surface where these failures can occur (uploads, and any write action gated by editor/owner access).

### 5.13 Activity Logging

- The system must record a history of key actions for accountability and for powering admin usage statistics, at minimum: upload, download, rename, move, delete (soft), restore, permanent delete, share (grant), unshare (revoke), create/revoke share link, favorite/unfavorite, tag/untag, quota change, permission change, ownership transfer, account deactivation/reactivation, account deletion, and — for admins specifically — viewing another user's files or folders.
- Every log entry must record who performed the action and, when the action affects another user's account or data (as with admin actions), whose account/data was affected, distinctly from each other.

---

## 6. Non-Functional Requirements

- **Data integrity:** no user should ever be able to access a file or folder they have not been granted access to, directly or via a share — **except an admin, whose system-wide read access is an intentional, defined exception to this rule per §5.10, not a violation of it.**
- **Consistency of access control:** revocation of access (direct share, folder share, public link, or account deactivation) must be enforced on the very next access attempt after the revoking action completes, with no acceptable propagation delay — any internal performance caching must never be trusted as the sole source of truth for a security-sensitive decision, and must fall back to an authoritative, up-to-date check when in doubt.
- **Reliability of deletion:** a permanently deleted file's underlying data must eventually be fully removed from storage; a failed deletion attempt must not silently leave orphaned data or an inconsistent state indefinitely — it must be retried and, if repeatedly unsuccessful, surfaced for manual investigation rather than dropped.
- **Availability during long operations:** large uploads and thumbnail generation must not block other users', or the same user's, ability to use the rest of the system concurrently.
- **Auditability:** admin actions on other users' accounts or data, including viewing, must be distinguishable from a user's own self-service actions in any historical record.
- **Self-hosted deployment:** the system is designed to run on infrastructure the operator controls (not a large multi-tenant SaaS), and requirements should be read with that deployment scale in mind.

---

## 7. Assumptions and Constraints

- Single organization/operator self-hosting the system; not designed for large-scale multi-tenant SaaS use.
- No requirement for real-time multi-user co-editing of file contents.
- No requirement for encrypting file contents at the application/database level.
- No requirement for group or team-based access — all sharing is user-to-user or via public link.
- No requirement for a documented third-party/programmatic API, UI localization, or proactive notifications in this phase (see §3, Non-Goals).
- No enforced maximum file size or restricted file-type allowlist/denylist is defined in this phase; the system must support arbitrarily large multipart uploads and any declared MIME type, subject only to the quota rules in §5.6.

---

## 8. Future Considerations

Explicitly deferred, not ruled out — may be added in a later phase:

- **Deduplication** of identical file content.
- **Notifications** for sharing events (access granted/revoked, link expiring soon).
- **Login rate limiting / account lockout** after repeated failed authentication attempts.
- **Multi-factor authentication (MFA)** for login.
- **A documented public/programmatic API** for third-party or sync clients.
- **UI localization/internationalization.**
- **File size limits and/or a file-type allow/deny list**, if operational experience shows this is needed.
- **A defined list of specific supported thumbnail formats/subtypes**, if best-effort coverage (§5.9) proves insufficient in practice.
- **Email verification** at registration (confirming the registrant controls the email address before the account is fully usable).
- **Downloading a shared folder as a single packaged archive** (e.g., .zip), for both authenticated users and public-link visitors.

---

*This document defines product/functional requirements only. For the database schema, entity design, and implementation-level decisions, see DESIGN.md.*
