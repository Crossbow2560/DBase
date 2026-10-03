import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { api, createUserAndLogin, setupTestEnv, uploadFile, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

async function mkdir(cookie: string, name: string, parentFolderId?: string) {
  const res = await api(env, cookie).post("/folders", { name, parentFolderId: parentFolderId ?? null });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().folder.id as string;
}

async function grant(cookie: string, type: "file" | "folder", id: string, userId: string, role: "viewer" | "editor") {
  const res = await api(env, cookie).post(`/items/${type}/${id}/permissions`, { userId, role });
  assert.equal(res.statusCode, 204, res.body);
}

/** owner/A/B/C with a file in C. */
async function tree() {
  const owner = await createUserAndLogin(env);
  const a = await mkdir(owner.cookie, "A");
  const b = await mkdir(owner.cookie, "B", a);
  const c = await mkdir(owner.cookie, "C", b);
  const { file } = await uploadFile(env, owner.cookie, { name: "deep.txt", data: Buffer.from("deep"), folderId: c });
  return { owner, a, b, c, fileId: file.id };
}

describe("effective permission resolution (issue 12)", () => {
  test("no grant → the item is invisible (404, not 403)", async () => {
    const { c, fileId } = await tree();
    const stranger = await createUserAndLogin(env);
    assert.equal((await api(env, stranger.cookie).get(`/folders/${c}/contents`)).statusCode, 404);
    assert.equal((await api(env, stranger.cookie).get(`/files/${fileId}/download`)).statusCode, 404);
  });

  test("a direct grant on a file gives exactly that role", async () => {
    const { owner, fileId } = await tree();
    const viewer = await createUserAndLogin(env);
    await grant(owner.cookie, "file", fileId, viewer.user.id, "viewer");
    assert.equal((await api(env, viewer.cookie).get(`/files/${fileId}/download`)).statusCode, 200);
    // viewer can't rename
    assert.equal((await api(env, viewer.cookie).patch(`/files/${fileId}`, { name: "x.txt" })).statusCode, 404);
  });

  test("a grant three levels up is inherited by the folders and file below it", async () => {
    const { owner, a, c, fileId } = await tree();
    const editor = await createUserAndLogin(env);
    await grant(owner.cookie, "folder", a, editor.user.id, "editor");
    assert.equal((await api(env, editor.cookie).get(`/folders/${c}/contents`)).statusCode, 200);
    assert.equal((await api(env, editor.cookie).get(`/files/${fileId}/download`)).statusCode, 200);
    assert.equal((await api(env, editor.cookie).patch(`/files/${fileId}`, { name: "renamed.txt" })).statusCode, 200);
  });

  test("the highest of several applicable grants wins", async () => {
    const { owner, a, c, fileId } = await tree();
    const user = await createUserAndLogin(env);
    await grant(owner.cookie, "folder", a, user.user.id, "viewer");
    await grant(owner.cookie, "folder", c, user.user.id, "editor");
    assert.equal((await api(env, user.cookie).patch(`/files/${fileId}`, { name: "promoted.txt" })).statusCode, 200);
  });

  test("a grant on a sibling subtree doesn't leak across", async () => {
    const { owner, a, c } = await tree();
    const other = await mkdir(owner.cookie, "Other", a);
    const user = await createUserAndLogin(env);
    await grant(owner.cookie, "folder", other, user.user.id, "editor");
    assert.equal((await api(env, user.cookie).get(`/folders/${c}/contents`)).statusCode, 404);
  });

  test("grants made by a deactivated user stop working, and resume on reactivation", async () => {
    const { owner, a, fileId } = await tree();
    const admin = await createUserAndLogin(env, { role: "admin" });
    const resharer = await createUserAndLogin(env);
    const viewer = await createUserAndLogin(env);
    await grant(owner.cookie, "folder", a, resharer.user.id, "editor");
    await grant(resharer.cookie, "file", fileId, viewer.user.id, "viewer");
    assert.equal((await api(env, viewer.cookie).get(`/files/${fileId}/download`)).statusCode, 200);

    assert.equal((await api(env, admin.cookie).post(`/admin/users/${resharer.user.id}/deactivate`)).statusCode, 204);
    assert.equal((await api(env, viewer.cookie).get(`/files/${fileId}/download`)).statusCode, 404);

    assert.equal((await api(env, admin.cookie).post(`/admin/users/${resharer.user.id}/reactivate`)).statusCode, 204);
    assert.equal((await api(env, viewer.cookie).get(`/files/${fileId}/download`)).statusCode, 200);
  });

  test("admins bypass item permissions", async () => {
    const { c, fileId } = await tree();
    const admin = await createUserAndLogin(env, { role: "admin" });
    assert.equal((await api(env, admin.cookie).get(`/folders/${c}/contents`)).statusCode, 200);
    assert.equal((await api(env, admin.cookie).get(`/files/${fileId}/download`)).statusCode, 200);
  });

  test("resolveEffectiveRole reports the role directly", async () => {
    const { resolveEffectiveRole } = await import("../../src/modules/access/permission-check.js");
    const { owner, a, b, fileId } = await tree();
    const user = await createUserAndLogin(env);
    assert.equal(await resolveEffectiveRole(user.user.id, "file", fileId), null);
    await grant(owner.cookie, "folder", b, user.user.id, "viewer");
    assert.equal(await resolveEffectiveRole(user.user.id, "file", fileId), "viewer");
    assert.equal(await resolveEffectiveRole(user.user.id, "folder", a), null);
    assert.equal(await resolveEffectiveRole(owner.user.id, "file", fileId), "owner");
    assert.equal(await resolveEffectiveRole(user.user.id, "file", "00000000-0000-0000-0000-000000000000"), null);
  });
});

describe("search and shared-with-me match actual access (issue 11)", () => {
  async function search(cookie: string, q: string) {
    const res = await api(env, cookie).get(`/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.statusCode, 200, res.body);
    return (res.json().items as { name: string; type: string }[]).map((i) => `${i.type}:${i.name}`).sort();
  }

  test("search finds files and folders nested under a shared folder", async () => {
    const owner = await createUserAndLogin(env);
    const top = await mkdir(owner.cookie, "Projects");
    const mid = await mkdir(owner.cookie, "Zephyr-mid", top);
    await uploadFile(env, owner.cookie, { name: "zephyr-plan.txt", data: Buffer.from("p"), folderId: mid });
    await uploadFile(env, owner.cookie, { name: "zephyr-unshared.txt", data: Buffer.from("u") });
    const user = await createUserAndLogin(env);

    assert.deepEqual(await search(user.cookie, "zephyr"), []);
    await grant(owner.cookie, "folder", top, user.user.id, "viewer");
    assert.deepEqual(await search(user.cookie, "zephyr"), ["file:zephyr-plan.txt", "folder:Zephyr-mid"]);
  });

  test("items shared by a deactivated user drop out of search and shared-with-me", async () => {
    const owner = await createUserAndLogin(env);
    const admin = await createUserAndLogin(env, { role: "admin" });
    const folder = await mkdir(owner.cookie, "Quokka");
    await uploadFile(env, owner.cookie, { name: "quokka.txt", data: Buffer.from("q"), folderId: folder });
    const user = await createUserAndLogin(env);
    await grant(owner.cookie, "folder", folder, user.user.id, "viewer");

    assert.deepEqual(await search(user.cookie, "quokka"), ["file:quokka.txt", "folder:Quokka"]);
    const shared = await api(env, user.cookie).get("/shared-with-me");
    assert.deepEqual((shared.json().items as { name: string }[]).map((i) => i.name), ["Quokka"]);

    await api(env, admin.cookie).post(`/admin/users/${owner.user.id}/deactivate`);
    assert.deepEqual(await search(user.cookie, "quokka"), []);
    assert.deepEqual((await api(env, user.cookie).get("/shared-with-me")).json().items, []);
  });

  test("search never surfaces a sibling of the shared folder", async () => {
    const owner = await createUserAndLogin(env);
    const shared = await mkdir(owner.cookie, "Wombat-shared");
    await mkdir(owner.cookie, "Wombat-private");
    const user = await createUserAndLogin(env);
    await grant(owner.cookie, "folder", shared, user.user.id, "viewer");
    assert.deepEqual(await search(user.cookie, "wombat"), ["folder:Wombat-shared"]);
  });
});
