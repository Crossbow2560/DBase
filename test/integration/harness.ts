// Integration-test harness: one throwaway Postgres database + MinIO bucket per test file, migrated
// through the same applyMigrations() deploys use, and the real Fastify app (buildApp) driven via
// app.inject(). Requires the `test` compose profile: `npm run test:db:up`.
//
// node --test runs every test file in its own process, so the env set here (before the app's
// modules are first imported — src/config.ts reads env at import time) is per-file and can't leak
// between files.

import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Client } from "pg";

// Point dotenv at nothing BEFORE anything that imports "dotenv/config" (scripts/migrate.ts,
// src/config.ts) is loaded — those are imported dynamically below for exactly this reason — so a
// developer's real .env (real Supabase URL, real Resend key) can never leak into a test run.
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const ADMIN_DB_URL =
  process.env.TEST_DB_ADMIN_URL ??
  `postgres://dbase_test:dbase_test@localhost:${process.env.TEST_DB_PORT ?? "54329"}/postgres`;
const MINIO_PORT = process.env.TEST_MINIO_PORT ?? "59000";

export interface TestEnv {
  app: FastifyInstance;
  db: typeof import("../../src/db.js").db;
  storage: typeof import("../../src/modules/storage/client.js");
  dbName: string;
  bucket: string;
  teardown: () => Promise<void>;
}

