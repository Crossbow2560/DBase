// End-to-end: two sync "devices" (separate state + local folder each) against a real DBase
// backend from the server's integration-test harness, with the web UI's side played by direct
// API calls. Requires the test containers: `npm run test:db:up` in the repo root.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "dbase-sync-e2e-"));
process.env.DBASE_SYNC_HOME = home;

const harness = await import("../../test/integration/harness.js");
const { Api } = await import("../src/api.js");
const { State } = await import("../src/state.js");
const { SyncEngine } = await import("../src/engine.js");

type TestEnv = Awaited<ReturnType<typeof harness.setupTestEnv>>;
let env: TestEnv;
let server: string;

before(async () => {
  env = await harness.setupTestEnv();
  await env.app.listen({ port: 0, host: "127.0.0.1" });
  const address = env.app.server.address();
  server = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await env?.teardown();
  rmSync(home, { recursive: true, force: true });
});

interface Device {
  dir: string;
  state: InstanceType<typeof State>;
  engine: InstanceType<typeof SyncEngine>;
  rootId: number;
  sync: () => Promise<Awaited<ReturnType<InstanceType<typeof SyncEngine>["syncRoot"]>>>;
  file: (rel: string) => string;
  read: (rel: string) => string;
  write: (rel: string, content: string) => void;
}

let deviceCounter = 0;

function device(token: string, remoteId: string): Device {
  deviceCounter++;
  const dir = mkdtempSync(path.join(tmpdir(), `dbase-sync-dev${deviceCounter}-`));
  const state = new State(path.join(home, `state-${deviceCounter}.db`));
  const engine = new SyncEngine(state, new Api(server, { token }));
  const root = state.addRoot(dir, remoteId, "root");
  const file = (rel: string) => path.join(dir, ...rel.split("/"));
  return {
    dir,
    state,
    engine,
    rootId: root.id,
    sync: () => engine.syncRoot(root.id),
    file,
    read: (rel) => readFileSync(file(rel), "utf8"),
    write: (rel, content) => {
      mkdirSync(path.dirname(file(rel)), { recursive: true });
      writeFileSync(file(rel), content);
    },
  };
}

/** A user with a fresh remote root folder, and the web-side helpers. */
async function setup() {
  const { user, cookie } = await harness.createUserAndLogin(env);
  const { token } = await harness.createDeviceToken(env, cookie);
  const web = harness.api(env, cookie);
  const rootId = (await web.post("/folders", { name: `Sync ${deviceCounter}` })).json().folder.id as string;
  const contents = async (folderId = rootId) =>
    (await web.get(`/folders/${folderId}/contents`)).json().items as { id: string; name: string; type: string }[];
  const remoteFile = async (name: string, folderId = rootId) => (await contents(folderId)).find((i) => i.name === name);
  const download = async (fileId: string) => {
    const res = await web.get(`/files/${fileId}/download`);
    return (await fetch(res.json().url)).text();
  };
  return { user, cookie, token, web, rootId, contents, remoteFile, download };
}

