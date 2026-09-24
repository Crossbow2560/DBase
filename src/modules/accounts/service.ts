import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { hashPassword, verifyPassword, isPasswordStrongEnough } from "../../lib/password.js";
import { generateToken, hashToken } from "../../lib/tokens.js";
import { sendEmail } from "../../lib/email.js";
import { renderEmailLayout } from "../../lib/emailTemplate.js";
import {
  registrationFailed,
  invalidCredentials,
  accountDeactivated,
  sessionNotFound,
  invalidResetToken,
  weakPassword,
  userNotFoundByEmail,
  emailNotVerified,
  invalidVerificationToken,
  registrationClosed,
  verificationStorageFull,
} from "./errors.js";

const POSTGRES_UNIQUE_VIOLATION = "P2002";

/**
 * Sends (or re-sends) a verification link — shared by register() and resendVerificationEmail()
 * so both go through the exact same token-issuance and email-content path.
 */
async function sendVerificationEmail(user: { id: string; email: string; display_name: string }): Promise<void> {
  const rawToken = generateToken();
  const expiresAt = new Date(Date.now() + config.emailVerificationTtlHours * 60 * 60 * 1000);

  await db.email_verification_tokens.create({
    data: { user_id: user.id, token_hash: hashToken(rawToken), expires_at: expiresAt },
  });

  const verifyUrl = `${config.publicAppUrl}/verify-email?token=${encodeURIComponent(rawToken)}`;
  await sendEmail(
    user.email,
    "Verify your email address",
    renderEmailLayout({
      heading: `Hi ${user.display_name}, confirm your email`,
      bodyHtml: `<p>Confirm this is your email address to finish setting up your DBase account. This link expires in ${config.emailVerificationTtlHours} hours.</p>`,
      buttonLabel: "Verify email address",
      buttonUrl: verifyUrl,
    }),
  );
}

/**
 * REQUIREMENTS.md §5.1 originally deferred email verification — added on direct request: a new
 * account starts with email_verified=false and login() (below) refuses to issue a session until
 * the registrant actually clicks the link this sends, closing the "anyone can type a made-up
 * email at signup" gap.
 */
