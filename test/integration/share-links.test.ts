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

/** A folder with one file, shared by a password-protected link. */
async function protectedFolderLink(password = "open-sesame") {
  const { cookie } = await createUserAndLogin(env);
  const folder = await api(env, cookie).post("/folders", { name: `pub-${Math.random().toString(36).slice(2)}` });
  const folderId = folder.json().folder.id as string;
  const { file } = await uploadFile(env, cookie, { name: "doc.txt", data: Buffer.from("secret contents"), folderId });
  const link = await api(env, cookie).post(`/items/folder/${folderId}/share-links`, { role: "viewer", password });
  assert.equal(link.statusCode, 201, link.body);
  return { token: link.json().token as string, folderId, fileId: file.id, ownerCookie: cookie };
}

function publicGet(url: string, opts: { cookie?: string; ip?: string } = {}) {
  return env.app.inject({
    method: "GET",
    url: `/api/v1/public/share-links/${url}`,
    headers: { "x-forwarded-for": opts.ip ?? "203.0.113.200", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
  });
}

function unlock(token: string, password: string, ip = "203.0.113.200") {
  return env.app.inject({
    method: "POST",
    url: `/api/v1/public/share-links/${token}/unlock`,
    headers: { "x-forwarded-for": ip },
    payload: { password },
  });
}

function unlockCookieFrom(res: Awaited<ReturnType<typeof unlock>>) {
  const setCookie = res.headers["set-cookie"];
  const raw = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "";
  return { header: raw, pair: raw.split(";")[0]! };
}

describe("share-link passwords stay out of URLs (issue 6)", () => {
  test("a protected link answers PASSWORD_REQUIRED until unlocked", async () => {
    const { token } = await protectedFolderLink();
    const res = await publicGet(token);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "PASSWORD_REQUIRED");
  });

  test("?password= in the URL is no longer accepted", async () => {
    const { token } = await protectedFolderLink("open-sesame");
    const res = await publicGet(`${token}?password=open-sesame`);
    assert.equal(res.statusCode, 401);
  });

  test("unlock sets an httpOnly cookie scoped to the link's API path, which grants access", async () => {
    const { token, folderId, fileId } = await protectedFolderLink();
    const wrong = await unlock(token, "nope");
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().error.code, "INVALID_PASSWORD");

    const ok = await unlock(token, "open-sesame");
    assert.equal(ok.statusCode, 204, ok.body);
    const { header, pair } = unlockCookieFrom(ok);
    assert.match(header, /HttpOnly/i);
    assert.match(header, new RegExp(`Path=/api/v1/public/share-links/${token}`));

    const contents = await publicGet(token, { cookie: pair });
    assert.equal(contents.statusCode, 200, contents.body);
    assert.ok((contents.json().items as { name: string }[]).some((i) => i.name === "doc.txt"));
    assert.equal((await publicGet(`${token}/files/${fileId}/download`, { cookie: pair })).statusCode, 200);
    const zip = await publicGet(`${token}/folders/${folderId}/download-zip`, { cookie: pair });
    assert.equal(zip.statusCode, 200);
    assert.equal(zip.headers["content-type"], "application/zip");
  });

  test("a tampered or cross-link cookie is rejected", async () => {
    const a = await protectedFolderLink();
    const b = await protectedFolderLink();
    const { pair } = unlockCookieFrom(await unlock(a.token, "open-sesame"));

    // Cookie for link A presented to link B.
    assert.equal((await publicGet(b.token, { cookie: pair })).statusCode, 401);

    // Same cookie with its value edited (signature no longer matches).
    const [name, value] = pair.split("=") as [string, string];
    const tampered = `${name}=${decodeURIComponent(value).replace(/\.\d+\./, ".9999999999999.")}`;
    assert.equal((await publicGet(a.token, { cookie: tampered })).statusCode, 401);
  });

  test("unprotected links need no unlock", async () => {
    const { cookie } = await createUserAndLogin(env);
    const folder = await api(env, cookie).post("/folders", { name: "open" });
    const link = await api(env, cookie).post(`/items/folder/${folder.json().folder.id}/share-links`, { role: "viewer" });
    assert.equal((await publicGet(link.json().token)).statusCode, 200);
  });

  test("request logs mask the share token and drop query strings", async () => {
    const { redactUrlForLog } = await import("../../src/app.js");
    assert.equal(
      redactUrlForLog("/api/v1/public/share-links/AbC_123-xyz/files/f1/download?password=hunter2"),
      "/api/v1/public/share-links/[redacted]/files/f1/download",
    );
    assert.equal(redactUrlForLog("/api/v1/folders/contents?x=1"), "/api/v1/folders/contents");
  });
});

