// The sync read API (modules/sync) and its change log (supabase/migrations/0028).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { api, createDeviceToken, createUserAndLogin, setupTestEnv, uploadFile, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

type SyncEvent = { seq: string; kind: string; itemType: string; itemId: string; name: string; parentId: string | null };

async function createFolder(auth: string, name: string, parentFolderId: string | null = null): Promise<string> {
  const res = await api(env, auth).post("/folders", { name, parentFolderId });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().folder.id;
}

async function tree(auth: string, root: string) {
  const res = await api(env, auth).get(`/sync/tree?root=${root}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as {
    root: { id: string; role: string };
    cursor: string;
    items: { kind: string; id: string; parentId: string; name: string; checksum: string | null }[];
    nextAfter: string | null;
  };
}

async function changes(auth: string, root: string, cursor: string) {
  const res = await api(env, auth).get(`/sync/changes?root=${root}&cursor=${cursor}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { events: SyncEvent[]; cursor: string; hasMore: boolean };
}

const summary = (events: SyncEvent[]) => events.map((e) => `${e.kind}:${e.name}`);

describe("sync tree", () => {
  test("lists the live subtree with parents, and the caller's role", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "Sync");
    const sub = await createFolder(cookie, "Sub", root);
    await uploadFile(env, cookie, { name: "a.txt", data: Buffer.from("a"), folderId: root });
    await uploadFile(env, cookie, { name: "b.txt", data: Buffer.from("b"), folderId: sub });
    const trashed = await uploadFile(env, cookie, { name: "gone.txt", data: Buffer.from("x"), folderId: sub });
    await api(env, cookie).delete(`/files/${trashed.file.id}`);
    // Outside the root: never listed.
    await uploadFile(env, cookie, { name: "outside.txt", data: Buffer.from("o") });

    const t = await tree(cookie, root);
    assert.equal(t.root.role, "owner");
    assert.match(t.cursor, /^\d+$/);
    const byName = Object.fromEntries(t.items.map((i) => [i.name, i]));
    assert.deepEqual(Object.keys(byName).sort(), ["Sub", "a.txt", "b.txt"]);
    assert.equal(byName["Sub"]!.parentId, root);
    assert.equal(byName["b.txt"]!.parentId, sub);
    assert.equal(byName["a.txt"]!.kind, "file");
  });

  test("pages by id", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "Paged");
    for (let i = 0; i < 5; i++) await createFolder(cookie, `f${i}`, root);

    const seen: string[] = [];
    let after: string | null = null;
    do {
      const res = await api(env, cookie).get(`/sync/tree?root=${root}&limit=2${after ? `&after=${after}` : ""}`);
      const body = res.json();
      seen.push(...body.items.map((i: { name: string }) => i.name));
      after = body.nextAfter;
    } while (after);
    assert.deepEqual(seen.sort(), ["f0", "f1", "f2", "f3", "f4"]);
  });

  test("access: owner, viewer via share, stranger 404, trashed root 404", async () => {
    const owner = await createUserAndLogin(env);
    const viewer = await createUserAndLogin(env);
    const stranger = await createUserAndLogin(env);
    const root = await createFolder(owner.cookie, "Shared");
    const share = await api(env, owner.cookie).post(`/items/folder/${root}/permissions`, {
      userId: viewer.user.id,
      role: "viewer",
    });
    assert.ok(share.statusCode < 300, share.body);

    assert.equal((await tree(viewer.cookie, root)).root.role, "viewer");
    const denied = await api(env, stranger.cookie).get(`/sync/tree?root=${root}`);
    assert.equal(denied.statusCode, 404);
    assert.equal(denied.json().error.code, "SYNC_ROOT_UNAVAILABLE");
    assert.equal((await api(env, stranger.cookie).get(`/sync/changes?root=${root}&cursor=0`)).statusCode, 404);

    await api(env, owner.cookie).delete(`/folders/${root}`);
    assert.equal((await api(env, owner.cookie).get(`/sync/tree?root=${root}`)).statusCode, 404);
  });
});

