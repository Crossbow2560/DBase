import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { api, createUserAndLogin, setupTestEnv, uploadFile, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

type Recent = { name: string; location: { name: string }[]; updatedAt: string };
const recent = async (cookie: string, limit?: number) => {
  const res = await api(env, cookie).get(`/files/recent${limit ? `?limit=${limit}` : ""}`);
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().items as Recent[]).map((i) => [...i.location.map((l) => l.name), i.name].join("/"));
};

test("recent files include files nested at any depth, newest first, with locations", async () => {
  const { cookie } = await createUserAndLogin(env);
  const { folders } = (
    await api(env, cookie).post("/folders/tree", { paths: ["Work", "Work/2026", "Work/2026/Q3"] })
  ).json() as { folders: Record<string, string> };
  await uploadFile(env, cookie, { name: "root.txt", data: Buffer.from("r") });
  await uploadFile(env, cookie, { name: "plan.txt", data: Buffer.from("p"), folderId: folders["Work"] });
  await uploadFile(env, cookie, { name: "deep.txt", data: Buffer.from("d"), folderId: folders["Work/2026/Q3"] });
  assert.deepEqual(await recent(cookie), ["Work/2026/Q3/deep.txt", "Work/plan.txt", "root.txt"]);
});

test("the default is 6 files and limit is honored", async () => {
  const { cookie } = await createUserAndLogin(env);
  const folder = (await api(env, cookie).post("/folders", { name: "Many" })).json().folder.id as string;
  for (let i = 0; i < 8; i++) await uploadFile(env, cookie, { name: `f${i}.txt`, data: Buffer.from(`${i}`), folderId: folder });
  assert.equal((await recent(cookie)).length, 6);
  assert.deepEqual(await recent(cookie, 2), ["Many/f7.txt", "Many/f6.txt"]);
  assert.equal((await api(env, cookie).get("/files/recent?limit=500")).statusCode, 400);
});

test("trashed files and other users' trees are excluded; uploads into your folders by others are included", async () => {
  const owner = await createUserAndLogin(env);
  const other = await createUserAndLogin(env);
  const shared = (await api(env, owner.cookie).post("/folders", { name: "Team" })).json().folder.id as string;
  await api(env, owner.cookie).post(`/items/folder/${shared}/permissions`, { userId: other.user.id, role: "editor" });

  const { file: gone } = await uploadFile(env, owner.cookie, { name: "gone.txt", data: Buffer.from("g"), folderId: shared });
  await api(env, owner.cookie).delete(`/files/${gone.id}`);
  await uploadFile(env, other.cookie, { name: "from-editor.txt", data: Buffer.from("e"), folderId: shared });
  await uploadFile(env, other.cookie, { name: "editors-own.txt", data: Buffer.from("o") });

  assert.deepEqual(await recent(owner.cookie), ["Team/from-editor.txt"]);
  // The editor's own My Files has only their root file; the owner's folder isn't part of it.
  assert.deepEqual(await recent(other.cookie), ["editors-own.txt"]);
});

test("a rename counts as a recent change", async () => {
  const { cookie } = await createUserAndLogin(env);
  const { file: a } = await uploadFile(env, cookie, { name: "a.txt", data: Buffer.from("a") });
  await uploadFile(env, cookie, { name: "b.txt", data: Buffer.from("b") });
  await api(env, cookie).patch(`/files/${a.id}`, { name: "a-renamed.txt" });
  assert.deepEqual(await recent(cookie), ["a-renamed.txt", "b.txt"]);
});