describe("one-way", () => {
  test("down: remote files and folders arrive locally", async () => {
    const s = await setup();
    const sub = (await s.web.post("/folders", { name: "Docs", parentFolderId: s.rootId })).json().folder.id;
    await harness.uploadFile(env, s.cookie, { name: "hello.txt", data: Buffer.from("hi from the web"), folderId: s.rootId });
    await harness.uploadFile(env, s.cookie, { name: "deep.txt", data: Buffer.from("deep"), folderId: sub });

    const a = device(s.token, s.rootId);
    const summary = await a.sync();
    assert.equal(summary.downloaded, 2);
    assert.equal(a.read("hello.txt"), "hi from the web");
    assert.equal(a.read("Docs/deep.txt"), "deep");

    // A second pass with nothing new does nothing.
    const again = await a.sync();
    assert.deepEqual([again.downloaded, again.uploaded, again.errors], [0, 0, 0]);
  });

  test("up: local files, folders, an empty file and a multi-part file reach DBase", async () => {
    const s = await setup();
    const a = device(s.token, s.rootId);
    await a.sync();
    a.write("notes.txt", "local notes");
    a.write("Projects/plan.md", "# plan");
    a.write("empty.txt", "");
    const big = Buffer.alloc(9 * 1024 * 1024 + 123, 7);
    writeFileSync(a.file("big.bin"), big);

    const summary = await a.sync();
    assert.equal(summary.errors, 0, JSON.stringify(a.state.issues()));
    assert.equal(summary.uploaded, 4);
    assert.equal(summary.foldersCreated, 1);

    const notes = await s.remoteFile("notes.txt");
    assert.equal(await s.download(notes!.id), "local notes");
    const projects = await s.remoteFile("Projects");
    assert.equal(projects?.type, "folder");
    assert.ok(await s.remoteFile("plan.md", projects!.id));
    const bigRemote = await env.db.files.findUniqueOrThrow({ where: { id: (await s.remoteFile("big.bin"))!.id } });
    assert.equal(bigRemote.size_bytes, BigInt(big.length));

    // Another device gets all of it.
    const b = device(s.token, s.rootId);
    await b.sync();
    assert.equal(b.read("Projects/plan.md"), "# plan");
    assert.equal(b.read("empty.txt"), "");
    assert.deepEqual(readFileSync(b.file("big.bin")), big);
  });
});

describe("two-way", () => {
  test("edits flow both ways, replacing content in place", async () => {
    const s = await setup();
    const a = device(s.token, s.rootId);
    const b = device(s.token, s.rootId);
    a.write("doc.txt", "v1");
    await a.sync();
    await b.sync();
    const id = (await s.remoteFile("doc.txt"))!.id;

    a.write("doc.txt", "v2 from A");
    assert.equal((await a.sync()).uploaded, 1);
    assert.equal((await s.remoteFile("doc.txt"))!.id, id, "same file, new content");
    await b.sync();
    assert.equal(b.read("doc.txt"), "v2 from A");

    b.write("doc.txt", "v3 from B");
    await b.sync();
    await a.sync();
    assert.equal(a.read("doc.txt"), "v3 from B");
    assert.equal(await harness.storageUsed(env, s.user.id), BigInt("v3 from B".length));
  });

  test("both sides edited: both versions are kept everywhere", async () => {
    const s = await setup();
    const a = device(s.token, s.rootId);
    const b = device(s.token, s.rootId);
    a.write("report.txt", "base");
    await a.sync();
    await b.sync();

    a.write("report.txt", "A's edit");
    b.write("report.txt", "B's edit");
    await a.sync();
    const conflicted = await b.sync();
    assert.equal(conflicted.conflicts, 1);
    assert.equal(b.read("report.txt"), "A's edit");
    const copy = readdirSync(b.dir).find((n) => n.includes("conflicted copy"))!;
    assert.match(copy, /^report \(conflicted copy .+ \d{4}-\d{2}-\d{2}\)\.txt$/);
    assert.equal(b.read(copy), "B's edit");
    assert.ok(b.state.issues().some((i) => i.kind === "conflict"));

    await b.sync(); // uploads the copy
    await a.sync();
    assert.equal(a.read(copy), "B's edit");
    assert.equal(a.read("report.txt"), "A's edit");
  });

  test("first sync of an existing local folder into a folder with the same files", async () => {
    const s = await setup();
    await harness.uploadFile(env, s.cookie, { name: "same.txt", data: Buffer.from("same"), folderId: s.rootId });
    await harness.uploadFile(env, s.cookie, { name: "differs.txt", data: Buffer.from("remote"), folderId: s.rootId });
    const a = device(s.token, s.rootId);
    a.write("same.txt", "same");
    a.write("differs.txt", "local");

    const summary = await a.sync();
    // The web upload had no checksum, so "same.txt" is compared by downloading it: no conflict.
    assert.equal(summary.conflicts, 1);
    assert.equal(a.read("same.txt"), "same");
    assert.equal(a.read("differs.txt"), "remote");
    assert.ok(readdirSync(a.dir).some((n) => n.startsWith("differs (conflicted copy")));
  });
});

