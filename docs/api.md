# API

Base path: `/api/v1`. The backend listens on `PORT` (3000). Browsers reach it through the frontend origin (`http://localhost:3001/api/v1/...`), which proxies the requests.

There is also an unversioned `GET /health` → `{"status":"ok"}`.

## Conventions

- **Auth:** an httpOnly cookie, `dbase_session` (or `SESSION_COOKIE_NAME`), set by `POST /auth/login`, **or** a device token sent as `Authorization: Bearer dbt_…` (for non-browser clients such as `dbase-sync`; see [Device tokens](#device-tokens)). Routes marked 🔒 accept either. Routes marked 🍪 require a cookie login. Routes marked 🛡 also require `role = "admin"`.
- **Bodies:** JSON, except upload parts, which are raw `application/octet-stream`.
- **`:type` path segment:** always `file` or `folder`.
- **Byte counts:** returned as **strings** (they are BigInt-backed), e.g. `"storageUsedBytes": "1048576"`.
- **Empty successes:** mutations with no payload return `204 No Content`.

### Error format

```json
{ "error": { "code": "NAME_COLLISION", "message": "..." } }
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_ERROR`, `PART_TOO_SMALL`, `WEAK_PASSWORD`, `REGISTRATION_FAILED`, `NAME_TOO_LONG`, `PATH_TOO_LONG`, `NOT_A_FOLDER`, `INVALID_RESET_TOKEN`, `INVALID_VERIFICATION_TOKEN`, `INVALID_JSON`, `INVALID_EMAIL`, `INVALID_SUBJECT`, `INVALID_BODY` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `PASSWORD_REQUIRED` / `INVALID_PASSWORD` (share link), `INVALID_SIGNATURE`, `INBOUND_NOT_CONFIGURED` |
| 403 | `ACCOUNT_DEACTIVATED`, `EMAIL_NOT_VERIFIED`, `INSUFFICIENT_PERMISSION`, `REGISTRATION_CLOSED`, `COOKIE_SESSION_REQUIRED` (a 🍪 route called with a device token) |
| 404 | `NOT_FOUND` (also returned when you lack access, so existence isn't leaked), `SESSION_NOT_FOUND`, `DEVICE_TOKEN_NOT_FOUND`, `UPLOAD_SESSION_NOT_FOUND`, `NO_LONGER_AVAILABLE`, `SYNC_ROOT_UNAVAILABLE` |
| 409 | `UPLOAD_IN_PROGRESS` (retry the completion shortly), `NAME_COLLISION`, `CYCLE_DETECTED`, `NOT_IN_TRASH`, `PURGE_IN_FLIGHT`, `UPLOAD_SESSION_INVALID`, `CONTENT_CONFLICT` (a replace's `expectedVersion` is stale, or the file was trashed), `TOO_MANY_DEVICE_TOKENS`, `LAST_ADMIN`, `NO_SYSTEM_ADMIN`, `SYSTEM_STORAGE_ALLOCATION_EXCEEDED` |
| 410 | `CURSOR_EXPIRED` (sync cursor older than the change log's retention) |
| 411 | `LENGTH_REQUIRED` (upload part without `Content-Length`) |
| 413 | `PART_TOO_LARGE` (upload part over 64 MiB) |
| 422 | `QUOTA_EXCEEDED`, `SYSTEM_STORAGE_LIMIT_EXCEEDED` |
| 429 | `RATE_LIMITED` (comes with a `Retry-After` header) |
| 500 | `INTERNAL_ERROR` |

### Rate limits

The client IP is taken from `X-Forwarded-For` as appended by trusted proxy hops (`TRUST_PROXY`); the Next.js frontend is always one of them.

| Class | Limit | Key |
|---|---|---|
| Ceiling (every request) | 1200 / min (`RATE_LIMIT_PER_IP_PER_MINUTE`) | client IP |
| Default (all routes) | 300 / min | device token hash, session cookie hash, or IP |
| register, login, password-reset request, resend-verification | 20 / 15 min | IP |
| Write-heavy (create, move, rename, delete, tags, favorites, admin mutations) | 60 / min | session |
| Upload session start (`POST /files`) | 300 / min | session |
| Device token creation | 10 / min | session |
| Sync batch (`POST /sync/batch`, ≤100 ops each) | 30 / min | session |
| Sync download URLs (`POST /sync/download-urls`, ≤200 files each) | 60 / min | session |
| Admin backup and restore | 3 / 10 min | session |
| Public share-link routes, inbound email webhook | 300 / min | client IP |
| Public share-link folder zip | 10 / min | client IP |
| Upload parts | none; authenticated part requests don't count toward the ceiling, failed authentications do | — |
| Authenticated folder zip downloads | none (ceiling still applies) | — |

---

## Auth and account

| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| POST | `/auth/register` | — | `{ email, password (≥8), displayName }` | `201 { user }`, sends a verification email |
| POST | `/auth/verify-email` | — | `{ token }` | `200 { message }` |
| POST | `/auth/resend-verification` | — | `{ email }` | `200 { message }` (always) |
| POST | `/auth/login` | — | `{ email, password }` | `200 { user }` + `Set-Cookie` |
| POST | `/auth/logout` | 🔒 | — | `204`, revokes the current session (with a device token: revokes that token) |
| GET | `/auth/me` | 🔒 | — | `{ user: { id, email, displayName, role } }` |
| GET | `/auth/sessions` | 🍪 | — | `{ sessions: [{ id, device_info, created_at, expires_at }] }` |
| DELETE | `/auth/sessions/:sessionId` | 🍪 | — | `204` |
| POST | `/auth/device-tokens` | 🍪 | `{ name }` (1–100 chars) | `201 { deviceToken: { id, name, created_at, token } }`. `token` is shown only here |
| GET | `/auth/device-tokens` | 🍪 | — | `{ deviceTokens: [{ id, name, created_at, last_used_at }] }` |
| DELETE | `/auth/device-tokens/:tokenId` | 🍪 | — | `204` (revokes it) |
| POST | `/auth/change-password` | 🍪 | `{ currentPassword, newPassword }` | `204`. Also revokes every device token |
| POST | `/auth/password-reset/request` | — | `{ email }` | `200 { message }` (always) |
| POST | `/auth/password-reset/confirm` | — | `{ token, newPassword }` | `200 { message }` |
| PATCH | `/users/me` | 🔒 | `{ displayName }` | `{ user }` |
| DELETE | `/users/me` | 🍪 | — | `204`. Deletes the account; owned items are reassigned to the oldest active admin. |
| GET | `/users/me/storage` | 🔒 | — | `{ storageUsedBytes, storageQuotaBytes }` |
| GET | `/users/me/storage-breakdown` | 🔒 | — | `{ categories: [{ category: "documents"\|"images"\|"videos", bytes }] }` |
| GET | `/users/lookup?email=` | 🔒 | — | `{ user: { id, email, displayName } }` or `404` |

```bash
curl -c jar -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"changeme123"}' \
  http://localhost:3000/api/v1/auth/login
```

### Device tokens

A device token is a long-lived bearer credential for a non-browser client. It has no expiry: it works until it's revoked (`DELETE /auth/device-tokens/:id`, `POST /auth/logout` sent with the token, a password change or reset, or account deactivation). It's stored only as a SHA-256 hash. A token authenticates every 🔒 route exactly like a session, but can't manage credentials (🍪 routes), so a leaked token can't mint more tokens or take over the account. At most 50 active tokens per user.

```bash
TOKEN=$(curl -sb jar -H 'Content-Type: application/json' -d '{"name":"laptop"}' \
  http://localhost:3000/api/v1/auth/device-tokens | jq -r .deviceToken.token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/auth/me
```

## Folders and files

| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| GET | `/folders/contents` | 🔒 | — | Root listing: `{ folder: null, items }` |
| GET | `/folders/:id/contents` | 🔒 | — | `{ folder: { id, name, parentFolderId }, ancestors: [{id,name}], items }` |
| POST | `/folders` | 🔒 | `{ name, parentFolderId? }` | `201 { folder }` |
| POST | `/folders/tree` | 🔒 | `{ paths: ["Photos", "Photos/2024", …], parentFolderId? }` (≤10,000) | `201 { folders: { <path>: id }, roots: { <path>: finalName } }` |
| PATCH | `/folders/:id` | 🔒 | `{ name?, parentFolderId? }` (rename and/or move) | `{ folder }` |
| DELETE | `/folders/:id` | 🔒 | — | `204` (moves to trash) |
| GET | `/folders/:id/download-zip` | 🔒 | — | Streamed `application/zip` |
| PATCH | `/files/:id` | 🔒 | `{ name?, folderId? }` | `{ file }` |
| DELETE | `/files/:id` | 🔒 | — | `204` (moves to trash) |
| GET | `/files/recent?limit=6` | 🔒 | — | `{ items }` (limit 1–50): newest files anywhere under My Files (your root files plus everything in your root folders, at any depth), by last change; each with `createdAt`, `parentFolderId` and `location` |
| GET | `/files/:id/download` | 🔒 | — | `{ url }` (presigned MinIO URL) |
| GET | `/files/:id/preview` | 🔒 | — | `{ available: true, url, ... }` or `{ available: false }` |
| GET | `/files/:id/thumbnail` | 🔒 | — | `{ available: true, url }` or `{ available: false }` |

Names are NFC-normalized and trimmed. A name may be at most 255 bytes, and the full human-readable path at most 4096 bytes.

`POST /folders/tree` creates a folder upload's whole directory structure in one request (implied ancestors included; requires editor access to `parentFolderId`). A top-level folder whose name is already taken at the destination is created as `Name (2)`, `Name (3)`, …, never merged. Both maps in the response are keyed by the exact path strings that were sent. Files are then uploaded into the returned folder ids with the normal upload endpoints.

### Upload (chunked)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/files` | `{ targetName, totalParts (≥1), targetFolderId?, checksum? }`, or to replace an existing file's content: `{ replaceFileId, totalParts, expectedVersion?, checksum? }` | `201 { uploadSessionId, expiresAt }` |
| PUT | `/files/upload-sessions/:id/parts/:partNumber` | raw bytes (`application/octet-stream`, with `Content-Length`, ≤64 MiB) | `204` |
| POST | `/files/upload-sessions/:id/complete` | `{ mimeType? }` | `{ file }` (including its content `version`). Idempotent: repeating it returns the same file; `409 UPLOAD_IN_PROGRESS` while the first is still finalizing |
| DELETE | `/files/upload-sessions/:id` | — | `204` (cancels and credits quota back) |

```bash
SID=$(curl -sb jar -H 'Content-Type: application/json' \
  -d '{"targetName":"photo.jpg","totalParts":1}' \
  http://localhost:3000/api/v1/files | jq -r .uploadSessionId)
curl -b jar -X PUT -H 'Content-Type: application/octet-stream' --data-binary @photo.jpg \
  http://localhost:3000/api/v1/files/upload-sessions/$SID/parts/0
curl -b jar -H 'Content-Type: application/json' -d '{"mimeType":"image/jpeg"}' \
  http://localhost:3000/api/v1/files/upload-sessions/$SID/complete
```

Parts are **0-indexed** (`0 … totalParts-1`). Every part except the last must be at least 5 MiB (MinIO's compose minimum), and no part may exceed 64 MiB. Parts can be sent in any order and concurrently; the web client sizes parts at about 1/16 of the file (5–32 MiB) and keeps 4 in flight per file. `Content-Length` is required: quota is charged for the declared length and the body is streamed straight to storage, which rejects a body that doesn't match it. `complete` fails with `UPLOAD_SESSION_INVALID` unless all `totalParts` parts have been received. Sessions expire after `UPLOAD_SESSION_TTL_MINUTES` (60).

`checksum` is the client's lowercase hex SHA-256 of the whole file. It's stored as the file's `checksum` (sync clients use it to verify downloads); the server doesn't verify it.

**Replacing content** (`replaceFileId`) keeps the file's id, name, folder, owner, shares, tags and favorites, and swaps only its bytes. It needs editor access to the file. With `expectedVersion` it's a compare-and-swap: both init and completion fail with `409 CONTENT_CONFLICT` if the file's content `version` is no longer that value, or if the file was trashed. The old bytes stop counting against quota as soon as the replace completes. When an editor replaces someone else's file, the editor is refunded and the owner is charged the size difference, checked against the owner's quota. There's no version history: the old object is deleted shortly after. `mimeType` at completion is optional for a replace and defaults to the file's current type.

## Sync

For clients that keep a local folder in step with a DBase folder (the *sync root*). All 🔒. The caller needs at least viewer access to the root; access is inherited, so their role on the root is their role on everything under it. A root that's gone, trashed, or no longer shared with the caller returns `404 SYNC_ROOT_UNAVAILABLE`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sync/tree` | `?root=<folderId>&after=<id>&limit=` (≤5000) | `{ root: { id, name, role }, cursor, items, nextAfter }` |
| GET | `/sync/changes` | `?root=<folderId>&cursor=<seq>&limit=` (≤1000) | `{ root: { id, role }, events, cursor, hasMore }` |
| POST | `/sync/download-urls` | `{ fileIds: [...] }` (≤200) | `{ urls: [{ id, url, size, checksum, version }], unavailable: [ids] }` |
| POST | `/sync/batch` | `{ ops: [{ type, id, name?, parentId? }] }` (≤100 moves/renames) | `{ results: [{ id, ok, error? }] }` |

- **Items** (`tree`) are every live folder and file under the root: `{ kind, id, parentId, name, size, checksum, version, updatedAt }`. Page with `after=<nextAfter>` until it's `null`, and keep the **first page's** `cursor`.
- **Content `version`** is an opaque token that changes exactly when a file's content changes, unlike `updatedAt`, which a rename also changes. It works for every file, including web uploads that have no `checksum`. Compare it to detect remote edits, and pass it as `expectedVersion` when replacing.
- **Events** (`changes`) are `{ seq, kind, itemType, itemId, name, parentId, prevParentId, size, checksum, version }`, in commit order. `kind` is one of:
  - `create`, `update` (content replaced), `move` (rename or move within the root), `trash`, `restore` or `purge`.
  - `move_in` / `move_out` for a move across the root's boundary. For a folder that moved in, read its contents with `/sync/tree?root=<that folder>`.

  `size`, `checksum` and `version` are the file's *current* values. Resume from the returned `cursor` while `hasMore` is true. A cursor never skips an event, even when transactions commit out of order. Events are kept for `SYNC_EVENT_RETENTION_DAYS` (60). An older cursor gets `410 CURSOR_EXPIRED`; re-read the tree and continue from its cursor.
- **download-urls** checks access per file and writes one `download` activity row per file owner for the whole batch.
- **batch** runs each op through the same checks as `PATCH /files/:id` / `PATCH /folders/:id`, in order and independently. There's deliberately no delete op.

## Sharing and access

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/items/:type/:id/permissions` | 🔒 | — | `{ collaborators }` |
| POST | `/items/:type/:id/permissions` | 🔒 | `{ userId, role: "viewer"\|"editor" }` | `204` |
| DELETE | `/items/:type/:id/permissions/:userId` | 🔒 | — | `204` |
| POST | `/items/:type/:id/transfer-ownership` | 🔒 | `{ newOwnerId }` | `204` |
| GET | `/shared-with-me` | 🔒 | — | `{ items }` |
| GET | `/items/:type/:id/share-links` | 🔒 | — | `{ links: [{ id, role, hasPassword, expiresAt, createdBy, createdAt }] }` (no tokens: only their hashes are stored) |
| POST | `/items/:type/:id/share-links` | 🔒 | `{ role, password?, expiresAt? (ISO) }` | `201 { token, id }`: the only time the raw token is returned |
| DELETE | `/share-links/:id` | 🔒 | — | `204` (only the link's creator can revoke it) |

Granting or creating a link requires editor access or higher, and you can't hand out a role higher than your own.

### Public share links (no session)

A password-protected link answers `401 PASSWORD_REQUIRED` until unlocked. `POST /public/share-links/:token/unlock` with `{ "password": "…" }` checks the password once and sets an httpOnly cookie (`dbase_share_unlock`, signed, valid up to 12 h or the link's expiry) scoped to that link's API path; the browser then sends it with every request below. Passwords are never accepted in the URL. Unlock attempts are limited to 10 per 15 minutes per client IP and link, so guessing from one client never locks out other visitors.

| Method | Path | Query / body | Response |
|---|---|---|---|
| POST | `/public/share-links/:token/unlock` | `{ password }` | `204` + cookie, `401 INVALID_PASSWORD`, `429` |
| GET | `/public/share-links/:token` | `folderId?` | Item or folder contents (folder browsing stays inside the shared subtree) |
| GET | `/public/share-links/:token/files/:fileId/download` | — | `{ url }` |
| GET | `/public/share-links/:token/files/:fileId/preview` | — | `{ available, ... }` |
| GET | `/public/share-links/:token/files/:fileId/thumbnail` | — | `{ available, url? }` |
| GET | `/public/share-links/:token/folders/:folderId/download-zip` | — | Streamed zip |

A link stops working if it expires, if the item is trashed, or if its creator is deactivated.

## Trash

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/trash` | 🔒 | `{ items: [{ id, name, type, deletedAt }] }` |
| POST | `/trash/:type/:id/restore` | 🔒 | `204` |
| DELETE | `/trash/:type/:id` | 🔒 | `204`. Queues the item for permanent deletion. |

## Favorites and tags

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/favorites` | 🔒 | — | `{ items }` |
| POST / DELETE | `/items/:type/:id/favorite` | 🔒 | — | `204` |
| GET | `/tags` | 🔒 | — | `{ tags }` |
| POST | `/tags` | 🔒 | `{ name, color? }` | `201 { tag }` |
| PATCH | `/tags/:id` | 🔒 | `{ color }` | `204` |
| DELETE | `/tags/:id` | 🔒 | — | `204` |
| GET | `/tags/:id/items` | 🔒 | — | `{ items }` |
| GET | `/items/:type/:id/tags` | 🔒 | — | `{ tags }` |
| POST | `/items/:type/:id/tags` | 🔒 | `{ tagId }` | `204` |
| DELETE | `/items/:type/:id/tags/:tagId` | 🔒 | — | `204` |

## Search

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/search?q=term` | 🔒 | `{ items }` (max 50): case-insensitive substring match on non-trashed items the user can open — owned, shared directly, or inside a shared folder |
| GET | `/search?q=term&within=<folderId>\|mine` | 🔒 | `{ items, truncated }` (max 100): matches at any depth inside that folder (viewer access required), or inside My Files (`mine`: your root files and the full trees of your root folders). Each item adds `parentFolderId` and `location` (`[{ id, name }]`, the folders between the starting point and the item; `[]` when directly inside). `%` and `_` match literally. |

## Admin

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/admin/users` | — | `{ users }` |
| GET | `/admin/users/:id/files?folderId=` | — | Browse any user's files |
| GET | `/admin/users/:id/storage-breakdown` | — | Same shape as `/users/me/storage-breakdown` |
| PATCH | `/admin/users/:id/quota` | `{ quotaBytes }` | `204` |
| PATCH | `/admin/users/:id/role` | `{ role: "user"\|"admin" }` | `204` |
| POST | `/admin/users/:id/deactivate` | — | `204` |
| POST | `/admin/users/:id/reactivate` | — | `204` |
| DELETE | `/admin/users/:id` | `{ replacementOwnerId? }` | `204` |
| GET | `/admin/stats` | — | System statistics |
| GET | `/admin/system-storage` | — | System storage limit, allocation and default quota for new users |
| PATCH | `/admin/system-storage` | `{ totalStorageLimitBytes }` | `204` |
| PATCH | `/admin/system-storage/default-quota` | `{ defaultUserQuotaBytes }` | `204`; applies to accounts registered afterwards; `400` above the system limit |
| GET | `/admin/system-storage-breakdown` | — | `{ categories }` |
| GET | `/admin/activity` | — | `{ entries }` (audit log) |
| GET | `/admin/failed-jobs` | — | `{ jobs }` (failed deletion-queue rows) |
| POST | `/admin/backup` | — | `{ backupBucket, objectCount }` |
| GET | `/admin/backups` | — | `{ backups: [{ name, createdAt }] }` |
| POST | `/admin/backups/:name/restore` | — | `{ objectCount }` |
| POST | `/admin/send-email` | `{ to, subject, body }` | `204` |
| GET | `/admin/received-emails` | — | `{ emails, inboundAddress }` |

All admin routes are 🛡. Changing the role of, deactivating or deleting the last active admin fails with `409 LAST_ADMIN`.

## Inbound email webhook

| Method | Path | Auth |
|---|---|---|
| POST | `/email/inbound` | Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) checked against `RESEND_WEBHOOK_SECRET` |

Returns `401` when the secret isn't configured or the signature doesn't match. Events that aren't inbound mail are acknowledged with `204` and ignored.
