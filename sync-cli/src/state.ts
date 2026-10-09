import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configDir } from "./config.js";
import type { RemoteItem, Role } from "./api.js";

// Everything dbase-sync remembers between runs, in one SQLite file:
//   roots    each synced local directory ↔ remote folder pair, with its change-feed cursor
//   remote   a mirror of each root's remote subtree, kept current from /sync/tree + /sync/changes
//   entries  per path, the "base": what both sides looked like when it was last in sync. The
//            three-way comparison (local now, remote now, base) is what tells an edit from a
//            stale copy, and a deletion from something never synced.
//   issues   things the user should know about: conflicts, unsyncable names, read-only edits
//   uploads  in-flight upload sessions, so an interrupted upload resumes instead of restarting

export type EntryStatus = "synced" | "local_removed" | "detached";

export interface RootRow {
  id: number;
  local_path: string;
  remote_id: string;
  remote_name: string;
  cursor: string | null;
  role: Role | null;
  paused: number;
  last_sync_at: string | null;
  last_error: string | null;
}

export interface EntryRow {
  root_id: number;
  rel_path: string;
  kind: "file" | "folder";
  remote_id: string | null;
  status: EntryStatus;
  base_version: string | null;
  base_hash: string | null;
  local_size: number | null;
  local_mtime: number | null;
}

export interface RemoteRow {
  root_id: number;
  id: string;
  parent_id: string;
  kind: "file" | "folder";
  name: string;
  size: string | null;
  checksum: string | null;
  version: string | null;
}

export type IssueKind = "conflict" | "unsyncable" | "read_only" | "detached_edit" | "error";

export interface IssueRow {
  root_id: number;
  rel_path: string;
  kind: IssueKind;
  message: string;
  at: string;
}

