// Database-enforced invariants and lifecycle flows that had no automated coverage: quota and
// system-limit pre-allocation, last-admin protection, trash restore/purge, and share-link scope.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { api, createUserAndLogin, putPart, setupTestEnv, storageUsed, uploadFile, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

describe("storage quotas", () => {
  test("an upload past the per-user quota is refused at the part that would exceed it", async () => {
    const { user, cookie } = await createUserAndLogin(env, { quotaBytes: 100n });
    await uploadFile(env, cookie, { name: "fits.bin", data: Buffer.alloc(60) });
    const init = await api(env, cookie).post("/files", { targetName: "too-big.bin", totalParts: 1 });
    const sid = init.json().uploadSessionId as string;
    const res = await putPart(env, cookie, sid, 0, Buffer.alloc(41));
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "QUOTA_EXCEEDED");
    assert.equal(await storageUsed(env, user.id), 60n);
  });

  test("the system limit can't be set below what's already allocated to verified users", async () => {
    const admin = await createUserAndLogin(env, { role: "admin" });
    const allocated = await env.db.users.aggregate({ where: { email_verified: true }, _sum: { storage_quota_bytes: true } });
    const below = Number((allocated._sum.storage_quota_bytes ?? 0n) - 1n);
    const res = await api(env, admin.cookie).patch("/admin/system-storage", { totalStorageLimitBytes: below });
    assert.equal(res.statusCode, 409, res.body);
    const settings = await env.db.system_settings.findUniqueOrThrow({ where: { id: true } });
    assert.ok(settings.total_storage_limit_bytes > BigInt(below));
  });

  test("an admin can't hand out more quota than the system has unallocated", async () => {
    const admin = await createUserAndLogin(env, { role: "admin" });
    const target = await createUserAndLogin(env);
    const settings = await env.db.system_settings.findUniqueOrThrow({ where: { id: true } });
    const res = await api(env, admin.cookie).patch(`/admin/users/${target.user.id}/quota`, {
      quotaBytes: Number(settings.total_storage_limit_bytes) + 1,
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, "SYSTEM_STORAGE_ALLOCATION_EXCEEDED");
  });
});

describe("last active admin", () => {
  test("the only active admin can't demote, deactivate or delete themselves", async () => {
    // Deactivate every other admin this file created so this one is genuinely the last.
    const admin = await createUserAndLogin(env, { role: "admin" });
    await env.db.users.updateMany({ where: { role: "admin", id: { not: admin.user.id } }, data: { role: "user" } });

    const demote = await api(env, admin.cookie).patch(`/admin/users/${admin.user.id}/role`, { role: "user" });
    assert.equal(demote.statusCode, 409, demote.body);
    assert.equal(demote.json().error.code, "LAST_ADMIN");

    const deactivate = await api(env, admin.cookie).post(`/admin/users/${admin.user.id}/deactivate`);
    assert.equal(deactivate.statusCode, 409, deactivate.body);

    const del = await api(env, admin.cookie).delete(`/admin/users/${admin.user.id}`);
    assert.ok(del.statusCode === 409, `${del.statusCode} ${del.body}`);

    const still = await env.db.users.findUniqueOrThrow({ where: { id: admin.user.id } });
    assert.equal(still.role, "admin");
    assert.equal(still.is_active, true);
  });
});

