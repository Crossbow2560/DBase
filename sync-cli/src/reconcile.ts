// The three-way decision for one path: what's on disk now (local), what's in DBase now (remote),
// and what both looked like when the path was last in sync (the entry, i.e. the base). Pure —
// the engine gathers the inputs and carries out the action — so the whole table is unit-tested
// (reconcile.test.ts).
//
// The rules that shape it:
//   * Deletes never propagate. Deleting locally leaves DBase alone (`mark_local_removed`);
//     trashing in DBase leaves the local copy alone (`mark_detached`).
//   * An edit always beats a delete, so nothing is lost: a remote edit to a locally-deleted file
//     downloads it again, and a detached file is never uploaded over (it may have been deleted on
//     purpose — `reattach` is the explicit way back).
//   * When both sides changed, both versions are kept (`conflict`).
//   * Moves are matched by id before this runs (engine.ts), so a path here never confuses a move
//     with a delete plus a create.

import type { EntryStatus } from "./state.js";

export interface LocalSide {
  kind: "file" | "folder";
  /** SHA-256 of a file's content when the engine needed it (no base, or stat changed); else null. */
  hash: string | null;
}

export interface RemoteSide {
  kind: "file" | "folder";
  id: string;
  version: string | null;
  checksum: string | null;
}

export interface BaseSide {
  kind: "file" | "folder";
  status: EntryStatus;
  remoteId: string | null;
  baseVersion: string | null;
  baseHash: string | null;
}

export interface PathInput {
  local: LocalSide | null;
  remote: RemoteSide | null;
  entry: BaseSide | null;
  /** The user can write to this root (owner/editor); viewers sync down only. */
  canWrite: boolean;
  /** Under a folder the user deleted locally — new remote items there aren't downloaded. */
  excluded: boolean;
}

export type Action =
  | { type: "noop" }
  /** Both sides already agree: record them as the new base. */
  | { type: "adopt" }
  | { type: "upload_new" }
  | { type: "upload_replace" }
  | { type: "download" }
  /** Both sides changed: keep the local version under a conflicted-copy name, take the remote one. */
  | { type: "conflict" }
  | { type: "create_remote_folder" }
  | { type: "create_local_folder" }
  | { type: "mark_local_removed" }
  | { type: "mark_detached"; edited: boolean }
  | { type: "drop_entry" }
  /** A local change in a root the user can only read: reported, never uploaded. */
  | { type: "read_only" }
  /** A file on one side and a folder on the other: reported, left alone. */
  | { type: "kind_mismatch" };

const act = <T extends Action["type"]>(type: T) => ({ type }) as Extract<Action, { type: T }>;

export function decide(input: PathInput): Action {
  const { local, remote, entry } = input;
  if (local && remote && local.kind !== remote.kind) return act("kind_mismatch");
  const kind = local?.kind ?? remote?.kind ?? entry?.kind;
  return kind === "folder" ? decideFolder(input) : decideFile(input);
}

function decideFile({ local, remote, entry, canWrite, excluded }: PathInput): Action {
  const localChanged = !!entry && local?.hash != null && local.hash !== entry.baseHash;
  const remoteChanged = !!entry && !!remote && (remote.id !== entry.remoteId || remote.version !== entry.baseVersion);
  // Two independently-arrived versions: equal content is provably fine; anything else is a
  // conflict (the engine downloads the remote copy and compares before declaring one).
  const reconcileBoth = (): Action =>
    local!.hash !== null && remote!.checksum !== null && local!.hash === remote!.checksum ? act("adopt") : act("conflict");
  const pushLocal = (kind: "upload_new" | "upload_replace"): Action => (canWrite ? act(kind) : act("read_only"));

  if (!entry) {
    if (local && remote) return reconcileBoth();
    if (local) return pushLocal("upload_new");
    if (remote) return excluded ? act("noop") : act("download");
    return act("noop");
  }

  switch (entry.status) {
    case "synced":
      if (local && remote) {
        if (localChanged && remoteChanged) return reconcileBoth();
        if (localChanged) return pushLocal("upload_replace");
        if (remoteChanged) return act("download");
        return act("adopt"); // unchanged content; refreshes the recorded stat (e.g. after a touch)
      }
      if (local) return { type: "mark_detached", edited: localChanged };
      if (remote) return remoteChanged ? act("download") : act("mark_local_removed");
      return act("drop_entry");

    case "local_removed":
      if (local && remote) return reconcileBoth(); // re-created locally
      if (remote) return remoteChanged ? act("download") : act("noop");
      if (local) return pushLocal("upload_new");
      return act("drop_entry");

    case "detached":
      if (local && remote) return reconcileBoth(); // restored in DBase, or a new file there
      if (remote) return act("download");
      if (local) return act("noop");
      return act("drop_entry");
  }
}

function decideFolder({ local, remote, entry, canWrite, excluded }: PathInput): Action {
  if (!entry || entry.status === "local_removed") {
    if (local && remote) return act("adopt");
    if (local) return canWrite ? act("create_remote_folder") : act("read_only");
    if (remote) return entry || excluded ? act("noop") : act("create_local_folder");
    return entry ? act("drop_entry") : act("noop");
  }

  if (entry.status === "detached") {
    if (local && remote) return act("adopt");
    if (remote) return act("create_local_folder");
    if (local) return act("noop");
    return act("drop_entry");
  }

  // synced
  if (local && remote) return remote.id === entry.remoteId ? act("noop") : act("adopt");
  if (local) return { type: "mark_detached", edited: false };
  if (remote) return act("mark_local_removed");
  return act("drop_entry");
}
