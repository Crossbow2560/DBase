#!/usr/bin/env node
import { mkdirSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Api, ApiError } from "./api.js";
import { loadCredentials, saveCredentials, configDir } from "./config.js";
import { acquireRunLock, runLoop } from "./daemon.js";
import { SyncEngine } from "./engine.js";
import { log, setLogEcho } from "./log.js";
import { normalizeName } from "./names.js";
import { State, type RootRow } from "./state.js";

const USAGE = `dbase-sync — keep local folders in sync with DBase

Usage:
  dbase-sync login --server <url> [--email <email>] [--name <device name>]
  dbase-sync logout
  dbase-sync add <local-dir> <remote-folder>   remote folder: a path in My Files ("Work/Docs",
                                               created if missing) or a folder id (for folders
                                               shared with you)
  dbase-sync list
  dbase-sync remove <local-dir>                stop syncing (files on both sides are kept)
  dbase-sync run [--once] [--interval <seconds>]
  dbase-sync status
  dbase-sync conflicts                         conflicts, detached edits, skipped names, errors
  dbase-sync pause <local-dir|all>
  dbase-sync resume <local-dir|all>
  dbase-sync restore <local-path>              bring back files you deleted locally
  dbase-sync reattach <local-path>             upload detached files (removed in DBase) as new files

Deletes never propagate: deleting a file here leaves it in DBase, and trashing it in DBase
leaves your local copy (marked detached). Config and state live in ${configDir()}.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  console.error(`dbase-sync: ${message}`);
  process.exit(1);
}

function requireApi(): Api {
  const creds = loadCredentials();
  if (!creds?.token) fail("not logged in — run `dbase-sync login --server <url>` first.");
  return new Api(creds.server, { token: creds.token });
}

async function prompt(question: string, hidden = false): Promise<string> {
  if (!hidden || !process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

/** The root containing a local path, and that path relative to it in sync-path form. */
function locate(state: State, localPath: string): { root: RootRow; relPath: string } {
  const abs = path.resolve(localPath);
  for (const root of state.roots()) {
    const rel = path.relative(root.local_path, abs);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return { root, relPath: rel.split(path.sep).filter(Boolean).map(normalizeName).join("/") };
    }
  }
  fail(`${abs} isn't inside any synced folder (see \`dbase-sync list\`).`);
}

function rootsFor(state: State, arg: string | undefined): RootRow[] {
  if (!arg) fail("which folder? Give a synced local folder, or `all`.");
  if (arg === "all") return state.roots();
  const root = state.rootByPath(canonical(arg));
  if (!root) fail(`${arg} isn't a synced folder (see \`dbase-sync list\`).`);
  return [root];
}

