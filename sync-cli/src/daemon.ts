import { watch, type FSWatcher } from "node:fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Api } from "./api.js";
import { configDir } from "./config.js";
import { RootUnavailableError, SyncEngine, type CycleSummary } from "./engine.js";
import { TEMP_SUFFIX } from "./ignore.js";
import { log } from "./log.js";
import type { State } from "./state.js";

// How `run` keeps roots in sync: every root gets a pass every `intervalMs` (the remote change
// feed is polled, and the disk rescanned — the rescan is the safety net for anything a watcher
// misses), and a local change triggers an earlier pass for its root after a short debounce.

const DEBOUNCE_MS = 2000;

export interface RunOptions {
  intervalMs: number;
  once: boolean;
  signal?: AbortSignal;
  onCycle?: (rootPath: string, summary: CycleSummary) => void;
}

export async function syncAllOnce(state: State, api: Api, onCycle?: RunOptions["onCycle"]): Promise<void> {
  const engine = new SyncEngine(state, api);
  for (const root of state.roots()) {
    if (root.paused) continue;
    await syncOne(state, engine, root.id, root.local_path, onCycle);
  }
}

async function syncOne(state: State, engine: SyncEngine, rootId: number, rootPath: string, onCycle?: RunOptions["onCycle"]) {
  try {
    const summary = await engine.syncRoot(rootId);
    state.recordSyncResult(rootId, null);
    onCycle?.(rootPath, summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.recordSyncResult(rootId, message);
    log(err instanceof RootUnavailableError ? "warn" : "error", "sync pass failed", { root: rootPath, error: message });
  }
}

export async function runLoop(state: State, api: Api, options: RunOptions): Promise<void> {
  if (options.once) return syncAllOnce(state, api, options.onCycle);

  const engine = new SyncEngine(state, api);
  const due = new Set<number>(state.roots().map((r) => r.id));
  const watchers: FSWatcher[] = [];
  const timers = new Map<number, NodeJS.Timeout>();
  let wake: (() => void) | null = null;
  const poke = () => wake?.();

  for (const root of state.roots()) {
    if (root.paused) continue;
    try {
      const watcher = watch(root.local_path, { recursive: true }, (_event, filename) => {
        // Our own temp downloads would otherwise retrigger a pass for every file downloaded.
        if (filename && String(filename).endsWith(TEMP_SUFFIX)) return;
        clearTimeout(timers.get(root.id));
        timers.set(
          root.id,
          setTimeout(() => {
            due.add(root.id);
            poke();
          }, DEBOUNCE_MS),
        );
      });
      watcher.on("error", (err) => log("warn", "file watcher error; relying on periodic scans", { root: root.local_path, error: String(err) }));
      watchers.push(watcher);
    } catch (err) {
      log("warn", "couldn't watch folder; relying on periodic scans", { root: root.local_path, error: String(err) });
    }
  }

  const interval = setInterval(() => {
    for (const root of state.roots()) due.add(root.id);
    poke();
  }, options.intervalMs);

  try {
    while (!options.signal?.aborted) {
      const next = [...due];
      due.clear();
      for (const id of next) {
        if (options.signal?.aborted) break;
        const root = state.roots().find((r) => r.id === id);
        if (!root || root.paused) continue;
        await syncOne(state, engine, root.id, root.local_path, options.onCycle);
      }
      if (due.size === 0 && !options.signal?.aborted) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = null;
      }
    }
  } finally {
    clearInterval(interval);
    for (const t of timers.values()) clearTimeout(t);
    for (const w of watchers) w.close();
  }
}

/**
 * One `run` per config directory: two daemons on the same state would race each other's
 * uploads and moves. A stale lock (its process is gone) is taken over.
 */
export function acquireRunLock(): () => void {
  mkdirSync(configDir(), { recursive: true });
  const lockFile = path.join(configDir(), "run.lock");
  try {
    const pid = Number(readFileSync(lockFile, "utf8"));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws if no such process
      throw new Error(`dbase-sync is already running (pid ${pid}).`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("dbase-sync is already running")) throw err;
  }
  writeFileSync(lockFile, String(process.pid));
  return () => rmSync(lockFile, { force: true });
}
