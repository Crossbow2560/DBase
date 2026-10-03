import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { api, createUserAndLogin, PART_SIZE, putPart, setupTestEnv, storageUsed, uploadFile, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

async function initSession(cookie: string, totalParts: number, name = `f-${Math.random().toString(36).slice(2)}.bin`) {
  const res = await api(env, cookie).post("/files", { targetName: name, totalParts });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { uploadSessionId: string }).uploadSessionId;
}

describe("part number validation (issue 2)", () => {
  test("negative and non-numeric part numbers are rejected with 400, not 500", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 1);
    for (const bad of ["-1", "abc", "1.5"]) {
      const res = await putPart(env, cookie, sid, bad, Buffer.from("x"));
      assert.equal(res.statusCode, 400, `part ${bad}: ${res.body}`);
      assert.equal(res.json().error.code, "VALIDATION_ERROR");
    }
    assert.equal(await storageUsed(env, user.id), 0n);
  });

  test("a non-UUID session id is a 400, not a 500", async () => {
    const { cookie } = await createUserAndLogin(env);
    const res = await putPart(env, cookie, "not-a-uuid", 0, Buffer.from("x"));
    assert.equal(res.statusCode, 400, res.body);
  });

  test("part numbers >= totalParts are rejected and not charged", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 2);
    const res = await putPart(env, cookie, sid, 2, Buffer.alloc(1024));
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, "VALIDATION_ERROR");
    assert.equal(await storageUsed(env, user.id), 0n);
    const parts = await env.db.upload_session_parts.count({ where: { upload_session_id: sid } });
    assert.equal(parts, 0);
  });

  test("complete refuses when part 0 is missing, even if the count matches", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 1);
    // Only valid number for totalParts=1 is 0; send nothing for 0 and try to complete.
    const done = await api(env, cookie).post(`/files/upload-sessions/${sid}/complete`, {});
    assert.equal(done.statusCode, 409, done.body);
    assert.equal(done.json().error.code, "UPLOAD_SESSION_INVALID");
    assert.equal(await env.db.files.count({ where: { owner_id: user.id } }), 0);
  });

  test("complete checks the exact part set, not just the count (parts 0 and 5 of 2)", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 2);
    // Rows inserted directly to model what the old count-only check let through: two rows, right
    // count, wrong numbers (part 1 is missing).
    await env.db.upload_session_parts.createMany({
      data: [
        { upload_session_id: sid, part_number: 0, size_bytes: 1n },
        { upload_session_id: sid, part_number: 5, size_bytes: 1n },
      ],
    });
    const done = await api(env, cookie).post(`/files/upload-sessions/${sid}/complete`, {});
    assert.equal(done.statusCode, 409, done.body);
    assert.equal(done.json().error.code, "UPLOAD_SESSION_INVALID");
    assert.equal(await env.db.files.count({ where: { owner_id: user.id } }), 0);
  });
});

describe("minimum part size (issue 4)", () => {
  test("a non-final part under 5 MiB is rejected with PART_TOO_SMALL and not charged", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 2);
    const res = await putPart(env, cookie, sid, 0, Buffer.alloc(1024));
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, "PART_TOO_SMALL");
    assert.equal(await storageUsed(env, user.id), 0n);
  });

  test("the last part may be small, and a real multi-part upload composes byte-for-byte", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const data = Buffer.alloc(PART_SIZE * 2 + 1234);
    for (let i = 0; i < data.length; i += 4096) data[i] = i % 251;
    const { file } = await uploadFile(env, cookie, { name: "big.bin", data });
    assert.equal(await storageUsed(env, user.id), BigInt(data.length));
    const dl = await api(env, cookie).get(`/files/${file.id}/download`);
    const body = Buffer.from(await (await fetch(dl.json().url)).arrayBuffer());
    assert.equal(body.length, data.length);
    assert.ok(body.equals(data));
  });
});

describe("race-safe part recording (issue 3)", () => {
  test("the same part sent concurrently is charged exactly once", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    for (let round = 0; round < 5; round++) {
      const sid = await initSession(cookie, 1);
      const data = Buffer.alloc(4096, round);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => putPart(env, cookie, sid, 0, data)),
      );
      for (const r of results) assert.equal(r.statusCode, 204, r.body);
      const rows = await env.db.upload_session_parts.count({ where: { upload_session_id: sid } });
      assert.equal(rows, 1);
    }
    assert.equal(await storageUsed(env, user.id), 5n * 4096n);
  });

  test("a sequential retry of a recorded part is a no-op", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 1);
    const data = Buffer.alloc(2048, 7);
    assert.equal((await putPart(env, cookie, sid, 0, data)).statusCode, 204);
    assert.equal((await putPart(env, cookie, sid, 0, data)).statusCode, 204);
    assert.equal(await storageUsed(env, user.id), 2048n);
  });

  test("a part rejected for quota leaves no claim row behind and can be retried", async () => {
    const { user, cookie } = await createUserAndLogin(env, { quotaBytes: 1000n });
    const sid = await initSession(cookie, 1);
    const res = await putPart(env, cookie, sid, 0, Buffer.alloc(2000));
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json().error.code, "QUOTA_EXCEEDED");
    assert.equal(await env.db.upload_session_parts.count({ where: { upload_session_id: sid } }), 0);
    assert.equal(await storageUsed(env, user.id), 0n);
    // Same part number, now within quota — must not be swallowed as an "already recorded" retry.
    assert.equal((await putPart(env, cookie, sid, 0, Buffer.alloc(500))).statusCode, 204);
    assert.equal(await storageUsed(env, user.id), 500n);
  });
});