describe("trash", () => {
  test("trash → restore puts a file back where it was", async () => {
    const { cookie } = await createUserAndLogin(env);
    const { file } = await uploadFile(env, cookie, { name: "restore-me.txt", data: Buffer.from("r") });
    assert.equal((await api(env, cookie).delete(`/files/${file.id}`)).statusCode, 204);
    const trash = await api(env, cookie).get("/trash");
    assert.ok((trash.json().items as { id: string }[]).some((i) => i.id === file.id));
    assert.equal((await api(env, cookie).post(`/trash/file/${file.id}/restore`)).statusCode, 204);
    const root = await api(env, cookie).get("/folders/contents");
    assert.ok((root.json().items as { id: string }[]).some((i) => i.id === file.id));
  });

  test("delete forever removes the row and the object, and refunds the quota", async () => {
    const { runDeletionQueueTick } = await import("../../src/modules/trash/deletion-queue-service.js");
    const { user, cookie } = await createUserAndLogin(env);
    const { file } = await uploadFile(env, cookie, { name: "purge-me.bin", data: Buffer.alloc(777, 3) });
    const storageKey = (await env.db.files.findUniqueOrThrow({ where: { id: file.id } })).storage_key;
    assert.equal(await storageUsed(env, user.id), 777n);

    assert.equal((await api(env, cookie).delete(`/files/${file.id}`)).statusCode, 204);
    // Can't purge something that isn't trashed; can once it is.
    assert.equal((await api(env, cookie).delete(`/trash/file/${file.id}`)).statusCode, 204);
    // Restore is refused while the purge is in flight.
    assert.equal((await api(env, cookie).post(`/trash/file/${file.id}/restore`)).json().error?.code, "PURGE_IN_FLIGHT");

    await runDeletionQueueTick();

    assert.equal(await env.db.files.findUnique({ where: { id: file.id } }), null);
    assert.equal(await storageUsed(env, user.id), 0n);
    await assert.rejects(env.storage.getObjectBuffer(storageKey));
  });

  test("purging a live (untrashed) file is refused", async () => {
    const { cookie } = await createUserAndLogin(env);
    const { file } = await uploadFile(env, cookie, { name: "live.txt", data: Buffer.from("l") });
    const res = await api(env, cookie).delete(`/trash/file/${file.id}`);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "NOT_IN_TRASH");
  });
});

describe("share-link scope", () => {
  test("a folder link can't be used to reach anything outside the shared subtree", async () => {
    const { cookie } = await createUserAndLogin(env);
    const shared = (await api(env, cookie).post("/folders", { name: "Shared" })).json().folder.id as string;
    const inner = (await api(env, cookie).post("/folders", { name: "Inner", parentFolderId: shared })).json().folder.id as string;
    const outside = (await api(env, cookie).post("/folders", { name: "Outside" })).json().folder.id as string;
    const { file: innerFile } = await uploadFile(env, cookie, { name: "in.txt", data: Buffer.from("i"), folderId: inner });
    const { file: outsideFile } = await uploadFile(env, cookie, { name: "out.txt", data: Buffer.from("o"), folderId: outside });
    const token = (await api(env, cookie).post(`/items/folder/${shared}/share-links`, { role: "viewer" })).json().token;

    const get = (path: string) => env.app.inject({ method: "GET", url: `/api/v1/public/share-links/${token}${path}` });
    assert.equal((await get(`?folderId=${inner}`)).statusCode, 200);
    assert.equal((await get(`/files/${innerFile.id}/download`)).statusCode, 200);

    assert.equal((await get(`?folderId=${outside}`)).statusCode, 404);
    assert.equal((await get(`/files/${outsideFile.id}/download`)).statusCode, 404);
    assert.equal((await get(`/folders/${outside}/download-zip`)).statusCode, 404);
  });

  test("a link stops working once its creator is deactivated or it expires", async () => {
    const admin = await createUserAndLogin(env, { role: "admin" });
    const owner = await createUserAndLogin(env);
    const folder = (await api(env, owner.cookie).post("/folders", { name: "Temp" })).json().folder.id as string;
    const token = (await api(env, owner.cookie).post(`/items/folder/${folder}/share-links`, { role: "viewer" })).json().token;
    const expired = (
      await api(env, owner.cookie).post(`/items/folder/${folder}/share-links`, {
        role: "viewer",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
    ).json().token;

    const get = (t: string) => env.app.inject({ method: "GET", url: `/api/v1/public/share-links/${t}` });
    assert.equal((await get(token)).statusCode, 200);
    assert.equal((await get(expired)).statusCode, 404);

    await api(env, admin.cookie).post(`/admin/users/${owner.user.id}/deactivate`);
    assert.equal((await get(token)).statusCode, 404);
  });
});
