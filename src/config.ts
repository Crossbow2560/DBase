import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// The minio SDK's `endPoint` option wants a bare hostname — a full "https://host" throws
// InvalidEndpointError at construction time, an easy mistake since MINIO_PUBLIC_ENDPOINT is
// exactly the kind of value people naturally type as a URL (e.g. a domain fronting MinIO through
// a tunnel/reverse proxy). Stripping the scheme here means that mistake degrades to "SSL setting
// silently inferred from the URL you gave" instead of a crash loop; useSSL below still wins if
// set explicitly.
function parseEndpoint(value: string): { host: string; sslFromScheme?: boolean } {
  const match = value.match(/^(https?):\/\/(.+?)\/?$/i);
  if (!match) return { host: value };
  const [, scheme, host] = match;
  return { host: host!, sslFromScheme: scheme!.toLowerCase() === "https" };
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "dbase_session",
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
  defaultUserQuotaBytes: BigInt(process.env.DEFAULT_USER_QUOTA_BYTES ?? "16106127360"), // 15 GiB
  passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? 30),
  emailVerificationTtlHours: Number(process.env.EMAIL_VERIFICATION_TTL_HOURS ?? 24),
  databaseUrl: requireEnv("DATABASE_URL"),

  // The frontend's own public origin — needed to build a real clickable link in an email (both
  // verification and password reset), as opposed to a bare token. Defaults to this compose
  // topology's local dev address; must be set to the real public domain for any other deployment
  // (same "things that need to change for a non-localhost deployment" category as
  // MINIO_PUBLIC_ENDPOINT — see .env's comment on that one).
  publicAppUrl: (process.env.PUBLIC_APP_URL ?? "http://localhost:3001").replace(/\/$/, ""),

  email: {
    // Left unset in dev by default — sendEmail() (lib/email.ts) falls back to logging the
    // message instead of failing outright, the same non-breaking-default pattern
    // requestPasswordReset() already used before this feature existed. Required for either
    // verification emails or password-reset emails to actually reach anyone.
    resendApiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM ?? "onboarding@resend.dev",

    // Inbound mail (POST /api/v1/email/inbound). RESEND_WEBHOOK_SECRET is the Svix signing
    // secret ("whsec_...") shown when you create the inbound webhook in the Resend dashboard —
    // required for the endpoint to accept anything; left unset, every inbound POST is rejected
    // 401 rather than trusted blindly. inboundAddress is only used to label the admin UI.
    inboundWebhookSecret: process.env.RESEND_WEBHOOK_SECRET,
    inboundAddress: process.env.EMAIL_INBOUND_ADDRESS ?? "dbase@nishit-db.com",
  },

  // DESIGN.md §3.5: an upload session not resumed within this window is abandoned and cleaned
  // up by the background worker (src/workers/upload-session-cleanup.ts).
  uploadSessionTtlMinutes: Number(process.env.UPLOAD_SESSION_TTL_MINUTES ?? 60),

  // REQUIREMENTS.md §5.4: an item is automatically purged 30 days after its own trashing time.
  trashRetentionDays: Number(process.env.TRASH_RETENTION_DAYS ?? 30),

  minio: (() => {
    const endpoint = parseEndpoint(process.env.MINIO_ENDPOINT ?? "localhost");
    // Real bug, found by actually loading a thumbnail in a browser rather than only verifying
    // presigned URLs from inside the Docker network (docker exec): a presigned URL built from
    // the internal `endpoint` above (the Docker Compose service name "minio") is meaningless to
    // an actual browser, which has no DNS entry for that hostname — every <img>/download request
    // using it just fails to load. Presigned URLs must instead be built against whatever host the
    // BROWSER can reach MinIO's S3 API on, which is a distinct concern from how the backend
    // reaches it internally. Defaults to the internal endpoint/port so behavior is unchanged for
    // any deployment that hasn't set this — self-hosted deployments proxying MinIO through a
    // public domain, or exposing its S3 port directly, must set this explicitly.
    const publicEndpoint = parseEndpoint(process.env.MINIO_PUBLIC_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? "localhost");

    return {
      // Defaults match docker-compose.yml's service name/port for the containerized deployment;
      // local (non-Docker) dev overrides via .env to point at a standalone `docker compose up
      // minio` or any other S3-compatible endpoint. This is the endpoint the BACKEND container
      // itself uses to reach MinIO over the Docker-internal network — never handed to a browser.
      endpoint: endpoint.host,
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: process.env.MINIO_USE_SSL != null ? process.env.MINIO_USE_SSL === "true" : (endpoint.sslFromScheme ?? false),
      accessKey: requireEnv("MINIO_ACCESS_KEY"),
      secretKey: requireEnv("MINIO_SECRET_KEY"),
      bucket: process.env.MINIO_BUCKET ?? "dbase",

      publicEndpoint: publicEndpoint.host,
      publicPort: Number(process.env.MINIO_PUBLIC_PORT ?? process.env.MINIO_PORT ?? 9000),
      publicUseSSL:
        process.env.MINIO_PUBLIC_USE_SSL != null
          ? process.env.MINIO_PUBLIC_USE_SSL === "true"
          : process.env.MINIO_USE_SSL != null
            ? process.env.MINIO_USE_SSL === "true"
            : (publicEndpoint.sslFromScheme ?? false),
    };
  })(),
};
