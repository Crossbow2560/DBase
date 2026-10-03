// FRONTEND_DESIGN.md §4.3: the ONLY place in the frontend that constructs a request to the
// backend. Every call goes through the reverse proxy (next.config.js) at the same origin, so
// credentials: "include" is enough to carry the httpOnly session cookie — no manual header
// wiring, no cross-origin concerns (§7).

// Mirrors the codes the backend raises (src/modules/*/errors.ts; the full list is in docs/api.md)
// that callers commonly branch on. Unrecognized codes
// still work (ApiError.code is `string`, this union is documentation or by callers, not a
// runtime allowlist) — falling back to a generic toast is the caller's choice, not enforced here.
export type KnownErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "REGISTRATION_FAILED"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_DEACTIVATED"
  | "SESSION_NOT_FOUND"
  | "INVALID_RESET_TOKEN"
  | "EMAIL_NOT_VERIFIED"
  | "INVALID_VERIFICATION_TOKEN"
  | "WEAK_PASSWORD"
  | "QUOTA_EXCEEDED"
  | "SYSTEM_STORAGE_LIMIT_EXCEEDED"
  | "INSUFFICIENT_PERMISSION"
  | "NAME_COLLISION"
  | "PATH_TOO_LONG"
  | "NAME_TOO_LONG"
  | "CYCLE_DETECTED"
  | "PART_TOO_SMALL"
  | "PART_TOO_LARGE"
  | "LENGTH_REQUIRED"
  | "UPLOAD_SESSION_INVALID"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

// Set once by AuthProvider (lib/auth.tsx) on mount — the single 401-handling path §4.3
// requires, rather than duplicating a redirect-to-login at every call site.
let onUnauthenticated: (() => void) | null = null;
export function registerUnauthenticatedHandler(handler: () => void) {
  onUnauthenticated = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = (await response.json().catch(() => null)) as
    | { error: { code: string; message: string } }
    | T
    | null;

  if (!response.ok) {
    const errorBody = body as { error?: { code: string; message: string } } | null;
    const code = errorBody?.error?.code ?? "INTERNAL_ERROR";
    const message = errorBody?.error?.message ?? "Something went wrong.";
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;

    if (code === "UNAUTHENTICATED") {
      onUnauthenticated?.();
    }

    throw new ApiError(response.status, code, message, retryAfterSeconds);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", body: data !== undefined ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "PATCH", body: data !== undefined ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