describe("deletes never propagate", () => {
  test("a local delete stays local, comes back on a remote edit, and on restore", async () => {
    const s = await setup();
    const a = device(s.token, s.rootId);
    const b = device(s.token, s.rootId);
    a.write("keep.txt", "1");
    a.write("other.txt", "x");
    await a.sync();
    await b.sync();

    rmSync(a.file("keep.txt"));
    await a.sync();
    assert.ok(await s.remoteFile("keep.txt"), "still in DBase");
    await a.sync();
    assert.ok(!existsSync(a.file("keep.txt")), "not downloaded again");

    b.write("keep.txt", "2"); // edited elsewhere: the edit wins
    await b.sync();
    await a.sync();
    assert.equal(a.read("keep.txt"), "2");

    rmSync(a.file("other.txt"));
    await a.sync();
    assert.equal(a.engine.restore(a.rootId, "other.txt"), 1);
    await a.sync();
    assert.equal(a.read("other.txt"), "x");
  });

  test("a locally deleted folder stays deleted, including new files added to it remotely", async () => {
    const s = await setup();
    const a = device(s.token, s.rootId);
    a.write("Old/a.txt", "a");
    await a.sync();
    const oldId = (await s.remoteFile("Old"))!.id;

    rmSync(a.file("Old"), { recursive: true });
    await a.sync();
    await harness.uploadFile(env, s.cookie, { name: "new.txt", data: Buffer.from("n"), folderId: oldId });
    await a.sync();
    assert.ok(!existsSync(a.file("Old")));
    assert.ok(await s.remoteFile("a.txt", oldId));
  });

  test("trashing in DBase keeps the local copy, detached; edits aren't uploaded; restore relinks", async () => {
    const s = await setup();
    const a = device(s.token, s.rootId);
    a.write("draft.txt", "mine");
    await a.sync();
    const id = (await s.remoteFile("draft.txt"))!.id;

    await s.web.delete(`/files/${id}`);
    await a.sync();
    assert.equal(a.read("draft.txt"), "mine");
    assert.equal(a.state.entries(a.rootId).find((e) => e.rel_path === "draft.txt")?.status, "detached");

    a.write("draft.txt", "mine, edited");
    const pass = await a.sync();
    assert.equal(pass.uploaded, 0, "a detached file is never uploaded");
    assert.equal((await env.db.files.findUniqueOrThrow({ where: { id } })).deleted_at !== null, true);

    await s.web.post(`/trash/file/${id}/restore`);
    await a.sync();
    // Restored with the old content while the local copy was edited: both kept.
    assert.equal(a.read("draft.txt"), "mine");
    assert.ok(readdirSync(a.dir).some((n) => n.startsWith("draft (conflicted copy")));
  });

  test("reattach uploads a detached file as a new file", async () => {
    const s = await setup();
    const a = device(s.token, s.rootId);
    a.write("again.txt", "content");
    await a.sync();
    const id = (await s.remoteFile("again.txt"))!.id;
    await s.web.delete(`/files/${id}`);
    await a.sync();

    assert.equal(a.engine.reattach(a.rootId, ""), 1);
    await a.sync();
    const back = await s.remoteFile("again.txt");
    assert.ok(back);
    assert.notEqual(back.id, id);
  });
});

