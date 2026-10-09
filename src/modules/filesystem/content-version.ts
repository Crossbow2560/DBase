import { createHash } from "node:crypto";

/**
 * An opaque token that changes exactly when a file's content changes, for sync clients' change
 * detection and replace compare-and-swap (supabase/migrations/0029). Derived from storage_key,
 * which is assigned fresh on every upload and replace and never otherwise changes — and hashed,
 * since storage_key itself must never leave the server (DESIGN.md §3.4).
 */
export function contentVersion(storageKey: string): string {
  return createHash("sha256").update(storageKey).digest("hex").slice(0, 32);
}