describe("sync changes", () => {
  test("reports create, update-free rename/move, trash, restore and purge in order", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "Feed");
    const sub = await createFolder(cookie, "Sub", root);
    const start = (await tree(cookie, root)).cursor;

    const { file } = await uploadFile(env, cookie, { name: "doc.txt", data: Buffer.from("v1"), folderId: root });
    await api(env, cookie).patch(`/files/${file.id}`, { name: "renamed.txt" });
    await api(env, cookie).patch(`/files/${file.id}`, { folderId: sub });
    await api(env, cookie).delete(`/files/${file.id}`);
    await api(env, cookie).post(`/trash/file/${file.id}/restore`);
    await api(env, cookie).delete(`/files/${file.id}`);
    await api(env, cookie).delete(`/trash/file/${file.id}`);
    const { runDeletionQueueTick } = await import("../../src/modules/trash/deletion-queue-service.js");
    await runDeletionQueueTick();

    const c = await changes(cookie, root, start);
    assert.deepEqual(summary(c.events), [
      "create:doc.txt",
      "move:renamed.txt",
      "move:renamed.txt",
      "trash:renamed.txt",
      "restore:renamed.txt",
      "trash:renamed.txt",
      "purge:renamed.txt",
    ]);
    assert.equal(c.events[2]!.parentId, sub);
    // Seqs are strictly increasing, and resuming from the returned cursor yields nothing new.
    const seqs = c.events.map((e) => BigInt(e.seq));
    assert.deepEqual([...seqs].sort((a, b) => (a < b ? -1 : 1)), seqs);
    assert.equal((await changes(cookie, root, c.cursor)).events.length, 0);
  });

  test("moves across the subtree boundary are move_in / move_out; outside events are hidden", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "Root");
    const outside = await createFolder(cookie, "Outside");
    const start = (await tree(cookie, root)).cursor;

    const { file } = await uploadFile(env, cookie, { name: "f.txt", data: Buffer.from("f"), folderId: outside });
    await api(env, cookie).patch(`/files/${file.id}`, { folderId: root });
    await api(env, cookie).patch(`/files/${file.id}`, { folderId: outside });
    const folder = await createFolder(cookie, "Movable", outside);
    await api(env, cookie).patch(`/folders/${folder}`, { parentFolderId: root });

    const c = await changes(cookie, root, start);
    assert.deepEqual(summary(c.events), ["move_in:f.txt", "move_out:f.txt", "move_in:Movable"]);
  });

  test("a trashed folder reports every descendant; events about the root itself are omitted", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "R");
    const sub = await createFolder(cookie, "Sub", root);
    await uploadFile(env, cookie, { name: "inner.txt", data: Buffer.from("i"), folderId: sub });
    const start = (await tree(cookie, root)).cursor;

    await api(env, cookie).patch(`/folders/${root}`, { name: "R renamed" });
    await api(env, cookie).delete(`/folders/${sub}`);

    const c = await changes(cookie, root, start);
    assert.deepEqual(summary(c.events).sort(), ["trash:Sub", "trash:inner.txt"]);
  });

  test("shared roots: a viewer sees an editor's changes", async () => {
    const owner = await createUserAndLogin(env);
    const viewer = await createUserAndLogin(env);
    const root = await createFolder(owner.cookie, "Team");
    await api(env, owner.cookie).post(`/items/folder/${root}/permissions`, { userId: viewer.user.id, role: "viewer" });
    const start = (await tree(viewer.cookie, root)).cursor;

    await uploadFile(env, owner.cookie, { name: "shared.txt", data: Buffer.from("s"), folderId: root });
    assert.deepEqual(summary((await changes(viewer.cookie, root, start)).events), ["create:shared.txt"]);
  });

  test("works with a device token", async () => {
    const { cookie } = await createUserAndLogin(env);
    const { token } = await createDeviceToken(env, cookie);
    const root = await createFolder(token, "Via token");
    const start = (await tree(token, root)).cursor;
    await createFolder(token, "child", root);
    assert.deepEqual(summary((await changes(token, root, start)).events), ["create:child"]);
  });

  test("pages with hasMore, and the cursor resumes exactly", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "Many");
    const start = (await tree(cookie, root)).cursor;
    for (let i = 0; i < 5; i++) await createFolder(cookie, `c${i}`, root);

    const names: string[] = [];
    let cursor = start;
    for (;;) {
      const res = await api(env, cookie).get(`/sync/changes?root=${root}&cursor=${cursor}&limit=2`);
      const body = res.json();
      names.push(...body.events.map((e: SyncEvent) => e.name));
      cursor = body.cursor;
      if (!body.hasMore) break;
    }
    assert.deepEqual(names, ["c0", "c1", "c2", "c3", "c4"]);
  });

  test("a cursor never skips an event that commits out of order", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "Race");
    const rootRow = await env.db.folders.findUniqueOrThrow({ where: { id: root } });
    const start = (await tree(cookie, root)).cursor;

    const insertFolder = (client: Client, name: string) => {
      const id = randomUUID();
      return client.query(
        `insert into folders (id, name, owner_id, parent_folder_id, materialized_path) values ($1, $2, $3, $4, $5)`,
        [id, name, rootRow.owner_id, root, `${rootRow.materialized_path}${id}/`],
      );
    };

    const slow = new Client({ connectionString: process.env.DATABASE_URL });
    const fast = new Client({ connectionString: process.env.DATABASE_URL });
    await slow.connect();
    await fast.connect();
    try {
      // `slow` writes its event first (lower insertion order) but commits last.
      await slow.query("begin");
      await insertFolder(slow, "slow");
      await insertFolder(fast, "fast"); // autocommit

      const first = await changes(cookie, root, start);
      assert.deepEqual(summary(first.events), ["create:fast"]);

      await slow.query("commit");
      const second = await changes(cookie, root, first.cursor);
      assert.deepEqual(summary(second.events), ["create:slow"]);
    } finally {
      await slow.end();
      await fast.end();
    }
  });

  test("a cursor older than the retained log is rejected with 410", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "Old");
    const state = await env.db.sync_state.findUniqueOrThrow({ where: { id: true } });
    await env.db.sync_state.update({ where: { id: true }, data: { pruned_through_seq: state.last_seq } });
    try {
      const res = await api(env, cookie).get(`/sync/changes?root=${root}&cursor=0`);
      assert.equal(res.statusCode, 410);
      assert.equal(res.json().error.code, "CURSOR_EXPIRED");
    } finally {
      await env.db.sync_state.update({ where: { id: true }, data: { pruned_through_seq: 0n } });
    }
    assert.equal((await api(env, cookie).get(`/sync/changes?root=${root}&cursor=abc`)).statusCode, 400);
  });
});