describe("moves", () => {
  test("local renames and moves keep the DBase item (same id)", async () => {
    const s = await setup();
    const a = device(s.token, s.rootId);
    const b = device(s.token, s.rootId);
    a.write("one.txt", "one");
    a.write("Dir/two.txt", "two");
    a.write("Dest/.keep", "");
    await a.sync();
    await b.sync();
    const oneId = (await s.remoteFile("one.txt"))!.id;
    const dirId = (await s.remoteFile("Dir"))!.id;

    renameSync(a.file("one.txt"), a.file("Dest/uno.txt"));
    renameSync(a.file("Dir"), a.file("Folder"));
    const pass = await a.sync();
    assert.equal(pass.movedRemote, 2);
    assert.equal(pass.uploaded, 0);
    const destId = (await s.remoteFile("Dest"))!.id;
    assert.equal((await s.remoteFile("uno.txt", destId))?.id, oneId);
    assert.equal((await s.remoteFile("Folder"))?.id, dirId);

    const bPass = await b.sync();
    assert.equal(bPass.movedLocal, 2);
    assert.equal(b.read("Dest/uno.txt"), "one");
    assert.equal(b.read("Folder/two.txt"), "two");
    assert.ok(!existsSync(b.file("one.txt")));
  });

  test("remote renames and moves are followed locally", async () => {
    const s = await setup();
    const a = device(s.token, s.rootId);
    a.write("f.txt", "f");
    a.write("A/inner.txt", "i");
    await a.sync();
    const fId = (await s.remoteFile("f.txt"))!.id;
    const aId = (await s.remoteFile("A"))!.id;

    await s.web.patch(`/files/${fId}`, { name: "renamed.txt", folderId: aId });
    await s.web.patch(`/folders/${aId}`, { name: "B" });
    const pass = await a.sync();
    assert.equal(pass.downloaded, 0);
    assert.equal(a.read("B/renamed.txt"), "f");
    assert.equal(a.read("B/inner.txt"), "i");
    assert.ok(!existsSync(a.file("A")));
  });
});

describe("shared roots", () => {
  test("a viewer syncs down only, and local changes are reported, not uploaded", async () => {
    const owner = await setup();
    const viewer = await harness.createUserAndLogin(env);
    await owner.web.post(`/items/folder/${owner.rootId}/permissions`, { userId: viewer.user.id, role: "viewer" });
    const { token } = await harness.createDeviceToken(env, viewer.cookie);
    await harness.uploadFile(env, owner.cookie, { name: "shared.txt", data: Buffer.from("s"), folderId: owner.rootId });

    const v = device(token, owner.rootId);
    await v.sync();
    assert.equal(v.read("shared.txt"), "s");
    assert.equal(v.state.root(v.rootId).role, "viewer");

    v.write("mine.txt", "nope");
    const pass = await v.sync();
    assert.equal(pass.uploaded, 0);
    assert.equal(await owner.remoteFile("mine.txt"), undefined);
    assert.ok(v.state.issues().some((i) => i.kind === "read_only" && i.rel_path === "mine.txt"));
  });

  test("an editor's changes reach the owner", async () => {
    const owner = await setup();
    const editor = await harness.createUserAndLogin(env);
    await owner.web.post(`/items/folder/${owner.rootId}/permissions`, { userId: editor.user.id, role: "editor" });
    const { token } = await harness.createDeviceToken(env, editor.cookie);
    const e = device(token, owner.rootId);
    const o = device(owner.token, owner.rootId);
    e.write("from-editor.txt", "hello owner");
    await e.sync();
    await o.sync();
    assert.equal(o.read("from-editor.txt"), "hello owner");
  });
});

