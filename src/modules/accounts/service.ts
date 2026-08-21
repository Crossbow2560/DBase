import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { hashPassword, verifyPassword, isPasswordStrongEnough } from "../../lib/password.js";
import { generateToken, hashToken } from "../../lib/tokens.js";
import {
  registrationFailed,
  invalidCredentials,
  accountDeactivated,
  sessionNotFound,
  invalidResetToken,
  weakPassword,
  userNotFoundByEmail,
} from "./errors.js";

const POSTGRES_UNIQUE_VIOLATION = "P2002";

export async function register(input: {
  email: string;
  password: string;
  displayName: string;
}) {
  if (!isPasswordStrongEnough(input.password)) {
    throw weakPassword();
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await db.users.create({
      data: {
        email: input.email,
        password_hash: passwordHash,
        display_name: input.displayName,
        storage_quota_bytes: config.defaultUserQuotaBytes,
        // role is never accepted from the client — admin is never self-grantable
        // (REQUIREMENTS.md §5.1). The column default ('user') applies.
      },
      select: { id: true, email: true, display_name: true, created_at: true },
    });
    return user;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION) {
      // Non-enumerating: same generic error as any other registration failure.
      throw registrationFailed();
    }
    throw err;
  }
}

export async function login(input: { email: string; password: string; deviceInfo?: string }) {
  const user = await db.users.findUnique({ where: { email: input.email } });
  if (!user) {
    throw invalidCredentials();
  }

  const passwordMatches = await verifyPassword(input.password, user.password_hash);
  if (!passwordMatches) {
    throw invalidCredentials();
  }

  if (!user.is_active) {
    throw accountDeactivated();
  }

  const rawToken = generateToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);

  const session = await db.sessions.create({
    data: {
      user_id: user.id,
      refresh_token_hash: hashToken(rawToken),
      device_info: input.deviceInfo,
      expires_at: expiresAt,
    },
  });

  return {
    rawToken,
    expiresAt,
    user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
    sessionId: session.id,
  };
}

/** Resolves a raw session token (from the cookie) to its owning user, or null if invalid. */
export async function resolveSession(rawToken: string) {
  const session = await db.sessions.findUnique({
    where: { refresh_token_hash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!session || session.revoked_at !== null || session.expires_at < new Date()) {
    return null;
  }
  // REQUIREMENTS.md §5.1: a deactivated account "cannot log back in" — an already-issued
  // session must also stop working immediately, not just future login attempts.
  if (!session.user.is_active) {
    return null;
  }

  return session;
}

/** Revokes exactly the session identified by this raw token (used by logout — "current device only"). */
export async function logout(rawToken: string) {
  await db.sessions.updateMany({
    where: { refresh_token_hash: hashToken(rawToken), revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

export async function listSessions(userId: string) {
  return db.sessions.findMany({
    where: { user_id: userId, revoked_at: null, expires_at: { gt: new Date() } },
    select: { id: true, device_info: true, created_at: true, expires_at: true },
    orderBy: { created_at: "desc" },
  });
}

/** Revokes a specific session by id — must belong to the requesting user. */
export async function revokeSession(userId: string, sessionId: string) {
  const result = await db.sessions.updateMany({
    where: { id: sessionId, user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  if (result.count === 0) {
    throw sessionNotFound();
  }
}

/**
 * Resolves an email to a user id for the sharing flow (access module's grant-by-email UI) —
 * there was previously no way for a client to turn "share with alice@example.com" into the
 * userId POST /items/:type/:id/permissions actually requires. Deliberately not subject to
 * REQUIREMENTS.md §5.1's registration non-enumeration concern: that rule is about not letting an
 * attacker probe which emails are registered via the *signup* flow; a sharing flow inherently
 * needs to tell the sharer whether the person they're trying to share with has an account, the
 * same way Google Drive or any other collaboration tool does.
 */
export async function lookupUserByEmail(email: string) {
  const user = await db.users.findUnique({ where: { email }, select: { id: true, email: true, display_name: true } });
  if (!user) throw userNotFoundByEmail();
  return { id: user.id, email: user.email, displayName: user.display_name };
}

export async function getStorageUsage(userId: string) {
  const user = await db.users.findUniqueOrThrow({
    where: { id: userId },
    select: { storage_used_bytes: true, storage_quota_bytes: true },
  });
  return {
    storageUsedBytes: user.storage_used_bytes.toString(),
    storageQuotaBytes: user.storage_quota_bytes.toString(),
  };
}

export async function requestPasswordReset(email: string) {
  const user = await db.users.findUnique({ where: { email } });
  // Non-enumerating: always behave identically regardless of whether the email exists.
  if (!user) {
    return;
  }

  const rawToken = generateToken();
  const expiresAt = new Date(Date.now() + config.passwordResetTtlMinutes * 60 * 1000);

  await db.password_reset_tokens.create({
    data: { user_id: user.id, token_hash: hashToken(rawToken), expires_at: expiresAt },
  });

  // TODO: wire a real email provider. For now, the reset link is logged so the flow is
  // exercisable end-to-end in development.
  console.log(`[password-reset] token for ${email}: ${rawToken} (expires ${expiresAt.toISOString()})`);
}

export async function confirmPasswordReset(rawToken: string, newPassword: string) {
  if (!isPasswordStrongEnough(newPassword)) {
    throw weakPassword();
  }

  const tokenRow = await db.password_reset_tokens.findUnique({
    where: { token_hash: hashToken(rawToken) },
  });

  if (!tokenRow || tokenRow.used_at !== null || tokenRow.expires_at < new Date()) {
    throw invalidResetToken();
  }

  const newPasswordHash = await hashPassword(newPassword);

  await db.$transaction([
    db.users.update({
      where: { id: tokenRow.user_id },
      data: { password_hash: newPasswordHash },
    }),
    db.password_reset_tokens.update({
      where: { id: tokenRow.id },
      data: { used_at: new Date() },
    }),
    // APPLICATION_DESIGN.md §4.2: "Invalidates all existing sessions for that user on success
    // (a password reset is a reasonable signal to force re-login everywhere)."
    db.sessions.updateMany({
      where: { user_id: tokenRow.user_id, revoked_at: null },
      data: { revoked_at: new Date() },
    }),
  ]);
}
