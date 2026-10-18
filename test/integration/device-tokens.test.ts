// Long-lived device tokens for sync clients (supabase/migrations/0027).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { api, createDeviceToken, createUserAndLogin, setupTestEnv, uploadFile, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

describe("device tokens", () => {
  test("authenticate existing routes like a cookie, and are stored only as a hash", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const { id, token } = await createDeviceToken(env, cookie, "laptop");
    assert.match(token, /^dbt_/);

    const me = await api(env, token).get("/auth/me");
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().user.id, user.id);

    // Uploads (including the part route's separate guard) work with a token.
    const { file } = await uploadFile(env, token, { name: "via-token.bin", data: Buffer.from("hello") });
    assert.equal(file.name, "via-token.bin");

    const row = await env.db.device_tokens.findUniqueOrThrow({ where: { id } });
    assert.notEqual(row.token_hash, token);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.ok(row.last_used_at, "last_used_at was not recorded");

    const list = await api(env, cookie).get("/auth/device-tokens");
    assert.deepEqual(
      list.json().deviceTokens.map((t: { id: string; name: string }) => [t.id, t.name]),
      [[id, "laptop"]],
    );
    assert.equal("token" in list.json().deviceTokens[0], false);
  });

  test("unknown and malformed tokens are rejected", async () => {
    assert.equal((await api(env, "dbt_not-a-real-token").get("/auth/me")).statusCode, 401);
    const res = await env.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: "Bearer something-else" },
    });
    assert.equal(res.statusCode, 401);
  });

  test("can't manage credentials: no minting, no password change, no account deletion", async () => {
    const { cookie } = await createUserAndLogin(env);
    const { token } = await createDeviceToken(env, cookie);
    const client = api(env, token);

    assert.equal((await client.post("/auth/device-tokens", { name: "escalate" })).statusCode, 403);
    assert.equal((await client.get("/auth/device-tokens")).statusCode, 403);
    assert.equal((await client.get("/auth/sessions")).statusCode, 403);
    assert.equal(
      (await client.post("/auth/change-password", { currentPassword: "password123", newPassword: "newpassword123" }))
        .statusCode,
      403,
    );
    assert.equal((await client.delete("/users/me")).statusCode, 403);
  });

  test("revoked by DELETE, by logout from the device, and by a password change", async () => {
    const { user, cookie } = await createUserAndLogin(env);

    const a = await createDeviceToken(env, cookie);
    assert.equal((await api(env, cookie).delete(`/auth/device-tokens/${a.id}`)).statusCode, 204);
    assert.equal((await api(env, a.token).get("/auth/me")).statusCode, 401);
    assert.equal((await api(env, cookie).delete(`/auth/device-tokens/${a.id}`)).statusCode, 404);

    const b = await createDeviceToken(env, cookie);
    assert.equal((await api(env, b.token).post("/auth/logout")).statusCode, 204);
    assert.equal((await api(env, b.token).get("/auth/me")).statusCode, 401);
    // The browser session that minted it is unaffected.
    assert.equal((await api(env, cookie).get("/auth/me")).statusCode, 200);

    const c = await createDeviceToken(env, cookie);
    const changed = await api(env, cookie).post("/auth/change-password", {
      currentPassword: user.password,
      newPassword: "a-new-password-123",
    });
    assert.equal(changed.statusCode, 204, changed.body);
    assert.equal((await api(env, c.token).get("/auth/me")).statusCode, 401);
  });

  test("another user's token id can't be revoked", async () => {
    const owner = await createUserAndLogin(env);
    const other = await createUserAndLogin(env);
    const { id, token } = await createDeviceToken(env, owner.cookie);
    assert.equal((await api(env, other.cookie).delete(`/auth/device-tokens/${id}`)).statusCode, 404);
    assert.equal((await api(env, token).get("/auth/me")).statusCode, 200);
  });

  test("stop working when the account is deactivated, and stay revoked after reactivation", async () => {
    const admin = await createUserAndLogin(env, { role: "admin" });
    const { user, cookie } = await createUserAndLogin(env);
    const { token } = await createDeviceToken(env, cookie);

    const off = await api(env, admin.cookie).post(`/admin/users/${user.id}/deactivate`);
    assert.ok(off.statusCode < 300, off.body);
    assert.equal((await api(env, token).get("/auth/me")).statusCode, 401);

    const on = await api(env, admin.cookie).post(`/admin/users/${user.id}/reactivate`);
    assert.ok(on.statusCode < 300, on.body);
    assert.equal((await api(env, token).get("/auth/me")).statusCode, 401);
  });
});
