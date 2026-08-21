import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "dbase_session",
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
  defaultUserQuotaBytes: BigInt(process.env.DEFAULT_USER_QUOTA_BYTES ?? "16106127360"), // 15 GiB
  passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? 30),
  databaseUrl: requireEnv("DATABASE_URL"),

  // DESIGN.md §3.5: an upload session not resumed within this window is abandoned and cleaned
  // up by the background worker (src/workers/upload-session-cleanup.ts).
  uploadSessionTtlMinutes: Number(process.env.UPLOAD_SESSION_TTL_MINUTES ?? 60),

  // REQUIREMENTS.md §5.4: an item is automatically purged 30 days after its own trashing time.
  trashRetentionDays: Number(process.env.TRASH_RETENTION_DAYS ?? 30),

  minio: {
    // Defaults match docker-compose.yml's service name/port for the containerized deployment;
    // local (non-Docker) dev overrides via .env to point at a standalone `docker compose up
    // minio` or any other S3-compatible endpoint. This is the endpoint the BACKEND container
    // itself uses to reach MinIO over the Docker-internal network — never handed to a browser.
    endpoint: process.env.MINIO_ENDPOINT ?? "localhost",
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: requireEnv("MINIO_ACCESS_KEY"),
    secretKey: requireEnv("MINIO_SECRET_KEY"),
    bucket: process.env.MINIO_BUCKET ?? "dbase",

    // Real bug, found by actually loading a thumbnail in a browser rather than only verifying
    // presigned URLs from inside the Docker network (docker exec): a presigned URL built from
    // the internal `endpoint` above (the Docker Compose service name "minio") is meaningless to
    // an actual browser, which has no DNS entry for that hostname — every <img>/download request
    // using it just fails to load. Presigned URLs must instead be built against whatever host the
    // BROWSER can reach MinIO's S3 API on, which is a distinct concern from how the backend
    // reaches it internally. Defaults to the internal endpoint/port so behavior is unchanged for
    // any deployment that hasn't set this — self-hosted deployments proxying MinIO through a
    // public domain, or exposing its S3 port directly, must set this explicitly.
    publicEndpoint: process.env.MINIO_PUBLIC_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? "localhost",
    publicPort: Number(process.env.MINIO_PUBLIC_PORT ?? process.env.MINIO_PORT ?? 9000),
    publicUseSSL: (process.env.MINIO_PUBLIC_USE_SSL ?? process.env.MINIO_USE_SSL) === "true",
  },
};
