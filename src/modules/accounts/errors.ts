export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// REQUIREMENTS.md §5.1: rejecting a duplicate-email registration "without confirming or
// denying whether that email belongs to an existing account" — the same generic error is used
// for any other registration failure too, so an attacker can't distinguish "email taken" from
// "something else went wrong" by message alone.
export const registrationFailed = () =>
  new AppError(400, "REGISTRATION_FAILED", "Unable to complete registration.");

export const invalidCredentials = () =>
  new AppError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");

export const accountDeactivated = () =>
  new AppError(403, "ACCOUNT_DEACTIVATED", "This account has been deactivated.");

export const sessionNotFound = () =>
  new AppError(404, "SESSION_NOT_FOUND", "Session not found.");

export const invalidResetToken = () =>
  new AppError(400, "INVALID_RESET_TOKEN", "This password reset link is invalid or has expired.");

export const weakPassword = () =>
  new AppError(400, "WEAK_PASSWORD", "Password must be at least 8 characters.");

export const userNotFoundByEmail = () =>
  new AppError(404, "NOT_FOUND", "No account found with that email address.");

export const emailNotVerified = () =>
  new AppError(403, "EMAIL_NOT_VERIFIED", "Please verify your email address before logging in.");

export const invalidVerificationToken = () =>
  new AppError(400, "INVALID_VERIFICATION_TOKEN", "This verification link is invalid or has expired.");
