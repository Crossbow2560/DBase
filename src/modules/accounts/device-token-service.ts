import { db } from "../../db.js";
import { generateToken, hashToken } from "../../lib/tokens.js";
import { AppError } from "./errors.js";

// Long-lived bearer tokens for non-browser clients (supabase/migrations/0027). The raw token is
// prefixed so it is recognizable in config files and logs, and so requireSession can tell a
// device token from anything else in an Authorization header without a database lookup.
export const DEVICE_TOKEN_PREFIX = "dbt_";

// last_used_at is informational (shown in the token list), so it is written at most this often
// per token — not once per request, which for a syncing daemon would be most of its traffic.
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

const MAX_ACTIVE_TOKENS_PER_USER = 50;

export const deviceTokenNotFound = () => new AppError(404, "DEVICE_TOKEN_NOT_FOUND", "Device token not found.");
const tooManyDeviceTokens = () =>
  new AppError(409, "TOO_MANY_DEVICE_TOKENS", `At most ${MAX_ACTIVE_TOKENS_PER_USER} active device tokens are allowed.`);

export async function createDeviceToken(userId: string, rawName: string) {
  const name = rawName.trim();
  if (name.length === 0 || name.length > 100) {
    throw new AppError(400, "VALIDATION_ERROR", "name must be 1-100 characters.");
  }
  const active = await db.device_tokens.count({ where: { user_id: userId, revoked_at: null } });
  if (active >= MAX_ACTIVE_TOKENS_PER_USER) throw tooManyDeviceTokens();

  const rawToken = DEVICE_TOKEN_PREFIX + generateToken();
  const row = await db.device_tokens.create({
    data: { user_id: userId, token_hash: hashToken(rawToken), name },
    select: { id: true, name: true, created_at: true },
  });
  return { ...row, token: rawToken };
}

export async function listDeviceTokens(userId: string) {
  return db.device_tokens.findMany({
    where: { user_id: userId, revoked_at: null },
    select: { id: true, name: true, created_at: true, last_used_at: true },
    orderBy: { created_at: "desc" },
  });
}

export async function revokeDeviceToken(userId: string, tokenId: string) {
  const result = await db.device_tokens.updateMany({
    where: { id: tokenId, user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  if (result.count === 0) throw deviceTokenNotFound();
}

/** Revokes the token identified by its raw value (POST /auth/logout from a device). */
export async function revokeDeviceTokenByRaw(rawToken: string) {
  await db.device_tokens.updateMany({
    where: { token_hash: hashToken(rawToken), revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

/** Revokes every device token a user holds — password change/reset and deactivation. */
export function revokeAllDeviceTokens(userId: string) {
  return db.device_tokens.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

/**
 * Resolves a raw device token to its row and user, or null if it is unknown, revoked, or belongs
 * to a deactivated account — the same rules resolveSession (service.ts) applies to cookies.
 */
export async function resolveDeviceToken(rawToken: string) {
  const token = await db.device_tokens.findUnique({
    where: { token_hash: hashToken(rawToken) },
    include: { user: true },
  });
  if (!token || token.revoked_at !== null || !token.user.is_active) return null;

  const now = Date.now();
  if (!token.last_used_at || now - token.last_used_at.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    // Best-effort; never fail the request over a bookkeeping write.
    await db.device_tokens
      .update({ where: { id: token.id }, data: { last_used_at: new Date(now) } })
      .catch(() => undefined);
  }
  return token;
}
