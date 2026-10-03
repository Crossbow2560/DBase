import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { AppError } from "./errors.js";
import { resolveSession } from "./service.js";
import type { ItemType } from "../access/permission-check.js";

// The one shared copy of the route preconditions every module's routes.ts used to duplicate
// (APPLICATION_DESIGN.md §3.3's "one shared auth precondition"). Keeping a single definition
// means a fix here can't silently miss one module.

/** Resolves the current session from the cookie, or throws 401. Attach as a preHandler. */
export async function requireSession(request: FastifyRequest) {
  const rawToken = request.cookies[config.sessionCookieName];
  if (!rawToken) throw new AppError(401, "UNAUTHENTICATED", "Login required.");
  const session = await resolveSession(rawToken);
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Session is invalid or has expired.");
  request.session = session;
  request.rawSessionToken = rawToken;
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