describe("password guessing can't lock other visitors out (issue 7)", () => {
  test("ten wrong guesses from one IP block that IP only", async () => {
    const { token } = await protectedFolderLink();
    for (let i = 0; i < 10; i++) {
      assert.equal((await unlock(token, `guess-${i}`, "203.0.113.66")).statusCode, 401);
    }
    const attacker = await unlock(token, "open-sesame", "203.0.113.66");
    assert.equal(attacker.statusCode, 429);

    const visitor = await unlock(token, "open-sesame", "203.0.113.77");
    assert.equal(visitor.statusCode, 204, visitor.body);
  });

  test("a correct unlock is never refused because of other people's failures", async () => {
    const { token } = await protectedFolderLink();
    for (let ip = 1; ip <= 12; ip++) {
      await unlock(token, "wrong", `198.18.0.${ip}`);
    }
    assert.equal((await unlock(token, "open-sesame", "198.18.1.1")).statusCode, 204);
  });
});

describe("share-link tokens are stored hashed (issue 8)", () => {
  test("only the SHA-256 of the token is stored, and listing never returns tokens", async () => {
    const { hashToken } = await import("../../src/lib/tokens.js");
    const { cookie } = await createUserAndLogin(env);
    const folder = await api(env, cookie).post("/folders", { name: "hashed" });
    const folderId = folder.json().folder.id as string;
    const created = await api(env, cookie).post(`/items/folder/${folderId}/share-links`, { role: "viewer" });
    const { token, id } = created.json() as { token: string; id: string };

    const row = await env.db.share_links.findUniqueOrThrow({ where: { id } });
    assert.equal(row.token_hash, hashToken(token));
    assert.notEqual(row.token_hash, token);

    const list = await api(env, cookie).get(`/items/folder/${folderId}/share-links`);
    assert.equal(list.statusCode, 200);
    const links = list.json().links as Record<string, unknown>[];
    assert.equal(links.length, 1);
    assert.ok(!("token" in links[0]!) && !("token_hash" in links[0]!), JSON.stringify(links[0]));
    assert.ok(!list.body.includes(token));

    // The raw token still opens the link.
    assert.equal((await publicGet(token)).statusCode, 200);
    // Presenting the stored hash as if it were a token does not.
    assert.equal((await publicGet(row.token_hash)).statusCode, 404);
  });

  test("migration 0024 hashes existing plaintext tokens so old links keep working", async () => {
    const { Client } = await import("pg");
    const { hashToken, generateToken } = await import("../../src/lib/tokens.js");
    const adminUrl = `postgres://dbase_test:dbase_test@localhost:${process.env.TEST_DB_PORT ?? "54329"}/postgres`;
    const dbName = `${env.dbName}_m24`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();
    const url = adminUrl.replace(/\/postgres$/, `/${dbName}`);
    const { applyMigrations } = await import("../../scripts/migrate.js");
    await applyMigrations(url, () => {}, { stopAfter: "0023_folder_scoped_sibling_names.sql" });

    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const user = (
        await c.query(
          `insert into users (email, password_hash, display_name, email_verified, storage_quota_bytes)
           values ('o@t', 'x', 'o', true, 0) returning id`,
        )
      ).rows[0].id;
      const rawToken = generateToken();
      await c.query(
        `insert into share_links (item_type, item_id, token, role, created_by)
         values ('folder', gen_random_uuid(), $1, 'viewer', $2)`,
        [rawToken, user],
      );

      await applyMigrations(url, () => {});

      const stored = (await c.query(`select token_hash from share_links`)).rows[0].token_hash;
      assert.equal(stored, hashToken(rawToken));
      await assert.rejects(
        c.query(
          `insert into share_links (item_type, item_id, token_hash, role, created_by)
           values ('folder', gen_random_uuid(), 'not-a-hash', 'viewer', $1)`,
          [user],
        ),
        /share_links_token_hash_format/,
      );
    } finally {
      await c.end();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${dbName} with (force)`);
      await cleanup.end();
    }
  });
});
