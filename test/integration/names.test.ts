import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { api, createUserAndLogin, setupTestEnv, uploadFile, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

async function sharedFolderWithEditor() {
  const owner = await createUserAndLogin(env);
  const editor = await createUserAndLogin(env);
  const folder = await api(env, owner.cookie).post("/folders", { name: `shared-${Math.random().toString(36).slice(2)}` });
  assert.equal(folder.statusCode, 201, folder.body);
  const folderId = folder.json().folder.id as string;
  const grant = await api(env, owner.cookie).post(`/items/folder/${folderId}/permissions`, {
    userId: editor.user.id,
    role: "editor",
  });
  assert.equal(grant.statusCode, 204, grant.body);
  return { owner, editor, folderId };
}

describe("folder-scoped sibling names (issue 5)", () => {
  test("an editor can't upload a file whose name the owner already uses in the shared folder", async () => {
    const { owner, editor, folderId } = await sharedFolderWithEditor();
    await uploadFile(env, owner.cookie, { name: "x.txt", data: Buffer.from("owner"), folderId });
    const init = await api(env, editor.cookie).post("/files", { targetName: "x.txt", totalParts: 1, targetFolderId: folderId });
    assert.equal(init.statusCode, 409, init.body);
    assert.equal(init.json().error.code, "NAME_COLLISION");
  });

  test("an editor can't create a folder whose name the owner already uses there", async () => {
    const { owner, editor, folderId } = await sharedFolderWithEditor();
    assert.equal((await api(env, owner.cookie).post("/folders", { name: "Sub", parentFolderId: folderId })).statusCode, 201);
    const res = await api(env, editor.cookie).post("/folders", { name: "Sub", parentFolderId: folderId });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, "NAME_COLLISION");
  });

  test("an editor can't rename their own file onto the owner's name in the same folder", async () => {
    const { owner, editor, folderId } = await sharedFolderWithEditor();
    await uploadFile(env, owner.cookie, { name: "taken.txt", data: Buffer.from("a"), folderId });
    const { file } = await uploadFile(env, editor.cookie, { name: "mine.txt", data: Buffer.from("b"), folderId });
    const res = await api(env, editor.cookie).patch(`/files/${file.id}`, { name: "taken.txt" });
    assert.equal(res.statusCode, 409, res.body);
  });

  test("root folders stay per-user: two users can both have a root folder named Docs", async () => {
    const a = await createUserAndLogin(env);
    const b = await createUserAndLogin(env);
    assert.equal((await api(env, a.cookie).post("/folders", { name: "Docs" })).statusCode, 201);
    assert.equal((await api(env, b.cookie).post("/folders", { name: "Docs" })).statusCode, 201);
    assert.equal((await api(env, a.cookie).post("/folders", { name: "Docs" })).statusCode, 409);
  });

  test("trashed items don't block reusing a name", async () => {
    const { owner, folderId } = await sharedFolderWithEditor();
    const { file } = await uploadFile(env, owner.cookie, { name: "again.txt", data: Buffer.from("1"), folderId });
    assert.equal((await api(env, owner.cookie).delete(`/files/${file.id}`)).statusCode, 204);
    await uploadFile(env, owner.cookie, { name: "again.txt", data: Buffer.from("2"), folderId });
  });
});

describe("migration 0023 renames pre-existing duplicates", () => {
  test("oldest keeps its name, later duplicates get an id suffix within 255 bytes", async () => {
    const adminUrl = `postgres://dbase_test:dbase_test@localhost:${process.env.TEST_DB_PORT ?? "54329"}/postgres`;
    const dbName = `${env.dbName}_m23`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();
    const url = adminUrl.replace(/\/postgres$/, `/${dbName}`);
    const { applyMigrations } = await import("../../scripts/migrate.js");
    await applyMigrations(url, () => {}, { stopAfter: "0022_preallocate_user_quotas.sql" });

    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      // "é" is 2 bytes in UTF-8: 125 of them + ".txt" = 254 bytes, just under the limit, so the
      // " (xxxxxxxx)" suffix forces a character-boundary truncation.
      const fitted = "é".repeat(125) + ".txt";
      const owner = (
        await c.query(
          `insert into users (email, password_hash, display_name, email_verified, storage_quota_bytes)
           values ('o@t', 'x', 'o', true, 0) returning id`,
        )
      ).rows[0].id;
      const editor = (
        await c.query(
          `insert into users (email, password_hash, display_name, email_verified, storage_quota_bytes)
           values ('e@t', 'x', 'e', true, 0) returning id`,
        )
      ).rows[0].id;
      const folder = (
        await c.query(
          `with n as (select gen_random_uuid() as id)
           insert into folders (id, name, owner_id, materialized_path)
           select id, 'F', $1, '/' || id || '/' from n returning id`,
          [owner],
        )
      ).rows[0].id;
      const insertFile = (ownerId: string, name: string, createdAt: string) =>
        c.query(
          `insert into files (owner_id, folder_id, name, size_bytes, mime_type, storage_key, upload_status, created_at)
           values ($1, $2, $3, 1, 'text/plain', gen_random_uuid()::text, 'complete', $4) returning id`,
          [ownerId, folder, name, createdAt],
        );
      const keep = (await insertFile(owner, "x.txt", "2020-01-01")).rows[0].id;
      const dup = (await insertFile(editor, "x.txt", "2021-01-01")).rows[0].id;
      const longKeep = (await insertFile(owner, fitted, "2020-01-01")).rows[0].id;
      const longDup = (await insertFile(editor, fitted, "2021-01-01")).rows[0].id;

      await applyMigrations(url, () => {});

      const names = new Map(
        (await c.query(`select id, name from files`)).rows.map((r: { id: string; name: string }) => [r.id, r.name]),
      );
      assert.equal(names.get(keep), "x.txt");
      assert.equal(names.get(dup), `x.txt (${dup.slice(0, 8)})`);
      assert.equal(names.get(longKeep), fitted);
      const renamedLong = names.get(longDup)!;
      assert.ok(renamedLong.endsWith(` (${longDup.slice(0, 8)})`), renamedLong);
      assert.ok(Buffer.byteLength(renamedLong, "utf8") <= 255, `${Buffer.byteLength(renamedLong)} bytes`);

      // And the new index now enforces it.
      await assert.rejects(insertFile(editor, "x.txt", "2022-01-01"), /uq_files_sibling_name/);
    } finally {
      await c.end();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${dbName} with (force)`);
      await cleanup.end();
    }
  });
});
