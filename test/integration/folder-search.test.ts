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

type Result = { name: string; type: string; location: { id: string; name: string }[] };

async function searchWithin(cookie: string, q: string, within: string) {
  const res = await api(env, cookie).get(`/search?q=${encodeURIComponent(q)}&within=${within}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { items: Result[]; truncated: boolean };
}
const summarize = (items: Result[]) =>
  items.map((i) => `${i.type}:${[...i.location.map((l) => l.name), i.name].join("/")}`).sort();

/** Projects/{Alpha/{report-q1.txt, Deep/report-deep.txt}, Beta/notes.txt}, root report-root.txt */
async function workspace() {
  const user = await createUserAndLogin(env);
  const { folders } = (
    await api(env, user.cookie).post("/folders/tree", {
      paths: ["Projects", "Projects/Alpha", "Projects/Alpha/Deep", "Projects/Beta"],
    })
  ).json() as { folders: Record<string, string> };
  await uploadFile(env, user.cookie, { name: "report-q1.txt", data: Buffer.from("1"), folderId: folders["Projects/Alpha"] });
  await uploadFile(env, user.cookie, { name: "report-deep.txt", data: Buffer.from("2"), folderId: folders["Projects/Alpha/Deep"] });
  await uploadFile(env, user.cookie, { name: "notes.txt", data: Buffer.from("3"), folderId: folders["Projects/Beta"] });
  await uploadFile(env, user.cookie, { name: "report-root.txt", data: Buffer.from("4") });
  return { ...user, folders };
}

describe("search within a folder subtree (My Files search box)", () => {
  test("from My Files, nested matches at any depth are found, with their location", async () => {
    const { cookie } = await workspace();
    const { items } = await searchWithin(cookie, "report", "mine");
    assert.deepEqual(summarize(items), [
      "file:Projects/Alpha/Deep/report-deep.txt",
      "file:Projects/Alpha/report-q1.txt",
      "file:report-root.txt",
    ]);
  });

  test("from a folder, only its subtree is searched and locations are relative to it", async () => {
    const { cookie, folders } = await workspace();
    const { items } = await searchWithin(cookie, "re", folders["Projects/Alpha"]!);
    assert.deepEqual(summarize(items), ["file:Deep/report-deep.txt", "file:report-q1.txt"]);
    // Sibling subtree (Beta) isn't included.
    assert.deepEqual((await searchWithin(cookie, "notes", folders["Projects/Alpha"]!)).items, []);
  });

  test("folders match too, but never the folder being searched itself", async () => {
    const { cookie, folders } = await workspace();
    assert.deepEqual(summarize((await searchWithin(cookie, "deep", folders["Projects"]!)).items), [
      "file:Alpha/Deep/report-deep.txt",
      "folder:Alpha/Deep",
    ]);
    assert.deepEqual((await searchWithin(cookie, "Alpha", folders["Projects/Alpha"]!)).items, []);
  });

  test("trashed items (and everything in a trashed folder) are excluded", async () => {
    const { cookie, folders } = await workspace();
    assert.equal((await api(env, cookie).delete(`/folders/${folders["Projects/Alpha/Deep"]}`)).statusCode, 204);
    assert.deepEqual(summarize((await searchWithin(cookie, "report", "mine")).items), [
      "file:Projects/Alpha/report-q1.txt",
      "file:report-root.txt",
    ]);
  });

  test("% and _ in the search term are matched literally", async () => {
    const { cookie } = await createUserAndLogin(env);
    await uploadFile(env, cookie, { name: "100%_done.txt", data: Buffer.from("x") });
    await uploadFile(env, cookie, { name: "1000 done.txt", data: Buffer.from("y") });
    assert.deepEqual(summarize((await searchWithin(cookie, "100%_", "mine")).items), ["file:100%_done.txt"]);
  });

  test("My Files covers the user's own tree only, including others' files inside it", async () => {
    const owner = await workspace();
    const editor = await createUserAndLogin(env);
    await api(env, owner.cookie).post(`/items/folder/${owner.folders["Projects"]}/permissions`, {
      userId: editor.user.id,
      role: "editor",
    });
    await uploadFile(env, editor.cookie, { name: "report-by-editor.txt", data: Buffer.from("e"), folderId: owner.folders["Projects/Beta"] });

    // The owner finds the editor's upload inside their own folder.
    assert.ok(summarize((await searchWithin(owner.cookie, "report", "mine")).items).includes("file:Projects/Beta/report-by-editor.txt"));
    // The editor's My Files doesn't contain the owner's tree (it's under "Shared with me").
    assert.deepEqual((await searchWithin(editor.cookie, "report", "mine")).items, []);
    // But searching inside the shared folder works for them.
    assert.equal((await searchWithin(editor.cookie, "report", owner.folders["Projects"]!)).items.length, 3);
  });

  test("searching inside a folder you can't access is a 404", async () => {
    const { folders } = await workspace();
    const stranger = await createUserAndLogin(env);
    const res = await api(env, stranger.cookie).get(`/search?q=report&within=${folders["Projects"]}`);
    assert.equal(res.statusCode, 404);
  });

  test("the global search (no 'within') still behaves as before", async () => {
    const { cookie } = await workspace();
    const res = await api(env, cookie).get("/search?q=report");
    assert.equal(res.statusCode, 200);
    assert.equal((res.json().items as unknown[]).length, 3);
  });
});
