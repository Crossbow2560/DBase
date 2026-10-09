// Replacing a file's content in place, with checksums and compare-and-swap
// (supabase/migrations/0029, upload-service.ts completeReplace).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { api, createUserAndLogin, putPart, setupTestEnv, storageUsed, uploadFile, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function uploadWithChecksum(auth: string, name: string, data: Buffer, folderId: string | null = null) {
  const init = await api(env, auth).post("/files", { targetName: name, totalParts: 1, targetFolderId: folderId, checksum: sha256(data) });
  assert.equal(init.statusCode, 201, init.body);
  const sid = init.json().uploadSessionId as string;
  assert.equal((await putPart(env, auth, sid, 0, data)).statusCode, 204);
  const done = await api(env, auth).post(`/files/upload-sessions/${sid}/complete`, { mimeType: "text/plain" });
  assert.equal(done.statusCode, 200, done.body);
  return done.json().file as { id: string; checksum: string | null; size_bytes: string; version: string };
}

/** Starts a replace session; returns the init response so callers can check for a refusal. */
function initReplace(auth: string, fileId: string, data: Buffer, expectedVersion?: string) {
  return api(env, auth).post("/files", {
    replaceFileId: fileId,
    totalParts: 1,
    checksum: sha256(data),
    ...(expectedVersion ? { expectedVersion } : {}),
  });
}

async function replace(auth: string, fileId: string, data: Buffer, expectedVersion?: string) {
  const init = await initReplace(auth, fileId, data, expectedVersion);
  assert.equal(init.statusCode, 201, init.body);
  const sid = init.json().uploadSessionId as string;
  assert.equal((await putPart(env, auth, sid, 0, data)).statusCode, 204);
  return { sid, done: await api(env, auth).post(`/files/upload-sessions/${sid}/complete`) };
}

async function download(auth: string, fileId: string): Promise<string> {
  const res = await api(env, auth).get(`/files/${fileId}/download`);
  assert.equal(res.statusCode, 200, res.body);
  return (await fetch(res.json().url)).text();
}

