"use client";

// FRONTEND_DESIGN.md §8 item 2, resolved by owner decision: a bottom-right toast tray with
// pause/resume/cancel per upload. Drives the multipart upload endpoints (POST /files,
// PUT .../parts/:n with 0-indexed parts, POST .../complete, DELETE upload-sessions/:id).
//
// Interrupted uploads: a page refresh loses the browser's File objects, so an in-progress or
// paused upload can't be resumed. Each task's server-side uploadSessionId is remembered in
// sessionStorage (per tab — it survives a refresh but isn't shared with other tabs, which may
// still be uploading), and on the next mount every remembered session is cancelled so its
// already-charged bytes are released immediately rather than after the server's TTL cleanup.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";
import { queryKeys } from "./query-keys";

// Upload speed for large files was bound by per-request overhead (two proxy hops plus database
// round trips per part), not bandwidth: one 5 MiB part at a time spent most of each request waiting.
// Two changes fix that: parts are sized to the file (fewer requests for big files), and several
// parts of one file are in flight at once (the server accepts parts in any order and composes them
// by number at completion).
const MIN_PART_BYTES = 5 * 1024 * 1024; // MinIO's compose minimum for every part but the last
const MAX_PART_BYTES = 32 * 1024 * 1024; // server allows 64 MiB; stays well under Cloudflare's 100 MB
// Measured (512 MB file, 4 parts in flight, 50 ms DB round trip): 5 MiB parts 70 MB/s, 16 MiB
// 143 MB/s, 32 MiB 196 MB/s — so aim for few, large parts. Files under ~80 MB stay at 5 MiB.
const TARGET_PARTS_PER_FILE = 16;
const PARTS_IN_FLIGHT_PER_FILE = 4;

/** Whole-MiB part size giving about TARGET_PARTS_PER_FILE parts, clamped to [5, 32] MiB. */
function choosePartSize(fileSize: number): number {
  const mib = 1024 * 1024;
  const ideal = Math.ceil(fileSize / TARGET_PARTS_PER_FILE / mib) * mib;
  return Math.min(MAX_PART_BYTES, Math.max(MIN_PART_BYTES, ideal));
}
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
  // Fixed when the session is opened (the server knows totalParts, so it can't change on resume).
  partSize: number;
  totalParts: number;
  completedParts: Set<number>;
  pauseRequested: boolean;
}

// sessionStorage can throw (privacy modes, blocked storage) — losing the bookkeeping only means
// the server's own TTL cleanup reclaims an interrupted session instead, so failures are ignored.
function rememberSession(taskId: string, uploadSessionId: string) {
  try {
    window.sessionStorage.setItem(`${STORAGE_KEY_PREFIX}${taskId}`, uploadSessionId);
  } catch {}
}

function forgetSession(taskId: string) {
  try {
    window.sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${taskId}`);
  } catch {}
}

/** Removes and returns every session id a previous page load in this tab left behind. */
function takeInterruptedSessions(): string[] {
  const ids: string[] = [];
  try {
    const store = window.sessionStorage;
    for (const key of Object.keys(store)) {
      if (!key.startsWith(STORAGE_KEY_PREFIX)) continue;
      const value = store.getItem(key);
      store.removeItem(key);
      if (value) ids.push(value);
    }
  } catch {}
  // Earlier versions kept these in localStorage and never read them back — drop the leftovers.
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(STORAGE_KEY_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {}
  return ids;
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

  // Release uploads interrupted by a refresh of this tab (see the header comment). Ids are
  // removed synchronously before any request, so StrictMode's double-invoked effect can't cancel
  // the same session twice.
  React.useEffect(() => {
    const interrupted = takeInterruptedSessions();
    if (interrupted.length === 0) return;
    void Promise.all(interrupted.map(abortSessionOnServer)).then(() =>
      queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage() }),
    );
  }, [queryClient]);

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
        internal.partSize = choosePartSize(internal.file.size);
        internal.totalParts = Math.max(1, Math.ceil(internal.file.size / internal.partSize));
        const totalParts = internal.totalParts;
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
        rememberSession(id, uploadSessionId);
      }

      // Up to PARTS_IN_FLIGHT_PER_FILE workers pull part numbers that aren't done yet. On pause
      // they stop taking new parts and let in-flight ones finish (resume skips completed parts);
      // the first failure stops every worker and is rethrown below.
      const pending = Array.from({ length: internal.totalParts }, (_, n) => n).filter(
        (n) => !internal.completedParts.has(n),
      );
      let failure: unknown = null;
      const sizeOf = (n: number) =>
        Math.min((n + 1) * internal.partSize, internal.file.size) - n * internal.partSize;

      async function worker() {
        while (pending.length > 0 && !internal!.pauseRequested && failure === null) {
          const partNumber = pending.shift()!;
          const start = partNumber * internal!.partSize;
          const chunk = internal!.file.slice(start, Math.min(start + internal!.partSize, internal!.file.size));
          try {
            const res = await fetchWithRateLimitRetry(
              `/api/v1/files/upload-sessions/${internal!.uploadSessionId}/parts/${partNumber}`,
              {
                method: "PUT",
                credentials: "include",
                // Explicit, rather than relying on the browser's default for a Blob with no `type`
                // (often omitted entirely) — the backend streams bodies of exactly this content
                // type straight to storage (src/app.ts).
                headers: { "Content-Type": "application/octet-stream" },
                body: chunk,
              },
              () => internal!.pauseRequested,
            );
            if (!res.ok) {
              const body = await res.json().catch(() => null);
              throw new ApiError(res.status, body?.error?.code ?? "INTERNAL_ERROR", body?.error?.message ?? "Upload failed.");
            }
            internal!.completedParts.add(partNumber);
            let done = 0;
            for (const n of internal!.completedParts) done += sizeOf(n);
            updateTask(id, { uploadedBytes: done });
          } catch (err) {
            if (failure === null) failure = err;
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(PARTS_IN_FLIGHT_PER_FILE, Math.max(1, pending.length)) }, worker),
      );
      if (failure !== null) throw failure;
      if (internal.completedParts.size < internal.totalParts) {
        // Stopped by pause/cancel before every part was sent.
        // cancel() also sets pauseRequested; don't overwrite the "canceled" it left behind.
        if (internal.task.status !== "canceled") updateTask(id, { status: "paused" });
        return;
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

      forgetSession(id);
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
        forgetSession(id);
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
    internalRef.current.set(id, {
      task,
      file,
      uploadSessionId: null,
      partSize: 0,
      totalParts: 0,
      completedParts: new Set(),
      pauseRequested: false,
    });
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
    forgetSession(id);
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
