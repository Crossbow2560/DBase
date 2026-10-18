import { setTimeout as sleep } from "node:timers/promises";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Role = "owner" | "editor" | "viewer";

export interface RemoteItem {
  kind: "file" | "folder";
  id: string;
  parentId: string;
  name: string;
  size: string | null;
  checksum: string | null;
  version: string | null;
}

export interface TreePage {
  root: { id: string; name: string; role: Role };
  cursor: string;
  items: RemoteItem[];
  nextAfter: string | null;
}

export interface SyncEvent {
  seq: string;
  kind: "create" | "update" | "move" | "move_in" | "move_out" | "trash" | "restore" | "purge";
  itemType: "file" | "folder";
  itemId: string;
  name: string;
  parentId: string | null;
  prevParentId: string | null;
  size: string | null;
  checksum: string | null;
  version: string | null;
}

export interface ChangesPage {
  root: { id: string; role: Role };
  events: SyncEvent[];
  cursor: string;
  hasMore: boolean;
}

export interface UploadedFile {
  id: string;
  name: string;
  size_bytes: string;
  checksum: string | null;
  version: string;
}

const MAX_ATTEMPTS = 6;

/**
 * A small typed client for the DBase API. Authenticates with a device token (or, for the login
 * flow only, a session cookie). Retries what's safe to retry — network errors, 429 (honouring
 * Retry-After) and 5xx — with exponential backoff; every call it makes is idempotent or guarded
 * server-side (upload parts and completion are both idempotent).
 */
export class Api {
  constructor(
    readonly server: string,
    private readonly auth: { token?: string; cookie?: string } = {},
  ) {
    this.server = server.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.auth.token) h.authorization = `Bearer ${this.auth.token}`;
    if (this.auth.cookie) h.cookie = this.auth.cookie;
    return h;
  }

  async raw(method: string, path: string, init: { body?: unknown; bytes?: Uint8Array } = {}): Promise<Response> {
    let delay = 500;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.server}/api/v1${path}`, {
          method,
          headers: this.headers(
            init.bytes
              ? { "content-type": "application/octet-stream" }
              : init.body !== undefined
                ? { "content-type": "application/json" }
                : {},
          ),
          body: init.bytes ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err;
        await sleep(delay);
        delay *= 2;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await res.body?.cancel();
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay);
        delay *= 2;
        continue;
      }
      return res;
    }
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, { body });
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // --- auth -----------------------------------------------------------------------------------

  /** Logs in with a password; returns the session Cookie header value. */
  async login(email: string, password: string): Promise<string> {
    const res = await this.raw("POST", "/auth/login", { body: { email, password } });
    if (!res.ok) throw await toError(res);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.includes("="));
    if (!cookie) throw new ApiError(500, "NO_SESSION", "Login succeeded but returned no session cookie.");
    return cookie;
  }

  createDeviceToken(name: string) {
    return this.json<{ deviceToken: { id: string; token: string } }>("POST", "/auth/device-tokens", { name });
  }

  logout() {
    return this.json<void>("POST", "/auth/logout");
  }

  me() {
    return this.json<{ user: { id: string; email: string; displayName: string } }>("GET", "/auth/me");
  }

  // --- folders --------------------------------------------------------------------------------

  folderContents(folderId: string | null) {
    return this.json<{ items: { id: string; name: string; type: "file" | "folder" }[] }>(
      "GET",
      folderId ? `/folders/${folderId}/contents` : "/folders/contents",
    );
  }

  createFolder(name: string, parentFolderId: string | null) {
    return this.json<{ folder: { id: string; name: string } }>("POST", "/folders", { name, parentFolderId });
  }

  // --- sync -----------------------------------------------------------------------------------

  tree(root: string, after: string | null) {
    return this.json<TreePage>("GET", `/sync/tree?root=${root}${after ? `&after=${after}` : ""}`);
  }

  changes(root: string, cursor: string) {
    return this.json<ChangesPage>("GET", `/sync/changes?root=${root}&cursor=${cursor}`);
  }

  downloadUrls(fileIds: string[]) {
    return this.json<{ urls: { id: string; url: string; size: string; checksum: string | null; version: string }[]; unavailable: string[] }>(
      "POST",
      "/sync/download-urls",
      { fileIds },
    );
  }

  batch(ops: { type: "file" | "folder"; id: string; name?: string; parentId?: string | null }[]) {
    return this.json<{ results: { id: string; ok: boolean; error?: { code: string; message: string } }[] }>(
      "POST",
      "/sync/batch",
      { ops },
    );
  }

  // --- uploads --------------------------------------------------------------------------------

  initUpload(body: {
    targetName?: string;
    targetFolderId?: string | null;
    totalParts: number;
    replaceFileId?: string;
    expectedVersion?: string;
    checksum: string;
  }) {
    return this.json<{ uploadSessionId: string; expiresAt: string }>("POST", "/files", body);
  }

  async putPart(sessionId: string, partNumber: number, bytes: Uint8Array): Promise<void> {
    const res = await this.raw("PUT", `/files/upload-sessions/${sessionId}/parts/${partNumber}`, { bytes });
    if (!res.ok) throw await toError(res);
    await res.body?.cancel();
  }

  completeUpload(sessionId: string, mimeType?: string) {
    return this.json<{ file: UploadedFile }>(
      "POST",
      `/files/upload-sessions/${sessionId}/complete`,
      mimeType ? { mimeType } : {},
    );
  }

  async cancelUpload(sessionId: string): Promise<void> {
    await this.json<void>("DELETE", `/files/upload-sessions/${sessionId}`).catch(() => undefined);
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(res.status, body.error?.code ?? `HTTP_${res.status}`, body.error?.message ?? res.statusText);
  } catch {
    return new ApiError(res.status, `HTTP_${res.status}`, res.statusText);
  }
}
