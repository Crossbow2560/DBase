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

async function tree(cookie: string, paths: string[], parentFolderId: string | null = null) {
  return api(env, cookie).post("/folders/tree", { parentFolderId, paths });
}

describe("POST /folders/tree", () => {
  test("creates a nested structure in one request, with owner permissions, and files upload into it", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const res = await tree(cookie, ["Photos", "Photos/2024", "Photos/2024/Summer", "Photos/Empty"]);
    assert.equal(res.statusCode, 201, res.body);
    const { folders, roots } = res.json() as { folders: Record<string, string>; roots: Record<string, string> };
    assert.deepEqual(roots, { Photos: "Photos" });
    assert.equal(Object.keys(folders).length, 4);

    const summer = await env.db.folders.findUniqueOrThrow({ where: { id: folders["Photos/2024/Summer"]! } });
    assert.equal(summer.parent_folder_id, folders["Photos/2024"]);
    assert.equal(
      summer.materialized_path,
      `/${folders["Photos"]}/${folders["Photos/2024"]}/${folders["Photos/2024/Summer"]}/`,
    );
    const owners = await env.db.permissions.count({
      where: { item_id: { in: Object.values(folders) }, role: "owner", user_id: user.id },
    });
    assert.equal(owners, 4);

    await uploadFile(env, cookie, { name: "beach.jpg", data: Buffer.from("sand"), folderId: folders["Photos/2024/Summer"] });
    const listing = await api(env, cookie).get(`/folders/${folders["Photos/2024/Summer"]}/contents`);
    assert.deepEqual(
      (listing.json().items as { name: string }[]).map((i) => i.name),
      ["beach.jpg"],
    );
    // Breadcrumbs work through the new structure.
    assert.deepEqual(
      (listing.json().ancestors as { name: string }[]).map((a) => a.name),
      ["Photos", "2024"],
    );
  });

  test("implied ancestors are created even if only the deepest path is sent", async () => {
    const { cookie } = await createUserAndLogin(env);
    const res = await tree(cookie, ["A/B/C"]);
    assert.equal(res.statusCode, 201, res.body);
    const c = await env.db.folders.findUniqueOrThrow({ where: { id: res.json().folders["A/B/C"] } });
    const b = await env.db.folders.findUniqueOrThrow({ where: { id: c.parent_folder_id! } });
    assert.equal(b.name, "B");
  });

  test("a top-level name that's taken becomes 'Name (2)', then 'Name (3)' — never merged", async () => {
    const { cookie } = await createUserAndLogin(env);
    assert.equal((await api(env, cookie).post("/folders", { name: "Docs" })).statusCode, 201);
    const second = await tree(cookie, ["Docs", "Docs/inner"]);
    assert.deepEqual(second.json().roots, { Docs: "Docs (2)" });
    const third = await tree(cookie, ["Docs"]);
    assert.deepEqual(third.json().roots, { Docs: "Docs (3)" });
    const root = await api(env, cookie).get("/folders/contents");
    const names = (root.json().items as { name: string; type: string }[]).filter((i) => i.type === "folder").map((i) => i.name);
    assert.deepEqual(names.sort(), ["Docs", "Docs (2)", "Docs (3)"]);
  });

  test("works inside a shared folder for an editor, and is refused for a viewer", async () => {
    const owner = await createUserAndLogin(env);
    const editor = await createUserAndLogin(env);
    const viewer = await createUserAndLogin(env);
    const shared = (await api(env, owner.cookie).post("/folders", { name: "Team" })).json().folder.id as string;
    await api(env, owner.cookie).post(`/items/folder/${shared}/permissions`, { userId: editor.user.id, role: "editor" });
    await api(env, owner.cookie).post(`/items/folder/${shared}/permissions`, { userId: viewer.user.id, role: "viewer" });

    const ok = await tree(editor.cookie, ["Drop", "Drop/sub"], shared);
    assert.equal(ok.statusCode, 201, ok.body);
    const created = await env.db.folders.findUniqueOrThrow({ where: { id: ok.json().folders["Drop"] } });
    assert.equal(created.parent_folder_id, shared);

    assert.equal((await tree(viewer.cookie, ["Nope"], shared)).statusCode, 404);
  });

  test("rejects '..' segments and over-long names without creating anything", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    assert.equal((await tree(cookie, ["ok", "ok/../escape"])).statusCode, 400);
    assert.equal((await tree(cookie, ["fine", `fine/${"x".repeat(256)}`])).statusCode, 400);
    assert.equal(await env.db.folders.count({ where: { owner_id: user.id } }), 0);
  });

  test("a path past the 4096-byte limit is refused", async () => {
    const { cookie } = await createUserAndLogin(env);
    const deep = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(250, "d")).join("/");
    const res = await tree(cookie, [deep]);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, "PATH_TOO_LONG");
  });

  test("names are NFC-normalized; the response is keyed by the client's own strings", async () => {
    const { cookie } = await createUserAndLogin(env);
    const decomposed = "Café"; // "Café" as e + combining accent
    const res = await tree(cookie, [decomposed, `${decomposed}/menu`]);
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().folders[decomposed];
    assert.ok(id);
    assert.equal((await env.db.folders.findUniqueOrThrow({ where: { id } })).name, "Café");
  });
});
