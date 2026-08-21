import { randomBytes, createHash } from "node:crypto";

// Session refresh tokens and password-reset tokens are both high-entropy random values, not
// user-chosen secrets — a fast hash (SHA-256) is the right tool here, unlike passwords, which
// need a slow hash specifically because they're low-entropy/guessable (src/lib/password.ts).
// DESIGN.md §3.2: "Store a hash of the token, never the token itself."

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
