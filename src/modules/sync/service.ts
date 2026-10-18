import { db } from "../../db.js";
import * as storage from "../storage/client.js";
import { AppError } from "../accounts/errors.js";
import { checkPermission, resolveEffectiveRole, type ItemType, type Role } from "../access/permission-check.js";
import { logActivity } from "../admin/audit-service.js";
import { renameOrMoveFile } from "../filesystem/file-service.js";
import { moveOrRenameFolder } from "../filesystem/folder-service.js";
import { contentVersion } from "../filesystem/content-version.js";
import { syncRootUnavailable, cursorExpired } from "./errors.js";

// The read side of folder sync (supabase/migrations/0028): a full snapshot of a folder's subtree
// plus a cursor (tree), and everything that happened in that subtree after a cursor (changes).
// A sync root is always a folder; permissions are inherited downward and never narrowed, so the
// caller's role on the root is their role on everything they're shown under it.

export const MAX_CHANGES_PAGE = 1000;
export const MAX_TREE_PAGE = 5000;
export const MAX_DOWNLOAD_URLS = 200;
export const MAX_BATCH_OPS = 100;

// Presigned URLs are checked when a request starts, not while it streams, so this only needs to
// cover the gap between asking for a batch and starting its downloads.
const DOWNLOAD_URL_TTL_SECONDS = 900;

async function resolveRoot(userId: string, rootId: string): Promise<{ id: string; name: string; path: string; role: Role }> {
  const folder = await db.folders.findFirst({
    where: { id: rootId, deleted_at: null },
    select: { id: true, name: true, materialized_path: true },
  });
  if (!folder) throw syncRootUnavailable();

  const user = await db.users.findUniqueOrThrow({ where: { id: userId }, select: { role: true } });
  // Admins pass every item check (permission-check.ts), so they get full access here too.
  const role = user.role === "admin" ? "owner" : await resolveEffectiveRole(userId, "folder", rootId);
  if (!role) throw syncRootUnavailable();
  return { id: folder.id, name: folder.name, path: folder.materialized_path, role };
}

/**
 * Assigns seqs to every committed, not-yet-sequenced event and returns the highest seq. Every
 * event with seq <= the returned value is committed and visible; anything committed later gets a
 * higher seq (see the migration's ORDERING note).
 */
export async function sequenceEvents(): Promise<bigint> {
  const rows = await db.$queryRaw<{ head: bigint }[]>`SELECT sequence_sync_events() AS head`;
  return rows[0]!.head;
}

/**
 * Deletes events older than the retention window and records how far the log was pruned, so
 * getChanges can tell an expired cursor (410) from one that simply has nothing new. Prunes by seq,
 * not by timestamp alone: a long transaction can commit (and be sequenced) after newer events, so
 * the cut is "every seq up to the newest one that's old enough" — never a hole in the middle.
 */
export async function pruneSyncEvents(retentionDays: number): Promise<number> {
  await sequenceEvents();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  return db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ through: bigint | null }[]>`
      SELECT max(seq) AS through FROM sync_events WHERE seq IS NOT NULL AND occurred_at < ${cutoff}
    `;
    if (!row?.through) return 0;
    const deleted = await tx.$executeRaw`DELETE FROM sync_events WHERE seq <= ${row.through}`;
    await tx.$executeRaw`
      UPDATE sync_state SET pruned_through_seq = greatest(pruned_through_seq, ${row.through}) WHERE id = true
    `;
    return deleted;
  });
}