function canonical(dir: string): string {
  const abs = path.resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

async function resolveRemoteFolder(api: Api, spec: string): Promise<{ id: string; name: string }> {
  if (UUID.test(spec)) {
    const page = await api.tree(spec, null).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) fail(`no folder ${spec} that you can access.`);
      throw err;
    });
    return { id: page.root.id, name: page.root.name };
  }
  const segments = spec.split("/").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) fail("syncing all of My Files isn't supported; pick a folder (e.g. `Sync` — it's created if missing).");
  let parent: string | null = null;
  let current = { id: "", name: "" };
  for (const segment of segments) {
    const { items } = await api.folderContents(parent);
    const found = items.find((i) => i.type === "folder" && normalizeName(i.name) === normalizeName(segment));
    if (found) {
      current = { id: found.id, name: found.name };
    } else {
      const { folder } = await api.createFolder(segment, parent);
      console.log(`Created folder "${segment}" in DBase.`);
      current = { id: folder.id, name: folder.name };
    }
    parent = current.id;
  }
  return current;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
      once: { type: "boolean" },
      interval: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "login": {
      const server = values.server ?? loadCredentials()?.server;
      if (!server) fail("--server <url> is required, e.g. --server https://dbase.example.com");
      const email = values.email ?? (await prompt("Email: "));
      const password = process.env.DBASE_SYNC_PASSWORD ?? (await prompt("Password: ", true));
      const name = values.name ?? `dbase-sync on ${hostname()}`;
      const cookie = await new Api(server).login(email, password).catch((err: unknown) => {
        fail(err instanceof ApiError ? err.message : String(err));
      });
      // The password session is only used to mint a long-lived device token, then signed out.
      const session = new Api(server, { cookie });
      const { deviceToken } = await session.createDeviceToken(name);
      await session.logout().catch(() => undefined);
      saveCredentials({ server, token: deviceToken.token, tokenName: name, email });
      console.log(`Logged in as ${email}. This device is listed as "${name}" in your DBase device tokens.`);
      return;
    }

    case "logout": {
      const creds = loadCredentials();
      if (creds?.token) await new Api(creds.server, { token: creds.token }).logout().catch(() => undefined);
      saveCredentials(null);
      console.log("Logged out; this device's token is revoked.");
      return;
    }

    case "add": {
      const [localDir, remoteSpec] = args;
      if (!localDir || !remoteSpec) fail("usage: dbase-sync add <local-dir> <remote-folder>");
      const api = requireApi();
      mkdirSync(localDir, { recursive: true });
      const localPath = canonical(localDir);
      const state = new State();
      const inside = (child: string, parent: string) => {
        const rel = path.relative(parent, child);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      };
      for (const r of state.roots()) {
        if (inside(localPath, r.local_path) || inside(r.local_path, localPath)) {
          fail(`${localPath} overlaps ${r.local_path}, which is already synced.`);
        }
      }
      const remote = await resolveRemoteFolder(api, remoteSpec);
      state.addRoot(localPath, remote.id, remote.name);
      console.log(`Syncing ${localPath} ⇄ DBase "${remote.name}". Run \`dbase-sync run\` to start.`);
      return;
    }

    case "list": {
      const state = new State();
      const roots = state.roots();
      if (roots.length === 0) console.log("Nothing synced yet. Add a folder with `dbase-sync add`.");
      for (const r of roots) console.log(`${r.paused ? "(paused) " : ""}${r.local_path} ⇄ ${r.remote_name} [${r.remote_id}]`);
      return;
    }

    case "remove": {
      const state = new State();
      for (const r of rootsFor(state, args[0])) {
        state.removeRoot(r.id);
        console.log(`Stopped syncing ${r.local_path}. Files on both sides were left as they are.`);
      }
      return;
    }

    case "pause":
    case "resume": {
      const state = new State();
      for (const r of rootsFor(state, args[0])) {
        state.setRootPaused(r.id, command === "pause");
        console.log(`${command === "pause" ? "Paused" : "Resumed"} ${r.local_path}.`);
      }
      return;
    }

    case "run": {
      const api = requireApi();
      const state = new State();
      if (state.roots().length === 0) fail("nothing to sync — add a folder with `dbase-sync add` first.");
      const release = acquireRunLock();
      setLogEcho(true);
      const controller = new AbortController();
      let stopping = false;
      const stop = () => {
        if (stopping) process.exit(130);
        stopping = true;
        console.log("Stopping after the current step… (Ctrl+C again to quit now)");
        controller.abort();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      const intervalMs = Math.max(5, Number(values.interval ?? 15)) * 1000;
      try {
        await api.me();
        await runLoop(state, api, {
          once: !!values.once,
          intervalMs,
          signal: controller.signal,
          onCycle: (rootPath, s) => {
            const changed = s.uploaded + s.downloaded + s.conflicts + s.movedLocal + s.movedRemote + s.foldersCreated;
            if (changed || s.errors) {
              log("info", "pass complete", { root: rootPath, ...s });
            }
          },
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) fail("the device token was revoked — run `dbase-sync login` again.");
        throw err;
      } finally {
        release();
        state.close();
      }
      return;
    }

    case "status": {
      const creds = loadCredentials();
      console.log(creds?.token ? `Logged in to ${creds.server} as ${creds.email}.` : "Not logged in.");
      const state = new State();
      for (const r of state.roots()) {
        const entries = state.entries(r.id);
        const count = (s: string) => entries.filter((e) => e.status === s && e.kind === "file").length;
        const issues = state.issues(r.id);
        console.log(`\n${r.local_path} ⇄ ${r.remote_name}${r.paused ? "  (paused)" : ""}`);
        console.log(`  access: ${r.role ?? "unknown until first sync"}${r.role === "viewer" ? " (download only)" : ""}`);
        console.log(`  last sync: ${r.last_sync_at ?? "never"}${r.last_error ? `  — last attempt failed: ${r.last_error}` : ""}`);
        console.log(`  files: ${count("synced")} synced, ${count("local_removed")} deleted here (kept in DBase), ${count("detached")} detached`);
        if (issues.length) console.log(`  ${issues.length} item(s) need attention — see \`dbase-sync conflicts\``);
      }
      return;
    }

    case "conflicts": {
      const state = new State();
      const labels: Record<string, string> = {
        conflict: "Conflict",
        detached_edit: "Detached after edit",
        unsyncable: "Skipped",
        read_only: "Not uploaded (view-only)",
        error: "Error",
      };
      let any = false;
      for (const r of state.roots()) {
        for (const issue of state.issues(r.id)) {
          any = true;
          console.log(`${labels[issue.kind] ?? issue.kind}: ${path.join(r.local_path, issue.rel_path)}\n    ${issue.message}`);
        }
      }
      if (!any) console.log("Nothing needs attention.");
      return;
    }

    case "restore":
    case "reattach": {
      if (!args[0]) fail(`usage: dbase-sync ${command} <local-path>`);
      const state = new State();
      const { root, relPath } = locate(state, args[0]);
      const engine = new SyncEngine(state, new Api("http://unused"));
      const n = command === "restore" ? engine.restore(root.id, relPath) : engine.reattach(root.id, relPath);
      if (n === 0) {
        console.log(command === "restore" ? "Nothing there was deleted locally." : "Nothing there is detached.");
      } else {
        console.log(
          command === "restore"
            ? `${n} item(s) will be downloaded again on the next sync.`
            : `${n} item(s) will be uploaded to DBase as new files on the next sync.`,
        );
      }
      return;
    }

    default:
      fail(`unknown command "${command}". Run \`dbase-sync --help\`.`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