describe("atomic completion and race-safe aborts (issue 1)", () => {
  async function sessionWithOnePart(cookie: string, bytes = 3000) {
    const sid = await initSession(cookie, 1);
    assert.equal((await putPart(env, cookie, sid, 0, Buffer.alloc(bytes, 1))).statusCode, 204);
    return sid;
  }

  test("a compose failure leaves no file row, keeps the charge, and returns the session to pending", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await sessionWithOnePart(cookie);
    // Simulate MinIO losing the part between upload and completion: compose will fail.
    await env.storage.removeUploadParts(sid, 1);

    const done = await api(env, cookie).post(`/files/upload-sessions/${sid}/complete`, {});
    assert.ok(done.statusCode >= 500, `expected a server error, got ${done.statusCode} ${done.body}`);
    assert.equal(await env.db.files.count({ where: { owner_id: user.id } }), 0);
    const session = await env.db.upload_sessions.findUniqueOrThrow({ where: { id: sid } });
    assert.equal(session.status, "pending");
    assert.equal(session.file_id, null);
    assert.equal(await storageUsed(env, user.id), 3000n);

    // The client can still cancel, which refunds everything.
    assert.equal((await api(env, cookie).delete(`/files/upload-sessions/${sid}`)).statusCode, 204);
    assert.equal(await storageUsed(env, user.id), 0n);
  });

  test("an invalid destination at completion aborts with a refund and no file row", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sidA = await sessionWithOnePart(cookie, 1000);
    // Another upload takes the same name first.
    const name = (await env.db.upload_sessions.findUniqueOrThrow({ where: { id: sidA } })).target_name;
    await env.db.upload_sessions.update({ where: { id: sidA }, data: { target_name: name } });
    await uploadFile(env, cookie, { name, data: Buffer.alloc(10) });

    const done = await api(env, cookie).post(`/files/upload-sessions/${sidA}/complete`, {});
    assert.equal(done.statusCode, 409, done.body);
    assert.equal((await env.db.upload_sessions.findUniqueOrThrow({ where: { id: sidA } })).status, "aborted");
    assert.equal(await env.db.files.count({ where: { owner_id: user.id } }), 1);
    assert.equal(await storageUsed(env, user.id), 10n);
  });

  test("cancel racing the cleanup worker refunds exactly once", async () => {
    const { cleanupExpiredSessions } = await import("../../src/modules/filesystem/upload-service.js");
    const { user, cookie } = await createUserAndLogin(env);
    for (let round = 0; round < 5; round++) {
      const sid = await sessionWithOnePart(cookie, 1000);
      await env.db.upload_sessions.update({ where: { id: sid }, data: { expires_at: new Date(Date.now() - 1000) } });
      const [cancel, cleanup] = await Promise.allSettled([
        api(env, cookie).delete(`/files/upload-sessions/${sid}`),
        cleanupExpiredSessions(),
      ]);
      assert.equal(cleanup.status, "fulfilled", String((cleanup as PromiseRejectedResult).reason));
      assert.equal(cancel.status, "fulfilled");
      assert.ok([204, 404].includes((cancel as PromiseFulfilledResult<{ statusCode: number }>).value.statusCode));
      assert.equal((await env.db.upload_sessions.findUniqueOrThrow({ where: { id: sid } })).status, "aborted");
    }
    assert.equal(await storageUsed(env, user.id), 0n);
  });

  test("completion racing the cleanup worker never yields a file whose bytes were refunded", async () => {
    const { cleanupExpiredSessions } = await import("../../src/modules/filesystem/upload-service.js");
    const { user, cookie } = await createUserAndLogin(env);
    for (let round = 0; round < 5; round++) {
      const sid = await sessionWithOnePart(cookie, 1000);
      await env.db.upload_sessions.update({ where: { id: sid }, data: { expires_at: new Date(Date.now() - 1000) } });
      await Promise.allSettled([
        api(env, cookie).post(`/files/upload-sessions/${sid}/complete`, {}),
        cleanupExpiredSessions(),
      ]);
    }
    const liveBytes = await env.db.files.aggregate({ where: { owner_id: user.id }, _sum: { size_bytes: true } });
    assert.equal(await storageUsed(env, user.id), liveBytes._sum.size_bytes ?? 0n);
  });

  test("a part landing after its session was cancelled is not left charged", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    for (let round = 0; round < 5; round++) {
      const sid = await initSession(cookie, 1);
      await Promise.allSettled([
        putPart(env, cookie, sid, 0, Buffer.alloc(4000, 2)),
        api(env, cookie).delete(`/files/upload-sessions/${sid}`),
      ]);
      const status = (await env.db.upload_sessions.findUniqueOrThrow({ where: { id: sid } })).status;
      if (status === "pending") {
        // Cancel ran first and found nothing, or the part won; cancel again to settle.
        await api(env, cookie).delete(`/files/upload-sessions/${sid}`);
      }
    }
    assert.equal(await storageUsed(env, user.id), 0n);
  });
});

