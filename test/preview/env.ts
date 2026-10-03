// Shared env for the local preview environment (see seed.ts). Points the app at the
// integration-test containers from the `test` compose profile, never at the real database.

const TEST_DB_PORT = process.env.TEST_DB_PORT ?? "54329";
const TEST_MINIO_PORT = process.env.TEST_MINIO_PORT ?? "59000";

export const PREVIEW_DB_NAME = "dbase_preview";
export const PREVIEW_ADMIN_DB_URL = `postgres://dbase_test:dbase_test@localhost:${TEST_DB_PORT}/postgres`;

export function previewEnv(): Record<string, string> {
  return {
    DATABASE_URL: `postgres://dbase_test:dbase_test@localhost:${TEST_DB_PORT}/${PREVIEW_DB_NAME}`,
    MINIO_ENDPOINT: "localhost",
    MINIO_PORT: TEST_MINIO_PORT,
    MINIO_USE_SSL: "false",
    MINIO_ACCESS_KEY: "dbase_test",
    MINIO_SECRET_KEY: "dbase_test_secret",
    MINIO_BUCKET: "dbase-preview",
    MINIO_PUBLIC_ENDPOINT: "localhost",
    MINIO_PUBLIC_PORT: TEST_MINIO_PORT,
    MINIO_PUBLIC_USE_SSL: "false",
    RESEND_API_KEY: "",
    RESEND_WEBHOOK_SECRET: "",
    PUBLIC_APP_URL: "http://localhost:3110",
    PORT: "3105",
  };
}
