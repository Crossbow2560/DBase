// Seeds a local, throwaway "preview" environment for manual/browser checks against the
// integration-test containers (`npm run test:db:up`) — never the real Supabase database.
//
//   npm run preview:seed
//
// Creates database `dbase_preview` on the test Postgres (migrated via applyMigrations), the MinIO
// bucket `dbase-preview` on the test MinIO, and two verified accounts. The `preview:backend` /
// `preview:web` launch configs (.claude/launch.json) run the app against exactly this.
//
// Fixed, test-only credentials — this database only exists inside the local test container:
//   preview-admin@dbase.test / preview-password   (admin)
//   preview-user@dbase.test  / preview-password   (user)

process.env.DOTENV_CONFIG_PATH = "/dev/null";

import { Client } from "pg";
import { previewEnv, PREVIEW_ADMIN_DB_URL, PREVIEW_DB_NAME } from "./env.js";

const PREVIEW_PASSWORD = "preview-password";

const admin = new Client({ connectionString: PREVIEW_ADMIN_DB_URL });
await admin.connect();
const exists = await admin.query("select 1 from pg_database where datname = $1", [PREVIEW_DB_NAME]);
if (exists.rowCount === 0) await admin.query(`create database ${PREVIEW_DB_NAME}`);
await admin.end();

Object.assign(process.env, previewEnv());

const { applyMigrations } = await import("../../scripts/migrate.js");
const ran = await applyMigrations(process.env.DATABASE_URL!, () => {});
console.log(`migrations applied: ${ran}`);

const storage = await import("../../src/modules/storage/client.js");
await storage.ensureBucketExists();

const { db } = await import("../../src/db.js");
const { hashPassword } = await import("../../src/lib/password.js");
const passwordHash = await hashPassword(PREVIEW_PASSWORD);
for (const [email, role, name] of [
  ["preview-admin@dbase.test", "admin", "Preview Admin"],
  ["preview-user@dbase.test", "user", "Preview User"],
] as const) {
  await db.users.upsert({
    where: { email },
    create: {
      email,
      password_hash: passwordHash,
      display_name: name,
      role,
      email_verified: true,
      storage_quota_bytes: BigInt(1024 * 1024 * 1024),
    },
    update: { password_hash: passwordHash, email_verified: true, is_active: true },
  });
}
await db.$disconnect();
console.log("preview accounts ready (see test/preview/seed.ts header)");