export interface UploadRow {
  root_id: number;
  rel_path: string;
  session_id: string;
  hash: string;
  size: number;
  mtime: number;
  parts_done: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS roots (
    id          INTEGER PRIMARY KEY,
    local_path  TEXT NOT NULL UNIQUE,
    remote_id   TEXT NOT NULL,
    remote_name TEXT NOT NULL,
    cursor      TEXT,
    role        TEXT,
    paused      INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    last_error   TEXT
  );
  CREATE TABLE IF NOT EXISTS remote (
    root_id   INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    id        TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    kind      TEXT NOT NULL,
    name      TEXT NOT NULL,
    size      TEXT,
    checksum  TEXT,
    version   TEXT,
    PRIMARY KEY (root_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_remote_parent ON remote(root_id, parent_id);
  CREATE TABLE IF NOT EXISTS entries (
    root_id      INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    rel_path     TEXT NOT NULL,
    kind         TEXT NOT NULL,
    remote_id    TEXT,
    status       TEXT NOT NULL,
    base_version TEXT,
    base_hash    TEXT,
    local_size   INTEGER,
    local_mtime  REAL,
    PRIMARY KEY (root_id, rel_path)
  );
  CREATE INDEX IF NOT EXISTS idx_entries_remote ON entries(root_id, remote_id);
  CREATE TABLE IF NOT EXISTS issues (
    root_id  INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    rel_path TEXT NOT NULL,
    kind     TEXT NOT NULL,
    message  TEXT NOT NULL,
    at       TEXT NOT NULL,
    PRIMARY KEY (root_id, rel_path, kind)
  );
  CREATE TABLE IF NOT EXISTS uploads (
    root_id    INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    rel_path   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    hash       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mtime      REAL NOT NULL,
    parts_done TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (root_id, rel_path)
  );
`;

export class State {
  readonly db: DatabaseSync;

  constructor(file = path.join(configDir(), "state.db")) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- roots ----------------------------------------------------------------------------------

  addRoot(localPath: string, remoteId: string, remoteName: string): RootRow {
    this.db.prepare("INSERT INTO roots (local_path, remote_id, remote_name) VALUES (?, ?, ?)").run(localPath, remoteId, remoteName);
    return this.rootByPath(localPath)!;
  }

  roots(): RootRow[] {
    return this.db.prepare("SELECT * FROM roots ORDER BY id").all() as unknown as RootRow[];
  }

  rootByPath(localPath: string): RootRow | undefined {
    return this.db.prepare("SELECT * FROM roots WHERE local_path = ?").get(localPath) as unknown as RootRow | undefined;
  }

  root(id: number): RootRow {
    return this.db.prepare("SELECT * FROM roots WHERE id = ?").get(id) as unknown as RootRow;
  }

  removeRoot(id: number): void {
    this.db.prepare("DELETE FROM roots WHERE id = ?").run(id);
  }

  setRootPaused(id: number, paused: boolean): void {
    this.db.prepare("UPDATE roots SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
  }

  recordSyncResult(id: number, error: string | null): void {
    if (error) this.db.prepare("UPDATE roots SET last_error = ? WHERE id = ?").run(error, id);
    else this.db.prepare("UPDATE roots SET last_error = NULL, last_sync_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  setCursor(id: number, cursor: string | null, role?: Role): void {
    this.db.prepare("UPDATE roots SET cursor = ?, role = COALESCE(?, role) WHERE id = ?").run(cursor, role ?? null, id);
  }

  // --- remote mirror --------------------------------------------------------------------------

  replaceRemote(rootId: number, items: RemoteItem[]): void {
    this.db.prepare("DELETE FROM remote WHERE root_id = ?").run(rootId);
    for (const item of items) this.upsertRemote(rootId, item);
  }

  upsertRemote(rootId: number, item: RemoteItem): void {
    this.db
      .prepare(
        `INSERT INTO remote (root_id, id, parent_id, kind, name, size, checksum, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (root_id, id) DO UPDATE SET parent_id = excluded.parent_id, kind = excluded.kind,
           name = excluded.name, size = excluded.size, checksum = excluded.checksum, version = excluded.version`,
      )
      .run(rootId, item.id, item.parentId, item.kind, item.name, item.size, item.checksum, item.version);
  }

  /** Removes an item and, for a folder, everything under it. */
  removeRemote(rootId: number, id: string): void {
    const children = this.db.prepare("SELECT id FROM remote WHERE root_id = ? AND parent_id = ?").all(rootId, id) as { id: string }[];
    for (const child of children) this.removeRemote(rootId, child.id);
    this.db.prepare("DELETE FROM remote WHERE root_id = ? AND id = ?").run(rootId, id);
  }

  remoteItem(rootId: number, id: string): RemoteRow | undefined {
    return this.db.prepare("SELECT * FROM remote WHERE root_id = ? AND id = ?").get(rootId, id) as unknown as RemoteRow | undefined;
  }

  remoteItems(rootId: number): RemoteRow[] {
    return this.db.prepare("SELECT * FROM remote WHERE root_id = ?").all(rootId) as unknown as RemoteRow[];
  }

  // --- entries --------------------------------------------------------------------------------

  entries(rootId: number): EntryRow[] {
    return this.db.prepare("SELECT * FROM entries WHERE root_id = ?").all(rootId) as unknown as EntryRow[];
  }

  putEntry(entry: EntryRow): void {
    this.db
      .prepare(
        `INSERT INTO entries (root_id, rel_path, kind, remote_id, status, base_version, base_hash, local_size, local_mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (root_id, rel_path) DO UPDATE SET kind = excluded.kind, remote_id = excluded.remote_id,
           status = excluded.status, base_version = excluded.base_version, base_hash = excluded.base_hash,
           local_size = excluded.local_size, local_mtime = excluded.local_mtime`,
      )
      .run(
        entry.root_id,
        entry.rel_path,
        entry.kind,
        entry.remote_id,
        entry.status,
        entry.base_version,
        entry.base_hash,
        entry.local_size,
        entry.local_mtime,
      );
  }

  deleteEntry(rootId: number, relPath: string): void {
    this.db.prepare("DELETE FROM entries WHERE root_id = ? AND rel_path = ?").run(rootId, relPath);
  }

  /** Re-keys an entry and everything under it after a move (on either side). */
  moveEntries(rootId: number, from: string, to: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE entries SET rel_path = ? WHERE root_id = ? AND rel_path = ?").run(to, rootId, from);
      this.db
        .prepare("UPDATE entries SET rel_path = ? || substr(rel_path, ?) WHERE root_id = ? AND rel_path LIKE ? ESCAPE '\\'")
        .run(to + "/", from.length + 2, rootId, likePrefix(from + "/"));
    });
  }

  /** Entries at or under `relPath` (or all, for ""). */
  entriesUnder(rootId: number, relPath: string): EntryRow[] {
    if (relPath === "") return this.entries(rootId);
    return this.db
      .prepare("SELECT * FROM entries WHERE root_id = ? AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')")
      .all(rootId, relPath, likePrefix(relPath + "/")) as unknown as EntryRow[];
  }

  // --- issues ---------------------------------------------------------------------------------

  setIssue(rootId: number, relPath: string, kind: IssueKind, message: string): void {
    this.db
      .prepare(
        `INSERT INTO issues (root_id, rel_path, kind, message, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (root_id, rel_path, kind) DO UPDATE SET message = excluded.message`,
      )
      .run(rootId, relPath, kind, message, new Date().toISOString());
  }

  clearIssue(rootId: number, relPath: string, kind?: IssueKind): void {
    if (kind) this.db.prepare("DELETE FROM issues WHERE root_id = ? AND rel_path = ? AND kind = ?").run(rootId, relPath, kind);
    else this.db.prepare("DELETE FROM issues WHERE root_id = ? AND rel_path = ?").run(rootId, relPath);
  }

  clearIssuesOfKind(rootId: number, kind: IssueKind): void {
    this.db.prepare("DELETE FROM issues WHERE root_id = ? AND kind = ?").run(rootId, kind);
  }

  issues(rootId?: number): IssueRow[] {
    return (
      rootId === undefined
        ? this.db.prepare("SELECT * FROM issues ORDER BY root_id, rel_path").all()
        : this.db.prepare("SELECT * FROM issues WHERE root_id = ? ORDER BY rel_path").all(rootId)
    ) as unknown as IssueRow[];
  }

  // --- uploads --------------------------------------------------------------------------------

  upload(rootId: number, relPath: string): UploadRow | undefined {
    return this.db.prepare("SELECT * FROM uploads WHERE root_id = ? AND rel_path = ?").get(rootId, relPath) as unknown as
      | UploadRow
      | undefined;
  }

  putUpload(row: UploadRow): void {
    this.db
      .prepare(
        `INSERT INTO uploads (root_id, rel_path, session_id, hash, size, mtime, parts_done) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (root_id, rel_path) DO UPDATE SET session_id = excluded.session_id, hash = excluded.hash,
           size = excluded.size, mtime = excluded.mtime, parts_done = excluded.parts_done`,
      )
      .run(row.root_id, row.rel_path, row.session_id, row.hash, row.size, row.mtime, row.parts_done);
  }

  deleteUpload(rootId: number, relPath: string): void {
    this.db.prepare("DELETE FROM uploads WHERE root_id = ? AND rel_path = ?").run(rootId, relPath);
  }
}

function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, "\\$&") + "%";
}
