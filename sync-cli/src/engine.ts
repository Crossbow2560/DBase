import { existsSync } from "node:fs";
import { lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { ApiError, type Api, type RemoteItem, type SyncEvent, type TreePage } from "./api.js";
import { IgnoreMatcher } from "./ignore.js";
import { log } from "./log.js";
import { collisionKey, conflictedCopyName, currentPlatform, normalizeName, unsyncableReason, type Platform } from "./names.js";
import { decide, type Action } from "./reconcile.js";
import { hashFile, scanLocal, type LocalItem, type ScanResult } from "./scan.js";
import type { EntryRow, RemoteRow, RootRow, State } from "./state.js";
import { downloadToTemp, moveIntoPlace, uploadFile } from "./transfer.js";

const DOWNLOAD_URL_BATCH = 200;
const PARALLEL_TRANSFERS = 4;

export class RootUnavailableError extends Error {}

export interface CycleSummary {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  movedLocal: number;
  movedRemote: number;
  foldersCreated: number;
  errors: number;
}

interface RemotePaths {
  byPath: Map<string, RemoteRow>;
  pathById: Map<string, string>;
  unsyncable: { relPath: string; reason: string }[];
}

type Transfer =
  | { kind: "download"; relPath: string; remote: RemoteRow; local: LocalItem | undefined }
  | { kind: "conflict"; relPath: string; remote: RemoteRow; local: LocalItem; localHash: string | null }
  | { kind: "upload_new"; relPath: string; local: LocalItem; hash: string }
  | { kind: "upload_replace"; relPath: string; local: LocalItem; hash: string; entry: EntryRow };

const parentOf = (relPath: string) => (relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "");
const baseName = (relPath: string) => relPath.slice(relPath.lastIndexOf("/") + 1);
const depth = (relPath: string) => relPath.split("/").length;

/**
 * One sync pass over one root: pull remote changes, scan the disk, carry over moves on either
 * side by id, then decide every path (reconcile.ts) and carry the decisions out. Safe to stop at
 * any point: state is written as each step lands, and the next pass recomputes from the disk and
 * the remote mirror rather than trusting anything half-done.
 */
export class SyncEngine {
  private readonly host = hostname().split(".")[0] || "this-device";

  constructor(
    private readonly state: State,
    private readonly api: Api,
    private readonly platform: Platform = currentPlatform(),
  ) {}

  async syncRoot(rootId: number): Promise<CycleSummary> {
    const summary: CycleSummary = { uploaded: 0, downloaded: 0, conflicts: 0, movedLocal: 0, movedRemote: 0, foldersCreated: 0, errors: 0 };
    let root = this.state.root(rootId);
    await mkdir(root.local_path, { recursive: true });

    await this.pull(root);
    root = this.state.root(rootId);
    const canWrite = root.role === "owner" || root.role === "editor";

    const ignore = IgnoreMatcher.forRoot(root.local_path);
    let remote = this.remotePaths(root);
    const scan = await this.applyRemoteMoves(root, remote, ignore, summary);
    if (canWrite && (await this.applyLocalMoves(root, remote, scan, summary))) remote = this.remotePaths(root);

    this.state.clearIssuesOfKind(root.id, "unsyncable");
    for (const s of [...remote.unsyncable, ...scan.skipped]) this.state.setIssue(root.id, s.relPath, "unsyncable", s.reason);

    const transfers = await this.decideAll(root, remote, scan, canWrite, summary);
    await this.runTransfers(root, transfers, summary);
    return summary;
  }

  // --- pull -----------------------------------------------------------------------------------

  private async pull(root: RootRow): Promise<void> {
    try {
      if (!root.cursor) return await this.fullTree(root);
      let cursor = root.cursor;
      for (;;) {
        const page = await this.api.changes(root.remote_id, cursor);
        this.state.transaction(() => {
          for (const event of page.events) this.applyEvent(root, event);
        });
        for (const event of page.events) {
          // A folder moved into the subtree arrives as one event; its contents come from the tree.
          if (event.kind === "move_in" && event.itemType === "folder") await this.mirrorSubtree(root, event.itemId);
        }
        cursor = page.cursor;
        this.state.setCursor(root.id, cursor, page.root.role);
        if (!page.hasMore) return;
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "CURSOR_EXPIRED") {
        log("warn", "change log cursor expired; re-reading the full tree", { root: root.local_path });
        return this.fullTree(root);
      }
      if (err instanceof ApiError && err.code === "SYNC_ROOT_UNAVAILABLE") {
        throw new RootUnavailableError(`The remote folder for ${root.local_path} is gone or no longer shared with you.`);
      }
      throw err;
    }
  }

  private async fullTree(root: RootRow): Promise<void> {
    const items: RemoteItem[] = [];
    let cursor: string | null = null;
    let role: RootRow["role"] = null;
    let after: string | null = null;
    do {
      const page: TreePage = await this.api.tree(root.remote_id, after).catch((err: unknown) => {
        if (err instanceof ApiError && err.code === "SYNC_ROOT_UNAVAILABLE") {
          throw new RootUnavailableError(`The remote folder for ${root.local_path} is gone or no longer shared with you.`);
        }
        throw err;
      });
      // The first page's cursor predates every page read, so nothing changed while paging is lost.
      cursor ??= page.cursor;
      role = page.root.role;
      items.push(...page.items);
      after = page.nextAfter;
    } while (after);
    this.state.transaction(() => {
      this.state.replaceRemote(root.id, items);
      this.state.setCursor(root.id, cursor, role ?? undefined);
    });
  }

  private async mirrorSubtree(root: RootRow, folderId: string): Promise<void> {
    let after: string | null = null;
    do {
      const page: TreePage = await this.api.tree(folderId, after);
      for (const item of page.items) this.state.upsertRemote(root.id, item);
      after = page.nextAfter;
    } while (after);
  }

  private applyEvent(root: RootRow, e: SyncEvent): void {
    switch (e.kind) {
      case "trash":
      case "purge":
      case "move_out":
        this.state.removeRemote(root.id, e.itemId);
        return;
      default: {
        if (!e.parentId) return;
        const existing = this.state.remoteItem(root.id, e.itemId);
        this.state.upsertRemote(root.id, {
          kind: e.itemType,
          id: e.itemId,
          parentId: e.parentId,
          name: e.name,
          // Events carry the file's current size/checksum/version; null once it's been purged.
          size: e.size ?? existing?.size ?? null,
          checksum: e.checksum ?? existing?.checksum ?? null,
          version: e.version ?? existing?.version ?? null,
        });
      }
    }
  }

  // --- remote paths ---------------------------------------------------------------------------

  /**
   * Turns the remote mirror into sync paths. Names this platform can't store, and (on Windows)
   * names that collide case-insensitively with a sibling, are reported and left out together with
   * everything under them.
   */
  private remotePaths(root: RootRow): RemotePaths {
    const rows = this.state.remoteItems(root.id);
    const children = new Map<string, RemoteRow[]>();
    for (const row of rows) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row]);

    const byPath = new Map<string, RemoteRow>();
    const pathById = new Map<string, string>();
    const unsyncable: RemotePaths["unsyncable"] = [];
    const visit = (parentId: string, parentPath: string) => {
      const seen = new Set<string>();
      const siblings = (children.get(parentId) ?? []).sort((a, b) => a.id.localeCompare(b.id));
      for (const row of siblings) {
        const name = normalizeName(row.name);
        const relPath = parentPath ? `${parentPath}/${name}` : name;
        const reason =
          unsyncableReason(name, this.platform) ??
          (seen.has(collisionKey(name, this.platform)) ? "differs from another name in its folder only by case" : null);
        if (reason) {
          unsyncable.push({ relPath, reason: `${reason} (in DBase)` });
          continue;
        }
        seen.add(collisionKey(name, this.platform));
        byPath.set(relPath, row);
        pathById.set(row.id, relPath);
        if (row.kind === "folder") visit(row.id, relPath);
      }
    };
    visit(root.remote_id, "");
    return { byPath, pathById, unsyncable };
  }

  private remoteIdOfFolder(root: RootRow, remote: RemotePaths, relPath: string): string | null {
    if (relPath === "") return root.remote_id;
    const row = remote.byPath.get(relPath);
    return row?.kind === "folder" ? row.id : null;
  }

  private abs(root: RootRow, scan: ScanResult, relPath: string): string {
    // Prefer the on-disk spelling (it may not be NFC); fall back to the sync path for new items.
    const disk = scan.items.get(relPath)?.diskPath;
    if (disk) return path.join(root.local_path, disk);
    const parent = parentOf(relPath);
    const parentDisk = parent ? scan.items.get(parent)?.diskPath ?? parent : "";
    return path.join(root.local_path, parentDisk, baseName(relPath));
  }

  // --- moves ----------------------------------------------------------------------------------

  /**
   * Remote moves/renames, matched by id: an item we've synced now lives at a different remote
   * path, so the local copy is renamed to follow it (shallowest first, so a folder move carries
   * its contents in one rename). If the local item is gone or the new path is taken, nothing is
   * moved and the per-path rules handle both paths safely.
   */
  private async applyRemoteMoves(root: RootRow, remote: RemotePaths, ignore: IgnoreMatcher, summary: CycleSummary): Promise<ScanResult> {
    let scan = await scanLocal(root.local_path, ignore);
    const skipped = new Set<string>();
    for (;;) {
      const candidate = this.state
        .entries(root.id)
        .filter((e) => e.status === "synced" && e.remote_id && !skipped.has(e.rel_path))
        .map((e) => ({ entry: e, to: remote.pathById.get(e.remote_id!) }))
        .filter((c): c is { entry: EntryRow; to: string } => !!c.to && c.to !== c.entry.rel_path)
        // Folders before files, shallowest first: a file moved into a renamed folder must find
        // the folder already renamed, not create its new name and block the folder's own move.
        .sort(
          (a, b) =>
            Number(a.entry.kind === "file") - Number(b.entry.kind === "file") ||
            depth(a.entry.rel_path) - depth(b.entry.rel_path),
        )[0];
      if (!candidate) return scan;
      const { entry, to } = candidate;
      const from = this.abs(root, scan, entry.rel_path);
      const target = this.abs(root, scan, to);
      const fromExists = scan.items.has(entry.rel_path);
      const toExists = scan.items.has(to) || (await lstat(target).then(() => true, () => false));
      if (!fromExists || toExists) {
        skipped.add(entry.rel_path);
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await rename(from, target);
      this.state.moveEntries(root.id, entry.rel_path, to);
      log("info", "moved locally to follow DBase", { from: entry.rel_path, to });
      summary.movedLocal++;
      // Remote moves are rare; a fresh scan keeps every later lookup simple and exact.
      scan = await scanLocal(root.local_path, ignore);
    }
  }

  /**
   * Local moves/renames, carried over to DBase instead of looking like a delete plus a new file:
   * a synced file that's gone from its path matches a new, untracked file with the same content;
   * a synced folder that's gone matches a new folder with the same child names. Only unambiguous
   * matches into a folder that exists remotely are moved; anything else falls through to the
   * per-path rules (the original stays in DBase, the new path is uploaded — nothing is lost).
   */
  private async applyLocalMoves(root: RootRow, remote: RemotePaths, scan: ScanResult, summary: CycleSummary): Promise<boolean> {
    const entries = this.state.entries(root.id);
    const entryByPath = new Map(entries.map((e) => [e.rel_path, e]));
    const isGone = (e: EntryRow) =>
      e.status === "synced" && !!e.remote_id && !scan.items.has(e.rel_path) && remote.pathById.get(e.remote_id) === e.rel_path;
    const isNew = (relPath: string) => !entryByPath.has(relPath) && !remote.byPath.has(relPath);
    let moved = false;

    const commit = async (entry: EntryRow, to: string, kind: "file" | "folder") => {
      const parentId = this.remoteIdOfFolder(root, remote, parentOf(to));
      if (!parentId || remote.byPath.has(to)) return false;
      const result = (await this.api.batch([{ type: kind, id: entry.remote_id!, name: baseName(to), parentId }])).results[0]!;
      if (!result.ok) {
        log("warn", "couldn't carry a local move over to DBase", { from: entry.rel_path, to, error: result.error?.code });
        return false;
      }
      const row = this.state.remoteItem(root.id, entry.remote_id!)!;
      this.state.upsertRemote(root.id, { ...toItem(row), parentId, name: baseName(to) });
      this.state.moveEntries(root.id, entry.rel_path, to);
      log("info", "moved in DBase to follow a local move", { from: entry.rel_path, to });
      summary.movedRemote++;
      moved = true;
      return true;
    };

    // Folders first: once a folder's move is carried over, its files are no longer "gone".
    const goneFolders = entries.filter((e) => e.kind === "folder" && isGone(e));
    const newFolders = [...scan.items].filter(([p, i]) => i.kind === "folder" && isNew(p)).map(([p]) => p);
    for (const entry of goneFolders.sort((a, b) => depth(a.rel_path) - depth(b.rel_path))) {
      const childNames = (dir: string, names: string[]) => names.filter((p) => parentOf(p) === dir).map(baseName).sort().join("\0");
      const before = childNames(entry.rel_path, entries.map((e) => e.rel_path));
      if (!before) continue;
      const matches = newFolders.filter((p) => childNames(p, [...scan.items.keys()]) === before);
      if (matches.length === 1 && (await commit(entry, matches[0]!, "folder"))) {
        newFolders.splice(newFolders.indexOf(matches[0]!), 1);
      }
    }

    const refreshed = this.state.entries(root.id);
    const goneFiles = refreshed.filter((e) => e.kind === "file" && isGone(e) && e.base_hash);
    if (goneFiles.length === 0) return moved;
    const sizes = new Set(goneFiles.map((e) => e.local_size));
    const tracked = new Set(refreshed.map((e) => e.rel_path));
    const candidates = [...scan.items].filter(([p, i]) => i.kind === "file" && !tracked.has(p) && !remote.byPath.has(p) && sizes.has(i.size));
    const byHash = new Map<string, string[]>();
    for (const [p, item] of candidates) {
      const hash = await hashFile(path.join(root.local_path, item.diskPath)).catch(() => null);
      if (hash) byHash.set(hash, [...(byHash.get(hash) ?? []), p]);
    }
    for (const entry of goneFiles) {
      const sameHashGone = goneFiles.filter((e) => e.base_hash === entry.base_hash);
      const targets = byHash.get(entry.base_hash!) ?? [];
      if (sameHashGone.length === 1 && targets.length === 1) await commit(entry, targets[0]!, "file");
    }
    return moved;
  }

  // --- per-path decisions ---------------------------------------------------------------------

  private async decideAll(root: RootRow, remote: RemotePaths, scan: ScanResult, canWrite: boolean, summary: CycleSummary): Promise<Transfer[]> {
    const entries = new Map(this.state.entries(root.id).map((e) => [e.rel_path, e]));
    const unsyncable = new Set(remote.unsyncable.map((u) => u.relPath));
    const paths = [...new Set([...scan.items.keys(), ...remote.byPath.keys(), ...entries.keys()])]
      .filter((p) => !unsyncable.has(p))
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    const transfers: Transfer[] = [];

    // Under a folder the user deleted locally (and hasn't re-created): don't download new items.
    const excluded = (relPath: string) => {
      for (let p = parentOf(relPath); p; p = parentOf(p)) {
        const e = entries.get(p);
        if (e?.status === "local_removed" && !scan.items.has(p)) return true;
      }
      return false;
    };
    // Parents are decided first; if one couldn't be created, its children wait for a later pass.
    const blocked = new Set<string>();

    for (const relPath of paths) {
      const parent = parentOf(relPath);
      if (parent && blocked.has(parent)) {
        blocked.add(relPath);
        continue;
      }
      const local = scan.items.get(relPath);
      const remoteRow = remote.byPath.get(relPath);
      const entry = entries.get(relPath);

      let localHash: string | null = null;
      if (local?.kind === "file") {
        const unchanged = entry && entry.local_size === local.size && entry.local_mtime === local.mtimeMs;
        if (!unchanged) {
          localHash = await hashFile(path.join(root.local_path, local.diskPath)).catch(() => null);
        }
      }

      const action = decide({
        local: local ? { kind: local.kind, hash: localHash } : null,
        remote: remoteRow ? { kind: remoteRow.kind, id: remoteRow.id, version: remoteRow.version, checksum: remoteRow.checksum } : null,
        entry: entry
          ? { kind: entry.kind, status: entry.status, remoteId: entry.remote_id, baseVersion: entry.base_version, baseHash: entry.base_hash }
          : null,
        canWrite,
        excluded: excluded(relPath),
      });

      try {
        const ok = await this.applyAction(root, remote, scan, relPath, action, { local, remoteRow, entry, localHash }, transfers, summary);
        if (!ok) blocked.add(relPath);
        const updated = this.state.entriesUnder(root.id, relPath).find((e) => e.rel_path === relPath);
        if (updated) entries.set(relPath, updated);
        else entries.delete(relPath);
      } catch (err) {
        summary.errors++;
        blocked.add(relPath);
        this.state.setIssue(root.id, relPath, "error", err instanceof Error ? err.message : String(err));
        log("error", "sync step failed", { path: relPath, action: action.type, error: String(err) });
      }
    }
    return transfers;
  }

  /** Carries out folder and bookkeeping actions now; queues file transfers. False = children must wait. */
  private async applyAction(
    root: RootRow,
    remote: RemotePaths,
    scan: ScanResult,
    relPath: string,
    action: Action,
    ctx: { local: LocalItem | undefined; remoteRow: RemoteRow | undefined; entry: EntryRow | undefined; localHash: string | null },
    transfers: Transfer[],
    summary: CycleSummary,
  ): Promise<boolean> {
    const { local, remoteRow, entry, localHash } = ctx;
    const put = (over: Partial<EntryRow>) =>
      this.state.putEntry({
        root_id: root.id,
        rel_path: relPath,
        kind: (local?.kind ?? remoteRow?.kind ?? entry?.kind)!,
        remote_id: remoteRow?.id ?? entry?.remote_id ?? null,
        status: "synced",
        base_version: entry?.base_version ?? null,
        base_hash: entry?.base_hash ?? null,
        local_size: entry?.local_size ?? null,
        local_mtime: entry?.local_mtime ?? null,
        ...over,
      });

    switch (action.type) {
      case "noop":
        return true;

      case "adopt":
        put({
          status: "synced",
          remote_id: remoteRow!.id,
          base_version: remoteRow!.version,
          base_hash: localHash ?? entry?.base_hash ?? remoteRow!.checksum,
          local_size: local!.kind === "file" ? local!.size : null,
          local_mtime: local!.kind === "file" ? local!.mtimeMs : null,
        });
        this.state.clearIssue(root.id, relPath, "detached_edit");
        return true;

      case "create_local_folder":
        await mkdir(this.abs(root, scan, relPath), { recursive: true });
        put({ status: "synced", remote_id: remoteRow!.id, base_version: null, base_hash: null, local_size: null, local_mtime: null });
        return true;

      case "create_remote_folder": {
        const parentId = this.remoteIdOfFolder(root, remote, parentOf(relPath));
        if (!parentId) return false;
        const { folder } = await this.api.createFolder(baseName(relPath), parentId);
        const row: RemoteItem = { kind: "folder", id: folder.id, parentId, name: folder.name, size: null, checksum: null, version: null };
        this.state.upsertRemote(root.id, row);
        const mirrored = this.state.remoteItem(root.id, folder.id)!;
        remote.byPath.set(relPath, mirrored);
        remote.pathById.set(folder.id, relPath);
        put({ status: "synced", remote_id: folder.id, base_version: null, base_hash: null, local_size: null, local_mtime: null });
        summary.foldersCreated++;
        return true;
      }

      case "mark_local_removed":
        put({ status: "local_removed" });
        log("info", "deleted locally; kept in DBase", { path: relPath });
        return true;

      case "mark_detached":
        put({ status: "detached" });
        if (action.edited) {
          this.state.setIssue(root.id, relPath, "detached_edit", "Removed from DBase after you edited it here. Your copy is kept and no longer synced; `dbase-sync reattach` uploads it as a new file.");
        }
        log("info", "removed from DBase; local copy kept (detached)", { path: relPath });
        return true;

      case "drop_entry":
        this.state.deleteEntry(root.id, relPath);
        this.state.clearIssue(root.id, relPath);
        return true;

      case "read_only":
        this.state.setIssue(root.id, relPath, "read_only", "Changed here, but you can only view this DBase folder, so it isn't uploaded.");
        return local?.kind !== "folder";

      case "kind_mismatch":
        this.state.setIssue(root.id, relPath, "conflict", "A file on one side and a folder on the other share this name; left as is.");
        return false;

      case "download":
        transfers.push({ kind: "download", relPath, remote: remoteRow!, local });
        return true;

      case "conflict":
        transfers.push({ kind: "conflict", relPath, remote: remoteRow!, local: local!, localHash });
        return true;

      case "upload_new":
        if (!this.remoteIdOfFolder(root, remote, parentOf(relPath))) return false;
        transfers.push({
          kind: "upload_new",
          relPath,
          local: local!,
          hash: localHash ?? (await hashFile(path.join(root.local_path, local!.diskPath))),
        });
        return true;

      case "upload_replace":
        transfers.push({ kind: "upload_replace", relPath, local: local!, hash: localHash!, entry: entry! });
        return true;
    }
  }

  // --- transfers ------------------------------------------------------------------------------

  private async runTransfers(root: RootRow, transfers: Transfer[], summary: CycleSummary): Promise<void> {
    if (transfers.length === 0) return;
    const needUrls = transfers.filter((t) => t.kind === "download" || t.kind === "conflict").map((t) => (t as { remote: RemoteRow }).remote.id);
    const urls = new Map<string, { url: string; checksum: string | null; version: string }>();
    for (let i = 0; i < needUrls.length; i += DOWNLOAD_URL_BATCH) {
      const { urls: batch } = await this.api.downloadUrls(needUrls.slice(i, i + DOWNLOAD_URL_BATCH));
      for (const u of batch) urls.set(u.id, u);
    }
    const remote = this.remotePaths(root);

    const queue = [...transfers];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          await this.runTransfer(root, remote, t, urls, summary);
          this.state.clearIssue(root.id, t.relPath, "error");
        } catch (err) {
          summary.errors++;
          const message = err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
          // A refusal that the next pass resolves on its own isn't worth surfacing as an error.
          const transient = err instanceof ApiError && (err.code === "CONTENT_CONFLICT" || err.code === "NAME_COLLISION");
          if (!transient) this.state.setIssue(root.id, t.relPath, "error", message);
          log(transient ? "info" : "error", "transfer deferred", { path: t.relPath, kind: t.kind, error: message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_TRANSFERS, queue.length) }, worker));
  }

  private async runTransfer(
    root: RootRow,
    remote: RemotePaths,
    t: Transfer,
    urls: Map<string, { url: string; checksum: string | null; version: string }>,
    summary: CycleSummary,
  ): Promise<void> {
    const absOf = (relPath: string, local?: LocalItem) =>
      local ? path.join(root.local_path, local.diskPath) : path.join(root.local_path, ...relPath.split("/"));

    if (t.kind === "download") {
      const u = urls.get(t.remote.id);
      if (!u) return; // gone since the pull; the next pass sees that
      const target = absOf(t.relPath, t.local);
      await mkdir(path.dirname(target), { recursive: true });
      const { tmp, hash } = await downloadToTemp(u.url, target, u.checksum);
      // Don't clobber an edit made while this was downloading: the next pass decides afresh.
      if (t.local && !(await this.unchangedSince(target, t.local))) {
        await rm(tmp, { force: true });
        return;
      }
      await moveIntoPlace(tmp, target);
      const st = await stat(target);
      this.recordSynced(root, t.relPath, "file", t.remote.id, u.version, hash, st.size, st.mtimeMs);
      log("info", "downloaded", { path: t.relPath });
      summary.downloaded++;
      return;
    }

    if (t.kind === "conflict") {
      const u = urls.get(t.remote.id);
      if (!u) return;
      const target = absOf(t.relPath, t.local);
      const { tmp, hash } = await downloadToTemp(u.url, target, u.checksum);
      const localHash = t.localHash ?? (await hashFile(target));
      if (hash === localHash) {
        // Same content after all (the remote copy had no checksum to compare up front).
        await rm(tmp, { force: true });
        this.recordSynced(root, t.relPath, "file", t.remote.id, u.version, hash, t.local.size, t.local.mtimeMs);
        return;
      }
      const dir = path.dirname(target);
      const copyName = conflictedCopyName(path.basename(target), this.host, new Date(), (candidate) =>
        remote.byPath.has(parentOf(t.relPath) ? `${parentOf(t.relPath)}/${normalizeName(candidate)}` : normalizeName(candidate)) ||
        existsSync(path.join(dir, candidate)),
      );
      const copyAbs = path.join(dir, copyName);
      await rename(target, copyAbs);
      await moveIntoPlace(tmp, target);
      const st = await stat(target);
      this.recordSynced(root, t.relPath, "file", t.remote.id, u.version, hash, st.size, st.mtimeMs);
      const copyRel = parentOf(t.relPath) ? `${parentOf(t.relPath)}/${normalizeName(copyName)}` : normalizeName(copyName);
      this.state.setIssue(root.id, copyRel, "conflict", `Changed here and in DBase. DBase's version is at ${t.relPath}; yours was kept as this file.`);
      log("warn", "conflict: kept both versions", { path: t.relPath, copy: copyRel });
      summary.conflicts++;
      // The copy is uploaded by the next pass, as an ordinary new file.
      return;
    }

    if (t.kind === "upload_new") {
      const parentId = this.remoteIdOfFolder(root, remote, parentOf(t.relPath));
      if (!parentId) return;
      const file = await uploadFile(this.api, this.state, {
        rootId: root.id,
        relPath: t.relPath,
        absPath: absOf(t.relPath, t.local),
        hash: t.hash,
        size: t.local.size,
        mtime: t.local.mtimeMs,
        name: baseName(t.relPath),
        parentId,
      });
      this.state.upsertRemote(root.id, { kind: "file", id: file.id, parentId, name: file.name, size: file.size_bytes, checksum: file.checksum, version: file.version });
      this.recordSynced(root, t.relPath, "file", file.id, file.version, t.hash, t.local.size, t.local.mtimeMs);
      log("info", "uploaded", { path: t.relPath });
      summary.uploaded++;
      return;
    }

    const file = await uploadFile(this.api, this.state, {
      rootId: root.id,
      relPath: t.relPath,
      absPath: absOf(t.relPath, t.local),
      hash: t.hash,
      size: t.local.size,
      mtime: t.local.mtimeMs,
      replaceFileId: t.entry.remote_id!,
      expectedVersion: t.entry.base_version,
    });
    const row = this.state.remoteItem(root.id, file.id);
    if (row) this.state.upsertRemote(root.id, { ...toItem(row), size: file.size_bytes, checksum: file.checksum, version: file.version });
    this.recordSynced(root, t.relPath, "file", file.id, file.version, t.hash, t.local.size, t.local.mtimeMs);
    log("info", "uploaded changes", { path: t.relPath });
    summary.uploaded++;
  }

  private async unchangedSince(absPath: string, local: LocalItem): Promise<boolean> {
    const st = await stat(absPath).catch(() => null);
    return !!st && st.size === local.size && st.mtimeMs === local.mtimeMs;
  }

  private recordSynced(root: RootRow, relPath: string, kind: "file" | "folder", remoteId: string, version: string | null, hash: string | null, size: number, mtime: number): void {
    this.state.putEntry({
      root_id: root.id,
      rel_path: relPath,
      kind,
      remote_id: remoteId,
      status: "synced",
      base_version: version,
      base_hash: hash,
      local_size: size,
      local_mtime: mtime,
    });
    this.state.clearIssue(root.id, relPath, "detached_edit");
  }

  // --- user commands --------------------------------------------------------------------------

  /** `dbase-sync restore`: stop treating these locally-deleted paths as removed; the next pass downloads them. */
  restore(rootId: number, relPath: string): number {
    const targets = this.state.entriesUnder(rootId, relPath).filter((e) => e.status === "local_removed");
    for (const e of targets) this.state.deleteEntry(rootId, e.rel_path);
    return targets.length;
  }

  /** `dbase-sync reattach`: let these detached local copies be uploaded again, as new files. */
  reattach(rootId: number, relPath: string): number {
    const targets = this.state.entriesUnder(rootId, relPath).filter((e) => e.status === "detached");
    for (const e of targets) {
      this.state.deleteEntry(rootId, e.rel_path);
      this.state.clearIssue(rootId, e.rel_path, "detached_edit");
    }
    return targets.length;
  }
}

function toItem(row: RemoteRow): RemoteItem {
  return { kind: row.kind, id: row.id, parentId: row.parent_id, name: row.name, size: row.size, checksum: row.checksum, version: row.version };
}
