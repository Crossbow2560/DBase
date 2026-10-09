# Usage guide

This guide assumes the stack is running and an admin has been bootstrapped (see [installation.md](installation.md)). The UI is at `http://localhost:3001` by default.

## Accounts

1. **Register** at `/register`. Passwords need at least 8 characters.
2. **Verify.** Click the link in the verification email. Without `RESEND_API_KEY` the email isn't sent; copy the link from the backend log instead:
   ```bash
   docker compose logs backend | grep -A5 "\[email\]"
   ```
   The link expires after `EMAIL_VERIFICATION_TTL_HOURS` (24 h). You can request a new one from the login page or by registering again with the same email.
3. **Log in** at `/login`. Sessions last `SESSION_TTL_DAYS` (30).
4. **Manage your account:**
   - `/settings/account`: change display name or password, or delete the account. When you delete it, your files are transferred to the oldest active admin.
   - `/settings/sessions` (sidebar "Devices"): view and revoke individual sessions.
5. **Forgot password:** use `/password-reset/request`. The reset link expires after 30 minutes and signs you out everywhere.

## Files and folders

- **My Files** (`/folders`) is your root, and `/folders/<id>` is a subfolder. Breadcrumbs show the full ancestor chain.
- **Upload files:** drag and drop them onto the browser, or use **Upload**. The bottom-right tray shows per-file progress with pause, resume and cancel. Files upload 3 at a time, each in several parallel parts.
- **Failed uploads:** brief connection drops and server errors are retried automatically (each part up to 3 times). If an upload still fails, the tray shows why, with **Retry** and **Dismiss**. After a connection problem, Retry continues from the parts already uploaded; after other failures (for example quota), it starts the file over. If more than an hour has passed, the upload restarts automatically. Folder uploads offer **Retry failed (n)**, or **Retry** if the folder couldn't be prepared. Dismissing a failed upload releases any storage its partial upload was holding.
- **Upload folders:** drag and drop a folder (or several), or use **Upload folder**; on Home, use the "upload a folder" link. The whole structure is recreated, including empty subfolders when dragged (the folder picker can't see empty folders). If a folder with the same name already exists, the upload becomes `Name (2)` rather than merging. A folder upload is one row in the tray, with combined progress, a file count, any failed files, and pause, resume and cancel for the whole folder. Before anything is created, it checks that the folder fits in your remaining quota. OS metadata files (`.DS_Store`, `Thumbs.db`, `desktop.ini`) are skipped.
- **Row actions:**
  - rename, move (a folder can't be moved into its own subtree)
  - download (folders download as `.zip`), preview
  - share, tags, favorite
  - delete, which moves the item to trash
- **Previews:** click an image, video, audio or PDF file to preview it inline. Thumbnails for images, videos and PDFs appear about 30 seconds after upload. If one never appears, generation failed for that format; this doesn't affect the file.
- **Naming rules:**
  - Names are case-sensitive but Unicode-normalized, so visually identical names collide.
  - A name may be at most 255 bytes, and a full path at most 4096 bytes.
  - Two live items in the same folder can't share a name.

## Sharing

Open **Share** on any item. You need editor access or higher on the item to share it.

- **With a user:** enter their email (it must be a registered account) and pick `viewer` or `editor`. Sharing a folder shares everything inside it, including items added later. The recipient sees the item under **Shared with me**, which lists top-level shares only; what's inside a shared folder is reached by opening it (or through search).
- **With a link:** create a link with a role, an optional password and an optional expiry. Anyone with the URL `/s/<token>` can open it without an account. Folder links can be browsed and downloaded as a zip.
- **Revoking:** remove a collaborator or revoke a link from the same dialog. Only a link's creator can revoke it.
- **Transfer ownership:** the current owner can make another user the owner of an item.

What viewers and editors can do:

| | Viewer | Editor | Owner |
|---|---|---|---|
| View, download, preview | ✓ | ✓ | ✓ |
| Rename, move, upload into folder, trash | | ✓ | ✓ |
| Share (up to own role), create links | | ✓ | ✓ |
| Transfer ownership | | | ✓ |

## Organizing and finding

- **Favorites** (`/favorites`): star items for quick access.
- **Tags** (`/tags`): create personal colored tags, apply them from an item's menu and browse by tag. Tags are private to you.
- **Search box on My Files / a folder:** finds matches in that folder *and every subfolder*, showing where each nested match lives ("in Projects / Alpha", which links to that folder). The type filter, sort and row actions work on the results. Capped at 100 results.
- **Search** (`/search`): partial, case-insensitive name search across everything you can open: your own items, items shared with you, and anything inside a folder shared with you. Results are capped at 50.

## Trash

- Deleted items go to `/trash` and are purged automatically 30 days after deletion (`TRASH_RETENTION_DAYS`).
- **Restore** puts an item back in its original location. This fails with `NAME_COLLISION` if a new item now uses that name, or `PURGE_IN_FLIGHT` if permanent deletion has already started.
- **Delete forever** queues the item for immediate purge. Storage is credited back once the object is removed, usually within a minute.

## Storage

- The sidebar shows your usage against your quota. `/home` shows a breakdown by documents, images and videos.
- An upload that would exceed your quota is rejected with `QUOTA_EXCEEDED` partway through, when the excess would occur. Bytes already uploaded for that file are credited back when it's canceled or expires.
- `SYSTEM_STORAGE_LIMIT_EXCEEDED` means the whole system is full, not your account. Contact an admin.

## Desktop sync (`dbase-sync`)

`dbase-sync` keeps folders on your computer in sync with folders in DBase, in both directions. It runs on Linux and Windows and needs Node.js 22.13 or later.

```bash
cd sync-cli && npm install && npm run build && npm link
dbase-sync login --server https://dbase.example.com
dbase-sync add ~/DBase "Sync"
dbase-sync run
```

`add` takes a path in My Files (created if it doesn't exist) or a folder id, which is how you sync a folder shared with you; the id is in the folder's web URL. If you only have view access, the folder syncs down only. Run `dbase-sync --help` for every command.

`run` syncs every folder you've added: right away when something changes locally, and at least every 15 seconds for changes in DBase. Leave it running (for example as a systemd user service, or a Windows scheduled task at logon), or use `run --once`.

How it behaves:

- **Edits** go both ways, replacing the file in DBase in place, so its shares, tags and links are kept.
- **If a file changed on both sides**, you get both versions. DBase's version keeps the name and yours becomes `name (conflicted copy <computer> <date>).ext`, which is then synced like any file.
- **Deleting a file on your computer doesn't delete it in DBase.** It stays deleted on this computer unless someone edits it in DBase. `dbase-sync restore <path>` brings it back.
- **Deleting (trashing) a file in DBase doesn't delete your copy.** The copy is kept and marked *detached*, so it's no longer synced and your edits to it aren't uploaded. If it's restored in DBase, it's linked up again. `dbase-sync reattach <path>` uploads it as a new file.
- **Renames and moves** carry over on both sides.
- **Skipped:** names your system can't store (on Windows: `<>:"/\|?*`, names like `CON`, a trailing dot or space, two names differing only by case), symbolic links, and temp and system files. Add your own patterns in a `.dbaseignore` file in the synced folder (gitignore style).
- `dbase-sync status` shows each folder's state. `dbase-sync conflicts` lists conflicts, detached edits, skipped names and errors.
- Signing in creates a **device token**. Revoke it from another login with `DELETE /auth/device-tokens/:id`, or run `dbase-sync logout` on the device. Changing your password signs out every device.

## Admin panel

Admins see an extra sidebar section:

| Page | Purpose |
|---|---|
| Users (`/admin/users`, `/admin/users/<id>`) | List users, change quota or role, deactivate or reactivate, delete (choosing who inherits their items), browse a user's files and storage breakdown |
| Stats | System-wide usage and storage breakdown |
| Activity | Audit log of uploads, shares, admin actions, backups and so on |
| Storage Settings | Set the system-wide storage cap. User quotas are pre-allocated out of it, so the cap can't be set below the sum of verified users' quotas. Also sets the default quota for new users: it applies only to accounts registered afterwards (existing quotas are unchanged) and can't exceed the cap. The page shows how many more accounts fit at that default. |
| Backup | Copy the whole `dbase` bucket into a new `dbase-backup-<timestamp>` bucket, or restore one. A restore overwrites matching keys only and never deletes newer objects. Limited to 3 runs per 10 minutes. |
| Failed jobs | Deletion-queue items that failed 5 times |
| Send Mail / Received Mail | Send email through Resend, and read inbound mail delivered to `EMAIL_INBOUND_ADDRESS` |

Things to know:

- **Deactivation** is reversible and changes no data. The user's sessions end immediately, their share links stop working, and shares they granted are suspended until reactivation.
- **Last admin:** the last active admin can't be demoted, deactivated or deleted (`LAST_ADMIN`).
- **Registration** returns `REGISTRATION_CLOSED` once the system limit is fully allocated. Raise the limit or lower quotas to reopen it.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Login says "Please verify your email" | Account not verified | Use the link from the email or backend log, or resend it |
| Thumbnails or downloads fail to load for remote users | `MINIO_PUBLIC_ENDPOINT` still `localhost` | Set it to the host MinIO is reachable at from browsers |
| Verification and reset links point to localhost | `PUBLIC_APP_URL` not set | Set it to the frontend's public URL |
| Login "works" but you're immediately logged out on a remote host | `COOKIE_SECURE=true` (or an `https://` `PUBLIC_APP_URL`) while browsing over plain HTTP | Serve the frontend over HTTPS, or make `PUBLIC_APP_URL` match how users actually reach it |
| Bulk upload slows to a trickle | Write rate limit (60/min) | Expected; the client retries automatically after `Retry-After` |
| `NO_SYSTEM_ADMIN` when deleting an account | No other active admin to inherit items | Promote another admin first |
