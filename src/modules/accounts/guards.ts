import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { AppError } from "./errors.js";
import { resolveSession } from "./service.js";
import { DEVICE_TOKEN_PREFIX, resolveDeviceToken } from "./device-token-service.js";
import type { ItemType } from "../access/permission-check.js";

// The one shared copy of the route preconditions every module's routes.ts used to duplicate
// (APPLICATION_DESIGN.md §3.3's "one shared auth precondition"). Keeping a single definition
// means a fix here can't silently miss one module.

/** The raw device token from `Authorization: Bearer dbt_…`, or null if there isn't one. */
export function bearerDeviceToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match || !match[1]!.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  return match[1]!;
}

/**
 * Resolves the caller from a device token (Authorization header) or the session cookie, or throws
 * 401. Attach as a preHandler. A device token takes precedence: a client that sends one means it,
 * and the CLI never holds a cookie anyway.
 */
export async function requireSession(request: FastifyRequest) {
  const deviceToken = bearerDeviceToken(request);
  if (deviceToken) {
    const token = await resolveDeviceToken(deviceToken);
    if (!token) throw new AppError(401, "UNAUTHENTICATED", "Device token is invalid or has been revoked.");
    request.session = { id: token.id, user_id: token.user_id, user: token.user, kind: "device" };
    request.rawDeviceToken = deviceToken;
    return;
  }

  const rawToken = request.cookies[config.sessionCookieName];
  if (!rawToken) throw new AppError(401, "UNAUTHENTICATED", "Login required.");
  const session = await resolveSession(rawToken);
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Session is invalid or has expired.");
  request.session = { id: session.id, user_id: session.user_id, user: session.user, kind: "cookie" };
  request.rawSessionToken = rawToken;
}

/**
 * requireSession, restricted to a browser login. For credential-management routes — minting a
 * device token, changing the password — so a leaked device token can't be escalated into more
 * tokens or a takeover of the account.
 */
export async function requireCookieSession(request: FastifyRequest) {
  await requireSession(request);
  if (request.session!.kind !== "cookie") {
    throw new AppError(403, "COOKIE_SESSION_REQUIRED", "This action requires a browser login, not a device token.");
  }
}

/**
 * requireSession for routes that opt out of the per-IP ceiling (config.ipCeiling =
 * "auth-failures-only" — upload parts): a request that fails authentication still counts against
 * the ceiling, so made-up cookies can't be used to hammer the route, while authenticated part
 * uploads don't consume it at all.
 */
export async function requireSessionCountingFailures(request: FastifyRequest, reply: FastifyReply) {
  try {
    await requireSession(request);
  } catch (err) {
    await request.server.enforceIpCeiling(request, reply);
    throw err;
  }
}

/**
 * DESIGN.md §4.2: the admin bypass inside checkPermission() governs item-level access; this is
 * the separate, coarser gate on the admin API surface itself.
 */
export async function requireAdmin(request: FastifyRequest) {
  await requireSession(request);
  if (request.session!.user.role !== "admin") {
    throw new AppError(403, "INSUFFICIENT_PERMISSION", "Admin access required.");
  }
}

export function parseItemType(raw: string): ItemType {
  if (raw !== "file" && raw !== "folder") {
    throw new AppError(400, "VALIDATION_ERROR", "type must be 'file' or 'folder'.");
  }
  return raw;
}

// APPLICATION_DESIGN.md §4.7: folder/file create, move, delete are the "write-heavy" class — a
// tighter bound than the general authenticated default (300/min, server.ts).
export const writeHeavyRateLimit = {
  config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
} as const;

// Sync clients (modules/sync): one batch carries up to 100 moves/renames, so 30 batches a minute
// is far more write throughput than writeHeavyRateLimit's 60 single ops — without lifting the
// per-op bound for everything else. Download URLs are read-only and come 200 to a request.
export const syncBatchRateLimit = {
  config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
} as const;

export const syncDownloadRateLimit = {
  config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
} as const;

// Excluded from the per-minute counters: upload parts (bounded by the upload session itself) and
// slow streamed zip responses (bounded by the folder's own contents).
export const noRateLimit = { config: { rateLimit: false } } as const;

const ipKey = (request: FastifyRequest) => `ip:${request.ip}`;

// Public (no-session) endpoints — share-link access and the inbound-mail webhook. Keyed on the
// client IP explicitly rather than the global cookie-or-IP key, for the same reason as the IP
// ceiling in app.ts: these callers have no session, so a cookie value would be attacker-chosen.
export const publicRateLimit = {
  config: { rateLimit: { max: 300, timeWindow: "1 minute", keyGenerator: ipKey } },
} as const;

// Public folder zips stream an entire shared subtree per request — cheap to ask for, expensive to
// serve — so they get a much tighter per-IP bound than other public routes.
export const publicZipRateLimit = {
  config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: ipKey } },
} as const;

// APPLICATION_DESIGN.md §4.7: register/login/password-reset-request are the unauthenticated
// endpoint class — 20 req/15min, keyed on source IP (there's no session cookie to key on yet).
export const unauthenticatedRateLimit = {
  config: {
    rateLimit: {
      max: 20,
      timeWindow: "15 minutes",
      keyGenerator: ipKey,
    },
  },
} as const;
