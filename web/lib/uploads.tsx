"use client";

// FRONTEND_DESIGN.md §8 item 2, resolved by owner decision: a bottom-right toast tray with
// pause/resume/cancel per upload. Drives the real multipart upload endpoints APPLICATION_DESIGN.md
// §4.3 documents (POST /files, PUT .../parts/:n, POST .../complete, DELETE upload-sessions/:id) —
// none of which the backend has implemented yet (Subcomponent 1), so every upload attempted
// against this scaffold will surface a real error from the 404, not a faked progress bar. That's
// deliberate: this module is honest about what it can't do yet rather than simulating success.
//
// The persisted-upload-session-id-in-localStorage note from §6.1 is implemented here: each
// task's server-assigned uploadSessionId (once known) is written to localStorage keyed by a
// client-generated task id, so a page refresh mid-upload can, in principle, rediscover it. The
// actual "rediscover and offer to resume across a refresh" flow is not wired up yet — this
// module persists the id but doesn't yet read it back on mount. Flagged, not silently assumed
// done.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";
import { queryKeys } from "./query-keys";

const CHUNK_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const STORAGE_KEY_PREFIX = "dbase:upload-session:";

// A drag-and-drop of a whole folder can hand us dozens of files at once. Firing every one's
// init + parts + complete immediately buries the backend's per-user write-rate limit
// (APPLICATION_DESIGN.md §4.7 — 60 write requests/min) and turns a genuine bulk upload into a
// wall of 429s. Cap how many run at once and queue the rest; combined with
// fetchWithRateLimitRetry() below (which honors the server's Retry-After on the 429s that still
// slip through), an 87-file drop drains as a steady trickle instead of a burst.
const MAX_CONCURRENT_UPLOADS = 3;
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_FALLBACK_DELAY_MS = 5000;

export type UploadStatus = "queued" | "uploading" | "paused" | "error" | "complete" | "canceled";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries a request when the backend replies 429 RATE_LIMITED, waiting the server-specified
// Retry-After (plus a little jitter so a batch of queued uploads doesn't retry in lockstep)
// before trying again. Any other response — ok or not — is handed back to the caller untouched.
// Stops early once `shouldAbort()` turns true (the task was paused or canceled mid-wait).
async function fetchWithRateLimitRetry(
  input: string,
  init: RequestInit,
  shouldAbort: () => boolean,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= RATE_LIMIT_MAX_RETRIES || shouldAbort()) {
      return res;
    }
    const retryAfterSeconds = Number(res.headers.get("Retry-After"));
    const baseMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : RATE_LIMIT_FALLBACK_DELAY_MS;
    await delay(baseMs + Math.random() * 1000);
  }
}

export interface UploadTask {
  id: string;
  fileName: string;
  folderId: string | null;
  totalBytes: number;
  uploadedBytes: number;
  status: UploadStatus;
  error?: string;
}

interface UploadControls {
  uploads: UploadTask[];
  startUpload: (file: File, folderId: string | null) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
}

const UploadContext = React.createContext<UploadControls | null>(null);

interface InternalTaskState {
  task: UploadTask;
  file: File;
  uploadSessionId: string | null;
  nextPartNumber: number;
  pauseRequested: boolean;
}