describe("replace content", () => {
  test("uploads record the client checksum", async () => {
    const { cookie } = await createUserAndLogin(env);
    const data = Buffer.from("hello");
    const file = await uploadWithChecksum(cookie, "c.txt", data);
    assert.equal(file.checksum, sha256(data));
  });

  test("swaps content in place: same id, new bytes and checksum, old size credited back at once", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const v1 = Buffer.alloc(1000, 1);
    const v2 = Buffer.alloc(300, 2);
    const file = await uploadWithChecksum(cookie, "doc.bin", v1);
    assert.equal(await storageUsed(env, user.id), 1000n);

    const { done } = await replace(cookie, file.id, v2, file.version);
    assert.equal(done.statusCode, 200, done.body);
    const replaced = done.json().file;
    assert.equal(replaced.id, file.id);
    assert.equal(replaced.name, "doc.bin");
    assert.equal(replaced.size_bytes, "300");
    assert.equal(replaced.checksum, sha256(v2));
    assert.match(replaced.version, /^[0-9a-f]{32}$/);
    assert.notEqual(replaced.version, file.version);
    assert.equal(replaced.mime_type, "text/plain", "mime type is kept when not given");
    assert.equal(await storageUsed(env, user.id), 300n);
    assert.equal(await download(cookie, file.id), v2.toString());

    // The old object is queued as blob-only and removed by the worker; the file row survives.
    const queued = await env.db.deletion_queue.findMany({ where: { blob_only: true, status: "pending" } });
    assert.equal(queued.length, 1);
    assert.notEqual(queued[0]!.item_id, file.id);
    const oldKey = queued[0]!.storage_key!;
    const { runDeletionQueueTick } = await import("../../src/modules/trash/deletion-queue-service.js");
    await runDeletionQueueTick();
    await assert.rejects(env.storage.getObjectBuffer(oldKey));
    assert.ok(await env.db.files.findFirst({ where: { id: file.id, deleted_at: null } }));
    assert.equal(await storageUsed(env, user.id), 300n);
    assert.equal(await download(cookie, file.id), v2.toString());
  });

  test("a stale expectedVersion is refused before any bytes, and at completion", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const v1 = Buffer.from("one");
    const file = await uploadWithChecksum(cookie, "cas.txt", v1);

    const early = await initReplace(cookie, file.id, Buffer.from("x"), "0".repeat(32));
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error.code, "CONTENT_CONFLICT");

    // Two clients both based on v1: the first wins, the second's completion is refused and refunded.
    const a = await initReplace(cookie, file.id, Buffer.from("A"), file.version);
    const b = await initReplace(cookie, file.id, Buffer.from("BB"), file.version);
    const sa = a.json().uploadSessionId;
    const sb = b.json().uploadSessionId;
    await putPart(env, cookie, sa, 0, Buffer.from("A"));
    await putPart(env, cookie, sb, 0, Buffer.from("BB"));
    assert.equal((await api(env, cookie).post(`/files/upload-sessions/${sa}/complete`)).statusCode, 200);
    const lost = await api(env, cookie).post(`/files/upload-sessions/${sb}/complete`);
    assert.equal(lost.statusCode, 409);
    assert.equal(lost.json().error.code, "CONTENT_CONFLICT");

    assert.equal(await download(cookie, file.id), "A");
    assert.equal(await storageUsed(env, user.id), 1n);
  });

  test("a file trashed mid-upload is a conflict, not resurrected", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const file = await uploadWithChecksum(cookie, "t.txt", Buffer.from("abc"));
    const init = await initReplace(cookie, file.id, Buffer.from("new"));
    const sid = init.json().uploadSessionId;
    await putPart(env, cookie, sid, 0, Buffer.from("new"));
    await api(env, cookie).delete(`/files/${file.id}`);

    const res = await api(env, cookie).post(`/files/upload-sessions/${sid}/complete`);
    assert.equal(res.statusCode, 409);
    assert.equal(await storageUsed(env, user.id), 3n);
  });

  test("an editor replacing an owner's file: editor refunded, owner charged the difference", async () => {
    const owner = await createUserAndLogin(env);
    const editor = await createUserAndLogin(env);
    const folder = (await api(env, owner.cookie).post("/folders", { name: "Shared" })).json().folder.id;
    await api(env, owner.cookie).post(`/items/folder/${folder}/permissions`, { userId: editor.user.id, role: "editor" });
    const file = await uploadWithChecksum(owner.cookie, "s.bin", Buffer.alloc(100), folder);

    const { done } = await replace(editor.cookie, file.id, Buffer.alloc(250));
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(await storageUsed(env, owner.user.id), 250n);
    assert.equal(await storageUsed(env, editor.user.id), 0n);
    const row = await env.db.files.findUniqueOrThrow({ where: { id: file.id } });
    assert.equal(row.owner_id, owner.user.id);
  });

  test("the owner's quota still applies when an editor grows their file", async () => {
    const owner = await createUserAndLogin(env, { quotaBytes: 150n });
    const editor = await createUserAndLogin(env);
    const folder = (await api(env, owner.cookie).post("/folders", { name: "Tight" })).json().folder.id;
    await api(env, owner.cookie).post(`/items/folder/${folder}/permissions`, { userId: editor.user.id, role: "editor" });
    const file = await uploadWithChecksum(owner.cookie, "q.bin", Buffer.alloc(100), folder);

    const { done } = await replace(editor.cookie, file.id, Buffer.alloc(200));
    assert.equal(done.statusCode, 422);
    assert.equal(done.json().error.code, "QUOTA_EXCEEDED");
    assert.equal(await storageUsed(env, owner.user.id), 100n);
    assert.equal(await storageUsed(env, editor.user.id), 0n);
  });

  test("viewers can't replace, and replace events reach the change feed as `update`", async () => {
    const owner = await createUserAndLogin(env);
    const viewer = await createUserAndLogin(env);
    const folder = (await api(env, owner.cookie).post("/folders", { name: "Feed" })).json().folder.id;
    await api(env, owner.cookie).post(`/items/folder/${folder}/permissions`, { userId: viewer.user.id, role: "viewer" });
    const { file } = await uploadFile(env, owner.cookie, { name: "f.txt", data: Buffer.from("1"), folderId: folder });

    assert.equal((await initReplace(viewer.cookie, file.id, Buffer.from("2"))).statusCode, 404);

    const cursor = (await api(env, owner.cookie).get(`/sync/tree?root=${folder}`)).json().cursor;
    await replace(owner.cookie, file.id, Buffer.from("2"));
    const changes = (await api(env, owner.cookie).get(`/sync/changes?root=${folder}&cursor=${cursor}`)).json();
    assert.deepEqual(
      changes.events.map((e: { kind: string; checksum: string; version: string }) => [e.kind, e.checksum, e.version.length]),
      [["update", sha256(Buffer.from("2")), 32]],
    );
  });
});
