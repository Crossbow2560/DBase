import { createHash } from "node:crypto";
import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { AppError } from "./modules/accounts/errors.js";
import { accountRoutes } from "./modules/accounts/routes.js";
import { filesystemRoutes } from "./modules/filesystem/routes.js";
import { accessRoutes } from "./modules/access/routes.js";
import { trashRoutes } from "./modules/trash/routes.js";
import { organizeRoutes } from "./modules/organize/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { searchRoutes } from "./modules/search/routes.js";
import { startUploadSessionCleanupWorker } from "./workers/upload-session-cleanup.js";
import { startDeletionQueueWorker } from "./workers/deletion-queue.js";
import { startThumbnailQueueWorker } from "./workers/thumbnail-queue.js";

// bodyLimit raised above Fastify's 1MB default: multipart upload part bodies are raw binary,
// up to CHUNK_SIZE_BYTES (5MB, web/lib/uploads.tsx) plus headroom.
const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });

await app.register(cookie);

/**
 * APPLICATION_DESIGN.md §4.7: per-authenticated-user for authenticated endpoints, per-IP for
 * unauthenticated ones. Keys on the session cookie's raw value (hashed), not a fully-resolved
 * user id — deliberately: resolving a session means a DB round trip, and doing that inside the
 * rate-limit check itself (which runs on every single request) would add a query purely for
 * rate-limiting, on top of the one requireSession() already does in each route's own
 * preHandler. A distinct cookie value already buckets distinct sessions/devices 1:1, which is
 * what per-user keying is actually trying to achieve here — an invalid/expired cookie still
 * produces a stable (if meaningless) bucket, which is harmless for this purpose.
 */
function rateLimitKey(request: FastifyRequest): string {
  const rawToken = request.cookies[config.sessionCookieName];
  if (rawToken) {
    return `session:${createHash("sha256").update(rawToken).digest("hex")}`;
  }
  return `ip:${request.ip}`;
}

await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: "1 minute",
  keyGenerator: rateLimitKey,
  // In-process memory, not Postgres (APPLICATION_DESIGN.md §4.7) — the default store, enabled
  // by and consistent with §8.3's single-instance decision; would under-count across multiple
  // processes, which is exactly why multi-instance is out of scope rather than this needing a
  // shared store.
  //
  // Returns an AppError, not a plain object: @fastify/rate-limit's internals `throw` whatever
  // this function returns (node_modules/@fastify/rate-limit/index.js — `throw
  // params.errorResponseBuilder(...)`), rather than sending it as a response body directly. A
  // plain `{ error: {...} }` object thrown this way has no `statusCode`, so it fell through the
  // `error instanceof AppError` check below into the generic 500 branch — a real bug, found by
  // actually triggering the limit and seeing 500 instead of 429 in response. Returning an
  // AppError here routes it through the exact same handling path as every other error in the
  // app, correct status code included.
  errorResponseBuilder: (_request, context) =>
    new AppError(429, "RATE_LIMITED", `Too many requests. Retry after ${context.after}.`),
});

// Multipart upload part bodies (PUT /files/upload-sessions/:id/parts/:n) arrive as raw binary,
// not JSON — Fastify has no built-in parser for this content type, so without registering one
// explicitly the request would be rejected as an unsupported media type before reaching the
// route handler at all.
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, payload, done) => {
  done(null, payload);
});

app.setErrorHandler((error: FastifyError | AppError, _request, reply) => {
  if (error instanceof AppError) {
    reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    return;
  }
  // Fastify's own schema-validation errors carry a statusCode/validation array.
  if (error.validation) {
    reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: error.message } });
    return;
  }
  app.log.error(error);
  reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
});

await app.register(accountRoutes);
await app.register(filesystemRoutes);
await app.register(accessRoutes);
await app.register(trashRoutes);
await app.register(organizeRoutes);
await app.register(adminRoutes);
await app.register(searchRoutes);

app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

startUploadSessionCleanupWorker();
startDeletionQueueWorker();
startThumbnailQueueWorker();
