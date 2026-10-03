import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setupTestEnv, type TestEnv } from "./harness.js";

const CAP = 40;
let env: TestEnv;

before(async () => {
  env = await setupTestEnv({ RATE_LIMIT_PER_IP_PER_MINUTE: String(CAP) });
});

after(async () => {
  await env?.teardown();
});

// inject() connects from 127.0.0.1 — a trusted (loopback) hop under the default TRUST_PROXY, just
// like the Next.js container is in production — so X-Forwarded-For carries the client IP.
function fromClient(ip: string, opts: { url?: string; method?: "GET" | "POST"; payload?: object; cookie?: string } = {}) {
  return env.app.inject({
    method: opts.method ?? "GET",
    url: opts.url ?? "/api/v1/auth/me",
    headers: { "x-forwarded-for": ip, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    ...(opts.payload ? { payload: opts.payload } : {}),
  });
}

const randomCookie = () => `dbase_session=${randomBytes(16).toString("hex")}`;

describe("rate-limit identity (issue 9)", () => {
  test("rotating made-up session cookies can't escape the per-IP ceiling", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < CAP; i++) {
      const res = await fromClient(ip, { cookie: randomCookie() });
      assert.equal(res.statusCode, 401, `request ${i}`);
    }
    const blocked = await fromClient(ip, { cookie: randomCookie() });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, "RATE_LIMITED");
    assert.ok(blocked.headers["retry-after"]);
  });

  test("different clients behind the proxy get separate buckets", async () => {
    for (let i = 0; i < CAP; i++) await fromClient("203.0.113.20");
    assert.equal((await fromClient("203.0.113.20")).statusCode, 429);
    assert.equal((await fromClient("203.0.113.21")).statusCode, 401);
  });

  test("X-Forwarded-For from an untrusted (public) peer is ignored, so it can't be spoofed", async () => {
    const send = () =>
      env.app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        remoteAddress: "198.51.100.7",
        headers: { "x-forwarded-for": `192.0.2.${Math.floor(Math.random() * 250)}` },
      });
    for (let i = 0; i < CAP; i++) await send();
    assert.equal((await send()).statusCode, 429);
  });

  test("failed logins from one client no longer lock every other client out", async () => {
    const attacker = "203.0.113.30";
    for (let i = 0; i < 20; i++) {
      const res = await fromClient(attacker, {
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "victim@test.local", password: "wrong-password" },
      });
      assert.equal(res.statusCode, 401, `attempt ${i}`);
    }
    const attackerBlocked = await fromClient(attacker, {
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "victim@test.local", password: "wrong-password" },
    });
    assert.equal(attackerBlocked.statusCode, 429);

    const bystander = await fromClient("203.0.113.31", {
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "someone@test.local", password: "whatever-password" },
    });
    assert.equal(bystander.statusCode, 401, "a different client must still reach the login check");
  });

  test("public share-link routes are keyed by IP, not by an attacker-chosen cookie", async () => {
    // Unknown token → 404 from the handler, but the limiter runs first; the IP ceiling (CAP) is
    // lower than the public route limit, so a fresh cookie per request still hits 429 at CAP.
    const ip = "203.0.113.40";
    for (let i = 0; i < CAP; i++) {
      const res = await fromClient(ip, { url: "/api/v1/public/share-links/nope", cookie: randomCookie() });
      assert.equal(res.statusCode, 404, `request ${i}`);
    }
    const res = await fromClient(ip, { url: "/api/v1/public/share-links/nope", cookie: randomCookie() });
    assert.equal(res.statusCode, 429);
  });
});

describe("user lookup is tightly rate-limited (issue 10)", () => {
  test("more than 30 lookups a minute from one session are refused", async () => {
    const { createUserAndLogin, api } = await import("./harness.js");
    const { cookie } = await createUserAndLogin(env);
    for (let i = 0; i < 30; i++) {
      const res = await env.app.inject({
        method: "GET",
        url: `/api/v1/users/lookup?email=nobody${i}@test.local`,
        headers: { cookie, "x-forwarded-for": "203.0.113.50" },
      });
      assert.equal(res.statusCode, 404, `lookup ${i}`);
    }
    const blocked = await api(env, cookie).get("/users/lookup?email=x@test.local");
    assert.equal(blocked.statusCode, 429);
  });
});

describe("upload parts and the per-IP ceiling", () => {
  test("authenticated part uploads don't consume the ceiling; fake-cookie attempts still do", async () => {
    const { createUserAndLogin, api } = await import("./harness.js");
    const { cookie } = await createUserAndLogin(env);
    const init = await api(env, cookie).post("/files", { targetName: "many-parts.bin", totalParts: 1 });
    const sid = init.json().uploadSessionId as string;
    // More part requests than the ceiling, all from one client: retries of an already-recorded part
    // are cheap no-ops server-side, so this exercises the route without uploading CAP×5 MiB.
    for (let i = 0; i < CAP + 10; i++) {
      const res = await env.app.inject({
        method: "PUT",
        url: `/api/v1/files/upload-sessions/${sid}/parts/0`,
        headers: { cookie, "content-type": "application/octet-stream", "x-forwarded-for": "203.0.113.90" },
        payload: Buffer.alloc(10),
      });
      assert.equal(res.statusCode, 204, `part request ${i}: ${res.body}`);
    }

    for (let i = 0; i < CAP; i++) {
      const res = await env.app.inject({
        method: "PUT",
        url: `/api/v1/files/upload-sessions/${sid}/parts/0`,
        headers: { cookie: randomCookie(), "content-type": "application/octet-stream", "x-forwarded-for": "203.0.113.91" },
        payload: Buffer.alloc(10),
      });
      assert.equal(res.statusCode, 401, `fake request ${i}`);
    }
    const blocked = await env.app.inject({
      method: "PUT",
      url: `/api/v1/files/upload-sessions/${sid}/parts/0`,
      headers: { cookie: randomCookie(), "content-type": "application/octet-stream", "x-forwarded-for": "203.0.113.91" },
      payload: Buffer.alloc(10),
    });
    assert.equal(blocked.statusCode, 429);
  });
});