export async function setupTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const suffix = randomBytes(6).toString("hex");
  const dbName = `dbase_it_${suffix}`;
  const bucket = `dbase-it-${suffix}`;

  const admin = new Client({ connectionString: ADMIN_DB_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Can't reach the integration-test Postgres at ${ADMIN_DB_URL} — start it with \`npm run test:db:up\`. (${String(err)})`,
    );
  }
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const databaseUrl = ADMIN_DB_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const { applyMigrations } = await import("../../scripts/migrate.js");
  await applyMigrations(databaseUrl, () => {});

  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    MINIO_ENDPOINT: "localhost",
    MINIO_PORT,
    MINIO_USE_SSL: "false",
    MINIO_ACCESS_KEY: "dbase_test",
    MINIO_SECRET_KEY: "dbase_test_secret",
    MINIO_BUCKET: bucket,
    MINIO_PUBLIC_ENDPOINT: "localhost",
    MINIO_PUBLIC_PORT: MINIO_PORT,
    MINIO_PUBLIC_USE_SSL: "false",
    RESEND_API_KEY: "",
    RESEND_WEBHOOK_SECRET: "",
    PUBLIC_APP_URL: "http://localhost:3001",
    DEFAULT_USER_QUOTA_BYTES: String(1024 * 1024 * 1024),
    ...overrides,
  });

  const [{ buildApp }, { db }, storage] = await Promise.all([
    import("../../src/app.js"),
    import("../../src/db.js"),
    import("../../src/modules/storage/client.js"),
  ]);
  await storage.ensureBucketExists();
  const app = await buildApp({ logger: false });
  await app.ready();

  return {
    app,
    db,
    storage,
    dbName,
    bucket,
    teardown: async () => {
      await app.close();
      await db.$disconnect();
      // Remove this file's bucket too — the test MinIO keeps data in tmpfs, and leftover buckets
      // from every run (some tests write 32–64 MiB parts) eventually fill it.
      await removeBucket(bucket).catch(() => undefined);
      const cleanup = new Client({ connectionString: ADMIN_DB_URL });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${dbName} with (force)`);
      await cleanup.end();
    },
  };
}

async function removeBucket(bucket: string) {
  const { Client: MinioClient } = await import("minio");
  const minio = new MinioClient({
    endPoint: "localhost",
    port: Number(MINIO_PORT),
    useSSL: false,
    accessKey: "dbase_test",
    secretKey: "dbase_test_secret",
    region: "us-east-1",
  });
  const names: string[] = [];
  for await (const item of minio.listObjectsV2(bucket, "", true)) {
    if (item.name) names.push(item.name);
  }
  if (names.length > 0) await minio.removeObjects(bucket, names);
  await minio.removeBucket(bucket);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

let userCounter = 0;

export async function createUser(
  env: TestEnv,
  opts: { email?: string; password?: string; role?: "user" | "admin"; verified?: boolean; quotaBytes?: bigint } = {},
) {
  const { hashPassword } = await import("../../src/lib/password.js");
  const password = opts.password ?? "password123";
  userCounter += 1;
  const user = await env.db.users.create({
    data: {
      email: opts.email ?? `user${userCounter}-${randomBytes(3).toString("hex")}@test.local`,
      password_hash: await hashPassword(password),
      display_name: `Test User ${userCounter}`,
      role: opts.role ?? "user",
      email_verified: opts.verified ?? true,
      storage_quota_bytes: opts.quotaBytes ?? BigInt(1024 * 1024 * 1024),
    },
  });
  return { ...user, password };
}

let loginCounter = 0;

/**
 * Logs in through the real endpoint and returns the Cookie header value to send back. Each call
 * comes from its own client IP (X-Forwarded-For via the trusted loopback hop, like production's
 * Next.js proxy) — the login route allows 20 attempts per IP per 15 minutes, and test files create
 * far more users than that. 100.64.0.0/10 isn't in TRUST_PROXY's private ranges, so it's taken as
 * the client address.
 */
export async function login(env: TestEnv, email: string, password: string): Promise<string> {
  loginCounter += 1;
  const clientIp = `100.64.${Math.floor(loginCounter / 250)}.${(loginCounter % 250) + 1}`;
  const res = await env.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "x-forwarded-for": clientIp },
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return raw.split(";")[0]!;
}

export async function createUserAndLogin(env: TestEnv, opts: Parameters<typeof createUser>[1] = {}) {
  const user = await createUser(env, opts);
  const cookie = await login(env, user.email, user.password);
  return { user, cookie };
}

/** JSON request helper — inject() with an optional session cookie. */
export function api(env: TestEnv, cookie?: string) {
  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE") =>
    (url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
      env.app.inject({
        method,
        url: `/api/v1${url}`,
        headers: cookie ? { cookie } : {},
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });
  return { get: call("GET"), post: call("POST"), put: call("PUT"), patch: call("PATCH"), delete: call("DELETE") };
}

export function putPart(env: TestEnv, cookie: string, sessionId: string, partNumber: number | string, data: Buffer) {
  return env.app.inject({
    method: "PUT",
    url: `/api/v1/files/upload-sessions/${sessionId}/parts/${partNumber}`,
    headers: { cookie, "content-type": "application/octet-stream" },
    payload: data,
  });
}

export const PART_SIZE = 5 * 1024 * 1024;

/** Full happy-path upload through the real endpoints, split into PART_SIZE parts. */
export async function uploadFile(
  env: TestEnv,
  cookie: string,
  opts: { name: string; data: Buffer; folderId?: string | null; mimeType?: string },
) {
  const totalParts = Math.max(1, Math.ceil(opts.data.length / PART_SIZE));
  const init = await api(env, cookie).post("/files", {
    targetName: opts.name,
    totalParts,
    targetFolderId: opts.folderId ?? null,
  });
  if (init.statusCode !== 201) throw new Error(`init failed: ${init.statusCode} ${init.body}`);
  const { uploadSessionId } = init.json() as { uploadSessionId: string };
  for (let i = 0; i < totalParts; i++) {
    const res = await putPart(env, cookie, uploadSessionId, i, opts.data.subarray(i * PART_SIZE, (i + 1) * PART_SIZE));
    if (res.statusCode !== 204) throw new Error(`part ${i} failed: ${res.statusCode} ${res.body}`);
  }
  const done = await api(env, cookie).post(`/files/upload-sessions/${uploadSessionId}/complete`, {
    mimeType: opts.mimeType ?? "application/octet-stream",
  });
  if (done.statusCode !== 200) throw new Error(`complete failed: ${done.statusCode} ${done.body}`);
  return { uploadSessionId, file: (done.json() as { file: { id: string; name: string } }).file };
}

export async function storageUsed(env: TestEnv, userId: string): Promise<bigint> {
  const u = await env.db.users.findUniqueOrThrow({ where: { id: userId }, select: { storage_used_bytes: true } });
  return u.storage_used_bytes;
}