describe("the CLI", () => {
  test("login → add → run --once → status/conflicts → restore → logout", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const cliHome = mkdtempSync(path.join(tmpdir(), "dbase-sync-cli-"));
    const localDir = mkdtempSync(path.join(tmpdir(), "dbase-sync-clidir-"));
    const { user, cookie } = await harness.createUserAndLogin(env);
    const cli = async (...args: string[]) => {
      const { stdout } = await run(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "../src/cli.ts"), ...args], {
        env: { ...process.env, DBASE_SYNC_HOME: cliHome, DBASE_SYNC_PASSWORD: user.password },
      });
      return stdout;
    };

    try {
      assert.match(await cli("login", "--server", server, "--email", user.email, "--name", "e2e laptop"), /Logged in as/);
      const tokens = (await harness.api(env, cookie).get("/auth/device-tokens")).json().deviceTokens;
      assert.deepEqual(tokens.map((t: { name: string }) => t.name), ["e2e laptop"]);

      assert.match(await cli("add", localDir, "Work/Synced"), /Syncing/);
      writeFileSync(path.join(localDir, "cli.txt"), "via the CLI");
      await cli("run", "--once");

      const web = harness.api(env, cookie);
      const work = (await web.get("/folders/contents")).json().items.find((i: { name: string }) => i.name === "Work");
      const synced = (await web.get(`/folders/${work.id}/contents`)).json().items.find((i: { name: string }) => i.name === "Synced");
      const files = (await web.get(`/folders/${synced.id}/contents`)).json().items;
      assert.deepEqual(files.map((f: { name: string }) => f.name), ["cli.txt"]);

      assert.match(await cli("status"), /1 synced, 0 deleted here/);
      assert.match(await cli("conflicts"), /Nothing needs attention/);

      rmSync(path.join(localDir, "cli.txt"));
      await cli("run", "--once");
      assert.match(await cli("status"), /0 synced, 1 deleted here \(kept in DBase\)/);
      assert.match(await cli("restore", path.join(localDir, "cli.txt")), /1 item\(s\) will be downloaded again/);
      await cli("run", "--once");
      assert.equal(readFileSync(path.join(localDir, "cli.txt"), "utf8"), "via the CLI");

      assert.match(await cli("logout"), /Logged out/);
      assert.deepEqual((await harness.api(env, cookie).get("/auth/device-tokens")).json().deviceTokens, []);
    } finally {
      rmSync(cliHome, { recursive: true, force: true });
      rmSync(localDir, { recursive: true, force: true });
    }
  });
});

describe("the daemon", () => {
  test("a local change is picked up by the watcher, well before the poll interval", async () => {
    const { runLoop } = await import("../src/daemon.js");
    const s = await setup();
    const a = device(s.token, s.rootId);
    const controller = new AbortController();
    const loop = runLoop(a.state, new Api(server, { token: s.token }), {
      once: false,
      intervalMs: 10 * 60 * 1000,
      signal: controller.signal,
    });
    try {
      await new Promise((r) => setTimeout(r, 1500)); // initial pass
      a.write("watched.txt", "seen");
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !(await s.remoteFile("watched.txt"))) await new Promise((r) => setTimeout(r, 250));
      assert.ok(await s.remoteFile("watched.txt"), "not uploaded within 15s");
    } finally {
      controller.abort();
      await loop;
    }
  });
});

describe("Windows filename rules (forced on this platform)", () => {
  test("names Windows can't store, and case-only collisions, are skipped and reported", async () => {
    const s = await setup();
    for (const name of ["ok.txt", "a:b.txt", "CON.txt", "Readme.md", "README.md"]) {
      await harness.uploadFile(env, s.cookie, { name, data: Buffer.from(name), folderId: s.rootId });
    }
    const dir = mkdtempSync(path.join(tmpdir(), "dbase-sync-win-"));
    const state = new State(path.join(home, `state-win.db`));
    const root = state.addRoot(dir, s.rootId, "root");
    const engine = new SyncEngine(state, new Api(server, { token: s.token }), "win32");
    const pass = await engine.syncRoot(root.id);

    assert.equal(pass.errors, 0);
    const local = readdirSync(dir).sort();
    assert.equal(local.length, 2, local.join(","));
    assert.ok(local.includes("ok.txt"));
    assert.equal(local.filter((n) => n.toLowerCase() === "readme.md").length, 1);
    const skipped = state.issues(root.id).filter((i) => i.kind === "unsyncable").map((i) => i.rel_path).sort();
    assert.equal(skipped.length, 3);
    assert.ok(skipped.includes("a:b.txt") && skipped.includes("CON.txt"));
  });
});
