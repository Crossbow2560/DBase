// The admin-editable default quota for new accounts (supabase/migrations/0026).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { api, createUserAndLogin, setupTestEnv, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

let registerCounter = 0;

async function register(email: string) {
  registerCounter += 1;
  const res = await env.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { "x-forwarded-for": `100.65.0.${registerCounter}` },
    payload: { email, password: "password123", displayName: "New User" },
  });
  assert.ok(res.statusCode < 300, `register: ${res.statusCode} ${res.body}`);
  return env.db.users.findUniqueOrThrow({ where: { email } });
}

describe("default quota for new users", () => {
  test("falls back to DEFAULT_USER_QUOTA_BYTES until an admin sets one", async () => {
    const { config } = await import("../../src/config.js");
    const admin = await createUserAndLogin(env, { role: "admin" });
    const settings = await api(env, admin.cookie).get("/admin/system-storage");
    assert.equal(settings.json().defaultUserQuotaBytes, Number(config.defaultUserQuotaBytes));

    const user = await register("before-change@test.local");
    assert.equal(user.storage_quota_bytes, config.defaultUserQuotaBytes);
  });

  test("an admin's new default applies to new registrations only, and is audited", async () => {
    const admin = await createUserAndLogin(env, { role: "admin" });
    const existing = await env.db.users.findUniqueOrThrow({ where: { email: "before-change@test.local" } });

    const res = await api(env, admin.cookie).patch("/admin/system-storage/default-quota", {
      defaultUserQuotaBytes: 2_000_000_000,
    });
    assert.equal(res.statusCode, 204, res.body);
    assert.equal((await api(env, admin.cookie).get("/admin/system-storage")).json().defaultUserQuotaBytes, 2_000_000_000);

    const user = await register("after-change@test.local");
    assert.equal(user.storage_quota_bytes, 2_000_000_000n);
    const unchanged = await env.db.users.findUniqueOrThrow({ where: { id: existing.id } });
    assert.equal(unchanged.storage_quota_bytes, existing.storage_quota_bytes);

    const log = await env.db.activity_log.findFirst({
      where: { action: "default_quota_change", actor_id: admin.user.id },
    });
    assert.ok(log, "default quota change was not logged");
  });

  test("rejects negative, fractional and larger-than-the-system-limit values", async () => {
    const admin = await createUserAndLogin(env, { role: "admin" });
    const { total_storage_limit_bytes: limit } = await env.db.system_settings.findUniqueOrThrow({ where: { id: true } });
    for (const value of [-1, 1.5, Number(limit) + 1]) {
      const res = await api(env, admin.cookie).patch("/admin/system-storage/default-quota", { defaultUserQuotaBytes: value });
      assert.equal(res.statusCode, 400, `${value}: ${res.body}`);
    }
    // Exactly the limit is allowed.
    const ok = await api(env, admin.cookie).patch("/admin/system-storage/default-quota", { defaultUserQuotaBytes: Number(limit) });
    assert.equal(ok.statusCode, 204, ok.body);
    await api(env, admin.cookie).patch("/admin/system-storage/default-quota", { defaultUserQuotaBytes: 2_000_000_000 });
  });

  test("only admins can change it", async () => {
    const { cookie } = await createUserAndLogin(env);
    const res = await api(env, cookie).patch("/admin/system-storage/default-quota", { defaultUserQuotaBytes: 1 });
    assert.equal(res.statusCode, 403, res.body);
  });
});
