import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { api, login, setupTestEnv, storageUsed, uploadFile, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

test("every migration file is applied and recorded", async () => {
  const files = (await readdir(new URL("../../supabase/migrations/", import.meta.url))).filter((f) => f.endsWith(".sql"));
  const rows = await env.db.$queryRaw<{ name: string }[]>`select name from _migrations order by name`;
  assert.deepEqual(
    rows.map((r) => r.name),
    files.sort(),
  );
});

test("health endpoint responds", async () => {
  const res = await env.app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" });
});

test("register → verify → login → upload → download, end to end", async () => {
  const { generateToken, hashToken } = await import("../../src/lib/tokens.js");
  const email = "smoke@test.local";
  const password = "password123";

  const reg = await api(env).post("/auth/register", { email, password, displayName: "Smoke" });
  assert.equal(reg.statusCode, 201, reg.body);

  // Unverified accounts can't log in.
  const early = await api(env).post("/auth/login", { email, password });
  assert.equal(early.statusCode, 403);
  assert.equal(early.json().error.code, "EMAIL_NOT_VERIFIED");

  // The raw verification token only ever exists inside the (logged) email, so mint our own the
  // same way sendVerificationEmail() does and redeem it through the real endpoint.
  const user = await env.db.users.findUniqueOrThrow({ where: { email } });
  const rawToken = generateToken();
  await env.db.email_verification_tokens.create({
    data: { user_id: user.id, token_hash: hashToken(rawToken), expires_at: new Date(Date.now() + 60_000) },
  });
  const verify = await api(env).post("/auth/verify-email", { token: rawToken });
  assert.equal(verify.statusCode, 200, verify.body);

  const cookie = await login(env, email, password);
  const me = await api(env, cookie).get("/auth/me");
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, email);

  const data = Buffer.from("hello from the integration suite");
  const { file } = await uploadFile(env, cookie, { name: "hello.txt", data, mimeType: "text/plain" });
  assert.equal(file.name, "hello.txt");
  assert.equal(await storageUsed(env, user.id), BigInt(data.length));

  const listing = await api(env, cookie).get("/folders/contents");
  assert.equal(listing.statusCode, 200);
  assert.ok((listing.json().items as { name: string }[]).some((i) => i.name === "hello.txt"));

  const dl = await api(env, cookie).get(`/files/${file.id}/download`);
  assert.equal(dl.statusCode, 200, dl.body);
  const body = Buffer.from(await (await fetch(dl.json().url)).arrayBuffer());
  assert.deepEqual(body, data);
});

test("protected routes reject requests without a session", async () => {
  for (const url of ["/auth/me", "/folders/contents", "/trash", "/favorites", "/search?q=x", "/shared-with-me"]) {
    const res = await api(env).get(url);
    assert.equal(res.statusCode, 401, url);
    assert.equal(res.json().error.code, "UNAUTHENTICATED");
  }
  const adminRes = await api(env).get("/admin/users");
  assert.equal(adminRes.statusCode, 401);
});

test("admin routes reject non-admin users with 403", async () => {
  const { createUserAndLogin } = await import("./harness.js");
  const { cookie } = await createUserAndLogin(env);
  const res = await api(env, cookie).get("/admin/users");
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "INSUFFICIENT_PERMISSION");
});

test("on a plain-HTTP PUBLIC_APP_URL the session cookie isn't marked Secure (issue 15)", async () => {
  const { createUser } = await import("./harness.js");
  const user = await createUser(env);
  const res = await api(env).post("/auth/login", { email: user.email, password: user.password });
  assert.equal(res.statusCode, 200);
  const header = String(res.headers["set-cookie"]);
  assert.match(header, /HttpOnly/i);
  assert.doesNotMatch(header, /;\s*Secure/i);
});