async function abortSessionOnServer(uploadSessionId: string) {
  await fetch(`/api/v1/files/upload-sessions/${uploadSessionId}`, {
    method: "DELETE",
    credentials: "include",
  }).catch(() => undefined);
}

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const [uploads, setUploads] = React.useState<UploadTask[]>([]);
  const internalRef = React.useRef<Map<string, InternalTaskState>>(new Map());
  // Task ids waiting for a concurrency slot, and how many loops are running right now.
  const queueRef = React.useRef<string[]>([]);
  const activeCountRef = React.useRef(0);
  const queryClient = useQueryClient();

  function updateTask(id: string, patch: Partial<UploadTask>) {
    setUploads((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    const internal = internalRef.current.get(id);
    if (internal) internal.task = { ...internal.task, ...patch };
  }

  async function runUploadLoop(id: string) {
    const internal = internalRef.current.get(id);
    if (!internal) return;

    try {
      // Init the session on first run.
      if (!internal.uploadSessionId) {
        const totalParts = Math.max(1, Math.ceil(internal.file.size / CHUNK_SIZE_BYTES));
        const res = await fetchWithRateLimitRetry(
          "/api/v1/files",
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetFolderId: internal.task.folderId,
              targetName: internal.file.name,
              totalParts,
            }),
          },
          () => internal.pauseRequested,
        );
        if (internal.pauseRequested) {
          // cancel() also sets pauseRequested; don't overwrite the "canceled" it left behind.
          if (internal.task.status !== "canceled") updateTask(id, { status: "paused" });
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new ApiError(res.status, body?.error?.code ?? "INTERNAL_ERROR", body?.error?.message ?? "Could not start upload.");
        }
        const { uploadSessionId } = (await res.json()) as { uploadSessionId: string };
        internal.uploadSessionId = uploadSessionId;
        window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${id}`, uploadSessionId);
      }

      while (internal.nextPartNumber * CHUNK_SIZE_BYTES < internal.file.size || internal.nextPartNumber === 0) {
        if (internal.pauseRequested) {
          // cancel() also sets pauseRequested; don't overwrite the "canceled" it left behind.
          if (internal.task.status !== "canceled") updateTask(id, { status: "paused" });
          return;
        }

        const start = internal.nextPartNumber * CHUNK_SIZE_BYTES;
        const end = Math.min(start + CHUNK_SIZE_BYTES, internal.file.size);
        const chunk = internal.file.slice(start, end);

        const res = await fetchWithRateLimitRetry(
          `/api/v1/files/upload-sessions/${internal.uploadSessionId}/parts/${internal.nextPartNumber}`,
          {
            method: "PUT",
            credentials: "include",
            // Explicit, rather than relying on the browser's default for a Blob with no `type`
            // (often omitted entirely) — the backend registers a parser keyed on this exact
            // content type for raw binary bodies (src/server.ts).
            headers: { "Content-Type": "application/octet-stream" },
            body: chunk,
          },
          () => internal.pauseRequested,
        );
        if (internal.pauseRequested) {
          // cancel() also sets pauseRequested; don't overwrite the "canceled" it left behind.
          if (internal.task.status !== "canceled") updateTask(id, { status: "paused" });
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new ApiError(res.status, body?.error?.code ?? "INTERNAL_ERROR", body?.error?.message ?? "Upload failed.");
        }

        internal.nextPartNumber += 1;
        updateTask(id, { uploadedBytes: end });

        if (end >= internal.file.size) break;
      }

      const completeRes = await fetchWithRateLimitRetry(
        `/api/v1/files/upload-sessions/${internal.uploadSessionId}/complete`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mimeType: internal.file.type || "application/octet-stream" }),
        },
        () => internal.pauseRequested,
      );
      if (!completeRes.ok) {
        const body = await completeRes.json().catch(() => null);
        throw new ApiError(completeRes.status, body?.error?.code ?? "INTERNAL_ERROR", body?.error?.message ?? "Could not finalize upload.");
      }

      window.localStorage.removeItem(`${STORAGE_KEY_PREFIX}${id}`);
      updateTask(id, { status: "complete", uploadedBytes: internal.file.size });
      queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage() });
      // Was missing entirely — completion only ever refreshed the quota indicator, never the
      // folder listing itself, so a newly-uploaded file didn't show up anywhere (/home,
      // /folders, or the target subfolder) until some unrelated action happened to refetch it.
      queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(internal.task.folderId) });
    } catch (err) {
      // A failure here (network error, a later part rejected for quota, destination no longer
      // valid, etc.) can land after earlier parts already succeeded and had their bytes credited
      // against the user's quota server-side. Without explicitly aborting, that credited quota
      // would sit "used" against an upload that never completes until the session's TTL-based
      // cleanup worker eventually reclaims it (config.uploadSessionTtlMinutes) — visibly wrong to
      // the user in the meantime. Abort immediately instead, same as an explicit cancel.
      if (internal.uploadSessionId) {
        await abortSessionOnServer(internal.uploadSessionId);
        window.localStorage.removeItem(`${STORAGE_KEY_PREFIX}${id}`);
        queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage() });
      }
      updateTask(id, {
        status: "error",
        error: err instanceof ApiError ? err.message : "Something went wrong.",
      });
    }
  }

  // Pulls queued tasks into runUploadLoop() up to MAX_CONCURRENT_UPLOADS at a time; each loop
  // frees its slot and re-pumps when it settles (complete, error, or paused).
  function pump() {
    while (activeCountRef.current < MAX_CONCURRENT_UPLOADS && queueRef.current.length > 0) {
      const id = queueRef.current.shift()!;
      const internal = internalRef.current.get(id);
      if (!internal || internal.pauseRequested || internal.task.status !== "queued") continue;
      activeCountRef.current += 1;
      updateTask(id, { status: "uploading" });
      void runUploadLoop(id).finally(() => {
        activeCountRef.current -= 1;
        pump();
      });
    }
  }

  function enqueue(id: string) {
    updateTask(id, { status: "queued" });
    queueRef.current.push(id);
    pump();
  }

  function startUpload(file: File, folderId: string | null) {
    const id = crypto.randomUUID();
    const task: UploadTask = {
      id,
      fileName: file.name,
      folderId,
      totalBytes: file.size,
      uploadedBytes: 0,
      status: "queued",
    };
    internalRef.current.set(id, { task, file, uploadSessionId: null, nextPartNumber: 0, pauseRequested: false });
    setUploads((prev) => [...prev, task]);
    enqueue(id);
  }

  function pause(id: string) {
    const internal = internalRef.current.get(id);
    if (internal) internal.pauseRequested = true;
  }

  function resume(id: string) {
    const internal = internalRef.current.get(id);
    if (!internal) return;
    internal.pauseRequested = false;
    enqueue(id);
  }

  async function cancel(id: string) {
    const internal = internalRef.current.get(id);
    if (internal?.uploadSessionId) {
      await abortSessionOnServer(internal.uploadSessionId);
      queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage() });
    }
    if (internal) internal.pauseRequested = true;
    window.localStorage.removeItem(`${STORAGE_KEY_PREFIX}${id}`);
    updateTask(id, { status: "canceled" });
  }

  function dismiss(id: string) {
    internalRef.current.delete(id);
    setUploads((prev) => prev.filter((t) => t.id !== id));
  }

  const value = React.useMemo(
    () => ({ uploads, startUpload, pause, resume, cancel, dismiss }),
    [uploads],
  );

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUploads() {
  const ctx = React.useContext(UploadContext);
  if (!ctx) {
    throw new Error("useUploads() must be used within <UploadProvider>");
  }
  return ctx;
}