describe("upload throughput path (parallel, streamed, larger parts)", () => {
  test("parts sent concurrently and out of order compose byte-for-byte", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const partSize = 5 * 1024 * 1024;
    const data = Buffer.alloc(partSize * 3 + 4321);
    for (let i = 0; i < data.length; i += 3001) data[i] = (i / 3001) % 256;
    const sid = await initSession(cookie, 4, "parallel.bin");
    const order = [3, 1, 0, 2];
    const results = await Promise.all(
      order.map((n) => putPart(env, cookie, sid, n, data.subarray(n * partSize, (n + 1) * partSize))),
    );
    for (const r of results) assert.equal(r.statusCode, 204, r.body);
    const done = await api(env, cookie).post(`/files/upload-sessions/${sid}/complete`, {});
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(await storageUsed(env, user.id), BigInt(data.length));
    const dl = await api(env, cookie).get(`/files/${done.json().file.id}/download`);
    const body = Buffer.from(await (await fetch(dl.json().url)).arrayBuffer());
    assert.ok(body.equals(data));
  });

  test("a 32 MiB part is accepted; one over 64 MiB is refused before anything is charged", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 2);
    assert.equal((await putPart(env, cookie, sid, 0, Buffer.alloc(32 * 1024 * 1024, 1))).statusCode, 204);
    assert.equal(await storageUsed(env, user.id), 32n * 1024n * 1024n);

    const big = await putPart(env, cookie, sid, 1, Buffer.alloc(64 * 1024 * 1024 + 1, 2));
    assert.equal(big.statusCode, 413, big.body);
    assert.equal(big.json().error.code, "PART_TOO_LARGE");
    assert.equal(await storageUsed(env, user.id), 32n * 1024n * 1024n);
  });

  test("a part without Content-Length is refused with 411", async () => {
    const { Readable } = await import("node:stream");
    const { cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 1);
    const res = await env.app.inject({
      method: "PUT",
      url: `/api/v1/files/upload-sessions/${sid}/parts/0`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Readable.from([Buffer.alloc(100)]),
    });
    assert.equal(res.statusCode, 411, res.body);
    assert.equal(res.json().error.code, "LENGTH_REQUIRED");
  });

  test("a body shorter than its declared length is rejected and the charge released", async () => {
    const { Readable } = await import("node:stream");
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 1);
    const res = await env.app.inject({
      method: "PUT",
      url: `/api/v1/files/upload-sessions/${sid}/parts/0`,
      headers: { cookie, "content-type": "application/octet-stream", "content-length": "2000" },
      payload: Readable.from([Buffer.alloc(1000)]),
    });
    assert.ok(res.statusCode >= 400, `expected failure, got ${res.statusCode}`);
    assert.equal(await storageUsed(env, user.id), 0n);
    assert.equal(await env.db.upload_session_parts.count({ where: { upload_session_id: sid } }), 0);
    // The same part can then be sent properly.
    assert.equal((await putPart(env, cookie, sid, 0, Buffer.alloc(1000))).statusCode, 204);
    assert.equal(await storageUsed(env, user.id), 1000n);
  });
});

describe("idempotent completion (retries)", () => {
  test("completing twice returns the same file instead of a 404, and charges once", async () => {
    const { user, cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 1, "twice.txt");
    assert.equal((await putPart(env, cookie, sid, 0, Buffer.from("hello"))).statusCode, 204);
    const first = await api(env, cookie).post(`/files/upload-sessions/${sid}/complete`, {});
    const second = await api(env, cookie).post(`/files/upload-sessions/${sid}/complete`, {});
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().file.id, first.json().file.id);
    assert.equal(await env.db.files.count({ where: { owner_id: user.id, name: "twice.txt" } }), 1);
    assert.equal(await storageUsed(env, user.id), 5n);
  });

  test("a completion retried while the first is still running gets a retryable 409", async () => {
    const { cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 1);
    // Model "first completion has claimed the session but not yet created the file".
    await env.db.upload_sessions.update({ where: { id: sid }, data: { status: "complete" } });
    const res = await api(env, cookie).post(`/files/upload-sessions/${sid}/complete`, {});
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "UPLOAD_IN_PROGRESS");
  });

  test("an aborted session still answers 404 on complete", async () => {
    const { cookie } = await createUserAndLogin(env);
    const sid = await initSession(cookie, 1);
    assert.equal((await api(env, cookie).delete(`/files/upload-sessions/${sid}`)).statusCode, 204);
    assert.equal((await api(env, cookie).post(`/files/upload-sessions/${sid}/complete`, {})).statusCode, 404);
  });
});