describe("sync event retention", () => {
  test("prunes old events through a seq, and cursors before it expire", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "Prune");
    const start = (await tree(cookie, root)).cursor;
    await createFolder(cookie, "old", root);
    const mid = (await tree(cookie, root)).cursor;
    await env.db.$executeRaw`UPDATE sync_events SET occurred_at = now() - interval '100 days' WHERE seq <= ${BigInt(mid)} OR seq IS NULL`;
    await createFolder(cookie, "new", root);

    const { pruneSyncEvents } = await import("../../src/modules/sync/service.js");
    assert.ok((await pruneSyncEvents(60)) > 0);

    assert.equal((await api(env, cookie).get(`/sync/changes?root=${root}&cursor=${start}`)).statusCode, 410);
    assert.deepEqual(summary((await changes(cookie, root, mid)).events), ["create:new"]);
    // Pruning again with nothing old enough is a no-op.
    assert.equal(await pruneSyncEvents(60), 0);
  });
});

describe("sync download-urls and batch", () => {
  test("download-urls: one audit row per owner, unavailable ids reported", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "DL");
    const a = await uploadFile(env, cookie, { name: "a.bin", data: Buffer.from("aa"), folderId: root });
    const b = await uploadFile(env, cookie, { name: "b.bin", data: Buffer.from("bb"), folderId: root });
    const other = await createUserAndLogin(env);
    const theirs = await uploadFile(env, other.cookie, { name: "theirs.bin", data: Buffer.from("t") });

    const res = await api(env, cookie).post("/sync/download-urls", {
      fileIds: [a.file.id, b.file.id, theirs.file.id, randomUUID()],
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(body.urls.map((u: { id: string }) => u.id).sort(), [a.file.id, b.file.id].sort());
    assert.equal(body.unavailable.length, 2);

    const fetched = await fetch(body.urls.find((u: { id: string }) => u.id === a.file.id).url);
    assert.equal(await fetched.text(), "aa");

    const logs = await env.db.activity_log.findMany({ where: { actor_id: user.id, action: "download" } });
    assert.equal(logs.length, 1);
    assert.equal((logs[0]!.metadata as { count: number }).count, 2);
  });

  test("batch: moves and renames independently, with per-op results", async () => {
    const { cookie } = await createUserAndLogin(env);
    const root = await createFolder(cookie, "Batch");
    const dest = await createFolder(cookie, "Dest", root);
    const a = await uploadFile(env, cookie, { name: "a.txt", data: Buffer.from("a"), folderId: root });
    const b = await uploadFile(env, cookie, { name: "b.txt", data: Buffer.from("b"), folderId: root });

    const res = await api(env, cookie).post("/sync/batch", {
      ops: [
        { type: "file", id: a.file.id, parentId: dest },
        { type: "file", id: b.file.id, name: "a.txt", parentId: dest }, // collides with the first op
        { type: "folder", id: dest, name: "Renamed" },
      ],
    });
    assert.equal(res.statusCode, 200, res.body);
    const results = res.json().results;
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error.code, "NAME_COLLISION");
    assert.equal(results[2].ok, true);
    assert.equal((await env.db.folders.findUniqueOrThrow({ where: { id: dest } })).name, "Renamed");

    // There is no trash op: an unknown property is stripped (Fastify's Ajv removeAdditional), so
    // this is a no-op move and the file stays live.
    await api(env, cookie).post("/sync/batch", { ops: [{ type: "file", id: a.file.id, op: "trash" }] });
    assert.equal((await env.db.files.findUniqueOrThrow({ where: { id: a.file.id } })).deleted_at, null);
  });
});
