import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { api, createUser, setupTestEnv, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv({ PUBLIC_APP_URL: "https://files.example.com" });
});

after(async () => {
  await env?.teardown();
});

test("an https PUBLIC_APP_URL marks the session cookie Secure (issue 15)", async () => {
  const user = await createUser(env);
  const res = await api(env).post("/auth/login", { email: user.email, password: user.password });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["set-cookie"]), /;\s*Secure/i);
});