export async function register(input: {
  email: string;
  password: string;
  displayName: string;
}) {
  if (!isPasswordStrongEnough(input.password)) {
    throw weakPassword();
  }

  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await db.users.create({
      data: {
        email: input.email,
        password_hash: passwordHash,
        display_name: input.displayName,
        storage_quota_bytes: config.defaultUserQuotaBytes,
        // role is never accepted from the client — admin is never self-grantable
        // (REQUIREMENTS.md §5.1). The column default ('user') applies. email_verified's column
        // default (false) applies too — verification-blocks-login is the point of this feature.
      },
      select: { id: true, email: true, display_name: true, created_at: true },
    });
  } catch (err) {
    // supabase/migrations/0022_preallocate_user_quotas.sql: the insert is refused once verified
    // accounts' quotas leave too little unallocated space for this one's (it's only actually
    // allocated at verification, see verifyEmail()). That BEFORE INSERT trigger fires ahead of the unique
    // check, so an unverified retry (below) can surface as this error too — it's routed through
    // the same existing-row lookup, since updating that row in place allocates nothing new.
    const allocationExceeded = err instanceof Error && err.message.includes("SYSTEM_STORAGE_ALLOCATION_EXCEEDED");
    const uniqueViolation =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION;
    if (allocationExceeded || uniqueViolation) {
      // Real bug, reported directly: an account that never got past verification (email
      // provider hiccup, the registrant mistyped and never received the link, they just
      // abandoned the tab) permanently squatted its own email address — every retry hit this
      // same unique-violation branch and rejected as REGISTRATION_FAILED, with no way back in
      // except knowing to use the separate "resend verification" action instead of just
      // registering again, which is what anyone would naturally try first. An unverified row has
      // no one who could have legitimately claimed it yet (nobody's proven control of the email),
      // so a second registration attempt against it is just treated as that same person retrying
      // — the row is updated in place with the newly submitted password/name and a fresh
      // verification email goes out, rather than being rejected. Only a row that's already
      // email_verified is a genuine duplicate.
      const existing = await db.users.findUnique({ where: { email: input.email } });
      if (!existing || existing.email_verified) {
        // Non-enumerating: when the system is full every non-retry attempt gets the same
        // "closed" error regardless of the email; otherwise the same generic error as any other
        // registration failure.
        throw allocationExceeded ? registrationClosed() : registrationFailed();
      }
      user = await db.users.update({
        where: { id: existing.id },
        data: { password_hash: passwordHash, display_name: input.displayName },
        select: { id: true, email: true, display_name: true, created_at: true },
      });
    } else {
      throw err;
    }
  }

  await sendVerificationEmail(user);
  return user;
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

  // Checked after the password (never before) — a wrong-password attempt against an unverified
  // account must still look identical to a wrong-password attempt against a verified one.
  if (!user.email_verified) {
    throw emailNotVerified();
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

export async function verifyEmail(rawToken: string): Promise<void> {
  const tokenRow = await db.email_verification_tokens.findUnique({ where: { token_hash: hashToken(rawToken) } });
  if (!tokenRow || tokenRow.used_at !== null || tokenRow.expires_at < new Date()) {
    throw invalidVerificationToken();
  }

  try {
    await db.$transaction([
      db.users.update({ where: { id: tokenRow.user_id }, data: { email_verified: true } }),
      db.email_verification_tokens.update({ where: { id: tokenRow.id }, data: { used_at: new Date() } }),
    ]);
  } catch (err) {
    // supabase/migrations/0022_preallocate_user_quotas.sql allocates the quota at this point.
    if (err instanceof Error && err.message.includes("SYSTEM_STORAGE_ALLOCATION_EXCEEDED")) {
      throw verificationStorageFull();
    }
    throw err;
  }
}

/** Non-enumerating, same as requestPasswordReset below — always behaves identically either way. */
export async function resendVerificationEmail(email: string): Promise<void> {
  const user = await db.users.findUnique({ where: { email } });
  if (!user || user.email_verified) return;
  await sendVerificationEmail(user);
}

/** Display name only — email is intentionally not editable here (changing it would need its own re-verification flow, same as registration's, which isn't built). */
export async function updateProfile(userId: string, updates: { displayName?: string }) {
  const user = await db.users.update({
    where: { id: userId },
    data: { display_name: updates.displayName },
    select: { id: true, email: true, display_name: true, role: true },
  });
  return { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
}

/**
 * Change password for an already-authenticated user — distinct from confirmPasswordReset's
 * forgot-password flow (that one has no current password to check, and signs every session out
 * everywhere since a reset implies the account may have been compromised). Here the requester has
 * just proven their current password, so only every *other* session is revoked — the one making
 * this request stays alive, same as most account-settings pages (Google, GitHub, etc.) do.
 */
export async function changePassword(
  userId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string,
) {
  const user = await db.users.findUniqueOrThrow({ where: { id: userId } });

  const passwordMatches = await verifyPassword(currentPassword, user.password_hash);
  if (!passwordMatches) throw invalidCredentials();

  if (!isPasswordStrongEnough(newPassword)) throw weakPassword();

  const newPasswordHash = await hashPassword(newPassword);

  await db.$transaction([
    db.users.update({ where: { id: userId }, data: { password_hash: newPasswordHash } }),
    db.sessions.updateMany({
      where: { user_id: userId, revoked_at: null, id: { not: currentSessionId } },
      data: { revoked_at: new Date() },
    }),
  ]);
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

type BreakdownRow = { category: "images" | "videos" | "documents"; bytes: bigint | null };

/**
 * Storage Capacity card's donut breakdown — every one of this user's own live files falls into
 * exactly one of these three buckets (no separate "other" catch-all), so the segments always sum
 * to the user's full storage_used_bytes. "Documents" is deliberately the catch-all for anything
 * that isn't image/video, not just office formats — matches how the reference design's three
 * categories read (a general one plus the two media-heavy ones users actually care to see split
 * out), without needing a longer, harder-to-maintain mime-type allowlist.
 */
function rowsToBreakdown(rows: BreakdownRow[]) {
  const byCategory: Record<string, string> = { documents: "0", images: "0", videos: "0" };
  for (const row of rows) {
    byCategory[row.category] = (row.bytes ?? 0n).toString();
  }
  return {
    categories: [
      { category: "documents" as const, bytes: byCategory.documents },
      { category: "images" as const, bytes: byCategory.images },
      { category: "videos" as const, bytes: byCategory.videos },
    ],
  };
}

export async function getStorageBreakdown(userId: string) {
  const rows = await db.$queryRaw<BreakdownRow[]>`
    SELECT
      CASE
        WHEN mime_type LIKE 'image/%' THEN 'images'
        WHEN mime_type LIKE 'video/%' THEN 'videos'
        ELSE 'documents'
      END AS category,
      SUM(size_bytes) AS bytes
    FROM files
    WHERE owner_id = ${userId}::uuid AND deleted_at IS NULL AND upload_status = 'complete'
    GROUP BY category
  `;
  return rowsToBreakdown(rows);
}

/** Same breakdown as getStorageBreakdown above, but system-wide (no owner_id filter) — backs
 * the admin stats page's system-wide donut, the same MultiRingChart the per-user Storage
 * Capacity card uses, just scoped to every user's files instead of one. */
export async function getSystemStorageBreakdown() {
  const rows = await db.$queryRaw<BreakdownRow[]>`
    SELECT
      CASE
        WHEN mime_type LIKE 'image/%' THEN 'images'
        WHEN mime_type LIKE 'video/%' THEN 'videos'
        ELSE 'documents'
      END AS category,
      SUM(size_bytes) AS bytes
    FROM files
    WHERE deleted_at IS NULL AND upload_status = 'complete'
    GROUP BY category
  `;
  return rowsToBreakdown(rows);
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

  const resetUrl = `${config.publicAppUrl}/password-reset/confirm?token=${encodeURIComponent(rawToken)}`;
  await sendEmail(
    email,
    "Reset your password",
    renderEmailLayout({
      heading: `Hi ${user.display_name}, reset your password`,
      bodyHtml: `<p>Someone requested a password reset for this account. If that was you, choose a new password using the button below. This link expires in ${config.passwordResetTtlMinutes} minutes.</p>`,
      buttonLabel: "Reset password",
      buttonUrl: resetUrl,
    }),
  );
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
