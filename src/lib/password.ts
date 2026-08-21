import bcrypt from "bcryptjs";

// DESIGN.md §3.1: "hash with a slow algorithm (bcrypt/argon2) at the application layer."
// bcryptjs (pure JS) is used over native bcrypt/argon2 bindings to avoid a native build step.
const SALT_ROUNDS = 12;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

// REQUIREMENTS.md §5.1: "at minimum: 8+ characters" — the exact policy is left as an
// implementation detail; this is the minimum bar stated explicitly in that document.
export function isPasswordStrongEnough(plaintext: string): boolean {
  return plaintext.length >= 8;
}