export async function getTree(userId: string, rootId: string, after: string | null, rawLimit: number) {
  const root = await resolveRoot(userId, rootId);
  const limit = Math.min(Math.max(1, rawLimit), MAX_TREE_PAGE);
  // Taken BEFORE the items are read: a change that lands while the client is paging through the
  // tree gets a higher seq, so it's replayed from /changes rather than lost.
  const cursor = await sequenceEvents();

  const prefix = root.path + "%";
  const rows = await db.$queryRaw<
    {
      kind: ItemType;
      id: string;
      parent_id: string;
      name: string;
      size_bytes: bigint | null;
      checksum: string | null;
      storage_key: string | null;
      updated_at: Date;
    }[]
  >`
    SELECT * FROM (
      SELECT 'folder' AS kind, id, parent_folder_id AS parent_id, name,
             NULL::bigint AS size_bytes, NULL::text AS checksum, NULL::text AS storage_key, updated_at
      FROM folders
      WHERE deleted_at IS NULL AND materialized_path LIKE ${prefix} AND id <> ${root.id}::uuid
      UNION ALL
      SELECT 'file', fi.id, fi.folder_id, fi.name, fi.size_bytes, fi.checksum, fi.storage_key, fi.updated_at
      FROM files fi
      JOIN folders fo ON fo.id = fi.folder_id
      WHERE fi.deleted_at IS NULL AND fi.upload_status = 'complete'
        AND fo.deleted_at IS NULL AND fo.materialized_path LIKE ${prefix}
    ) t
    WHERE ${after}::uuid IS NULL OR t.id > ${after}::uuid
    ORDER BY t.id
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    root: { id: root.id, name: root.name, role: root.role },
    cursor: cursor.toString(),
    items: page.map((r) => ({
      kind: r.kind,
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      size: r.size_bytes === null ? null : r.size_bytes.toString(),
      checksum: r.checksum,
      version: r.storage_key === null ? null : contentVersion(r.storage_key),
      updatedAt: r.updated_at,
    })),
    nextAfter: hasMore ? page[page.length - 1]!.id : null,
  };
}

export type SyncEventKind = "create" | "update" | "move" | "move_in" | "move_out" | "trash" | "restore" | "purge";

/**
 * Events in the root's subtree after `cursor`, from the subtree's point of view: a move across
 * the subtree boundary is reported as `move_in` / `move_out` (for a folder moved in, the client
 * reads its contents with getTree), and events that only touch the outside — e.g. a restore to a
 * different location — are dropped. Events about the root folder itself are omitted: a root
 * that's trashed or no longer shared fails resolveRoot instead.
 */
export async function getChanges(userId: string, rootId: string, cursor: bigint, rawLimit: number) {
  const root = await resolveRoot(userId, rootId);
  const limit = Math.min(Math.max(1, rawLimit), MAX_CHANGES_PAGE);

  const state = await db.sync_state.findUniqueOrThrow({ where: { id: true } });
  if (cursor < state.pruned_through_seq) throw cursorExpired();

  const head = await sequenceEvents();
  const marker = `/${root.id}/`;
  const rows = await db.$queryRaw<
    {
      seq: bigint;
      item_type: ItemType;
      item_id: string;
      kind: "create" | "update" | "move" | "trash" | "restore" | "purge";
      name: string;
      parent_id: string | null;
      prev_parent_id: string | null;
      inside: boolean;
      was_inside: boolean;
      size_bytes: bigint | null;
      checksum: string | null;
      storage_key: string | null;
      updated_at: Date | null;
    }[]
  >`
    SELECT e.seq, e.item_type, e.item_id, e.kind, e.name, e.parent_id, e.prev_parent_id,
           strpos(coalesce(e.path, ''), ${marker}) > 0 AS inside,
           strpos(coalesce(e.prev_path, ''), ${marker}) > 0 AS was_inside,
           f.size_bytes, f.checksum, f.storage_key, f.updated_at
    FROM sync_events e
    LEFT JOIN files f ON e.item_type = 'file' AND f.id = e.item_id
    WHERE e.seq > ${cursor} AND e.seq <= ${head}
      AND e.item_id <> ${root.id}::uuid
      AND (strpos(coalesce(e.path, ''), ${marker}) > 0 OR strpos(coalesce(e.prev_path, ''), ${marker}) > 0)
    ORDER BY e.seq
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const events = [];
  for (const r of page) {
    let kind: SyncEventKind;
    if (r.kind === "move") {
      kind = r.inside && r.was_inside ? "move" : r.inside ? "move_in" : "move_out";
    } else if (r.kind === "purge") {
      if (!r.was_inside) continue;
      kind = "purge";
    } else {
      if (!r.inside) continue;
      kind = r.kind;
    }
    events.push({
      seq: r.seq.toString(),
      kind,
      itemType: r.item_type,
      itemId: r.item_id,
      name: r.name,
      parentId: r.parent_id,
      prevParentId: r.prev_parent_id,
      // Current state of the file (not as of the event), so the client reconciles straight to it.
      size: r.size_bytes === null ? null : r.size_bytes.toString(),
      checksum: r.checksum,
      version: r.storage_key === null ? null : contentVersion(r.storage_key),
      updatedAt: r.updated_at,
    });
  }

  const lastSeen = hasMore ? page[page.length - 1]!.seq : head > cursor ? head : cursor;
  return { root: { id: root.id, role: root.role }, events, cursor: lastSeen.toString(), hasMore };
}

/**
 * Presigned download URLs for many files in one call. Writes one `download` activity row per
 * file owner for the whole batch (metadata lists the files), instead of one row per file — a sync
 * of thousands of files would otherwise flood the audit log.
 */
export async function getDownloadUrls(userId: string, fileIds: string[]) {
  const unique = [...new Set(fileIds)];
  const files = await db.files.findMany({
    where: { id: { in: unique }, deleted_at: null, upload_status: "complete" },
    select: { id: true, name: true, owner_id: true, storage_key: true, size_bytes: true, checksum: true },
  });
  const byId = new Map(files.map((f) => [f.id, f]));

  const urls: { id: string; url: string; size: string; checksum: string | null; version: string }[] = [];
  const unavailable: string[] = [];
  const byOwner = new Map<string, string[]>();
  for (const id of unique) {
    const file = byId.get(id);
    if (!file || !(await checkPermission(userId, "file", id, "viewer"))) {
      unavailable.push(id);
      continue;
    }
    urls.push({
      id,
      url: await storage.getPresignedDownloadUrl(file.storage_key, DOWNLOAD_URL_TTL_SECONDS, file.name),
      size: file.size_bytes.toString(),
      checksum: file.checksum,
      version: contentVersion(file.storage_key),
    });
    byOwner.set(file.owner_id, [...(byOwner.get(file.owner_id) ?? []), id]);
  }

  for (const [ownerId, ids] of byOwner) {
    await logActivity({
      actorId: userId,
      subjectUserId: ownerId,
      action: "download",
      metadata: { via: "sync", count: ids.length, fileIds: ids },
    });
  }

  return { urls, unavailable };
}

export interface BatchOp {
  type: ItemType;
  id: string;
  name?: string;
  parentId?: string | null;
}

/**
 * Many moves/renames in one request, each through the same service function (and checks, and
 * activity logging) as its single-item route. Ops run in order and independently: one failing
 * doesn't stop the rest, and each gets its own result. No trash op — sync clients never delete
 * remotely.
 */
export async function runBatch(userId: string, ops: BatchOp[]) {
  const results = [];
  for (const op of ops) {
    try {
      if (op.type === "file") {
        await renameOrMoveFile(userId, op.id, { name: op.name, folderId: op.parentId });
      } else {
        await moveOrRenameFolder(userId, op.id, { name: op.name, parentFolderId: op.parentId });
      }
      results.push({ id: op.id, ok: true as const });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      results.push({ id: op.id, ok: false as const, error: { code: err.code, message: err.message } });
    }
  }
  return { results };
}
