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
import { api, ApiError } from "./api-client";
import type { FolderSelection } from "./folder-upload";
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

function formatSize(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

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

// Transient failures — the request never got an answer (dropped connection, proxy reset), a 5xx, a
// timeout, or the server saying a completion is still being finalized — are retried a few times
// with backoff before the file is marked failed. Safe to repeat: the server treats a repeated part
// as a no-op and a repeated completion returns the file already created.
const TRANSIENT_RETRY_DELAYS_MS = [1000, 2000, 4000];

async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    return ((await res.clone().json()) as { error?: { code?: string } })?.error?.code;
  } catch {
    return undefined;
  }
}

async function isTransientResponse(res: Response): Promise<boolean> {
  if (res.status >= 500 || res.status === 408) return true;
  return res.status === 409 && (await errorCodeOf(res)) === "UPLOAD_IN_PROGRESS";
}

async function fetchWithRetry(input: string, init: RequestInit, shouldAbort: () => boolean): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let res: Response | null = null;
    let thrown: unknown = null;
    try {
      res = await fetchWithRateLimitRetry(input, init, shouldAbort);
    } catch (err) {
      thrown = err; // network failure: fetch() itself rejects
    }
    const transient = thrown !== null || (res !== null && (await isTransientResponse(res)));
    if (!transient || attempt >= TRANSIENT_RETRY_DELAYS_MS.length || shouldAbort()) {
      if (thrown !== null) throw thrown;
      return res!;
    }
    await delay(TRANSIENT_RETRY_DELAYS_MS[attempt]! + Math.random() * 500);
  }
}

/** Failed for a reason that may go away (connectivity, server trouble) rather than one that won't. */
function isTransientFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true; // network error / unexpected exception
  return err.status >= 500 || err.status === 408 || err.code === "UPLOAD_IN_PROGRESS";
}

export interface UploadTask {
  id: string;
  fileName: string;
  folderId: string | null;
  totalBytes: number;
  uploadedBytes: number;
  status: UploadStatus;
  error?: string;
  groupId?: string; // set for files that are part of a folder upload
}

// A folder upload: its files are ordinary UploadTasks (same queue, same concurrency) tagged with
// the group's id; the tray shows the group as one row with combined progress.
export interface UploadGroup {
  id: string;
  name: string;
  // "preparing": reading the folder / checking quota / creating the folders; "ready": files are
  // queued (overall progress comes from the files); "failed": nothing was uploaded.
  phase: "preparing" | "ready" | "failed";
  error?: string;
  totalFiles: number;
  totalBytes: number;
  folderCount: number;
}

interface UploadControls {
  uploads: UploadTask[];
  groups: UploadGroup[];
  startUpload: (file: File, folderId: string | null) => void;
  startFolderUpload: (selection: FolderSelection, parentFolderId: string | null) => Promise<void>;
  pause: (id: string) => void;
  resume: (id: string) => void;
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
  retry: (id: string) => void;
  retryGroup: (groupId: string) => void;
  pauseGroup: (groupId: string) => void;
  resumeGroup: (groupId: string) => void;
  cancelGroup: (groupId: string) => void;
  dismissGroup: (groupId: string) => void;
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
  // Set synchronously by cancel(), before its abort request goes out, so the upload loop can tell
  // a cancel from a pause and never completes (or reports as failed) a file being canceled.
  cancelRequested: boolean;
  // Set by retry(): if the kept server session has expired meanwhile, start over instead of failing.
  retrying: boolean;
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
  const [groups, setGroups] = React.useState<UploadGroup[]>([]);
  // Latest groups for event handlers, and each folder upload's original selection (for retrying
  // one whose preparation failed).
  const groupsRef = React.useRef<UploadGroup[]>([]);
  groupsRef.current = groups;
  const folderSelectionsRef = React.useRef(
    new Map<string, { selection: FolderSelection; parentFolderId: string | null }>(),
  );
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
        const res = await fetchWithRetry(
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
            const res = await fetchWithRetry(
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
      if (internal.cancelRequested) return; // cancel() owns the final status
      if (internal.completedParts.size < internal.totalParts) {
        // Stopped by pause before every part was sent.
        updateTask(id, { status: "paused" });
        return;
      }

      const completeRes = await fetchWithRetry(
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

      internal.retrying = false;
      forgetSession(id);
      updateTask(id, { status: "complete", uploadedBytes: internal.file.size });
      settleGroupIfDone(internal.task.groupId);
      queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage() });
      // Was missing entirely — completion only ever refreshed the quota indicator, never the
      // folder listing itself, so a newly-uploaded file didn't show up anywhere (/home,
      // /folders, or the target subfolder) until some unrelated action happened to refetch it.
      queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(internal.task.folderId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.recentFiles() });
    } catch (err) {
      // Canceled meanwhile (e.g. the cancel's abort beat this completion): not a failure, and
      // cancel() has already aborted the session and set the status.
      if (internal.cancelRequested) return;

      // Retrying a kept session that expired in the meantime (the server cleans up sessions after
      // UPLOAD_SESSION_TTL_MINUTES): start this file over rather than failing it again.
      if (internal.retrying && err instanceof ApiError && err.code === "UPLOAD_SESSION_NOT_FOUND") {
        internal.retrying = false;
        // Release the expired session's stored parts now rather than at the next cleanup sweep.
        if (internal.uploadSessionId) await abortSessionOnServer(internal.uploadSessionId);
        resetSession(id, internal);
        return runUploadLoop(id);
      }
      internal.retrying = false;

      if (isTransientFailure(err) && internal.uploadSessionId) {
        // Connectivity or server trouble that outlasted the automatic retries. Keep the server
        // session (and the parts already stored) so Retry continues where this stopped; the
        // session id stays remembered, so a page refresh still releases it (see takeInterrupted…).
        updateTask(id, {
          status: "error",
          error: "Connection problem — upload interrupted. Retry to continue where it stopped.",
        });
      } else {
        // A failure that retrying the same parts won't fix (quota, name taken, destination gone…).
        // Earlier parts may already have been charged against quota; abort now rather than leave
        // that charge until the session's TTL cleanup. Retry starts the file over.
        if (internal.uploadSessionId) {
          await abortSessionOnServer(internal.uploadSessionId);
          queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage() });
        }
        resetSession(id, internal);
        updateTask(id, {
          status: "error",
          error: err instanceof ApiError ? err.message : "Something went wrong.",
        });
      }
      settleGroupIfDone(internal.task.groupId);
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

  function createTask(file: File, folderId: string | null, groupId?: string): UploadTask {
    const id = crypto.randomUUID();
    const task: UploadTask = {
      id,
      fileName: file.name,
      folderId,
      totalBytes: file.size,
      uploadedBytes: 0,
      status: "queued",
      ...(groupId ? { groupId } : {}),
    };
    internalRef.current.set(id, {
      task,
      file,
      uploadSessionId: null,
      partSize: 0,
      totalParts: 0,
      completedParts: new Set(),
      pauseRequested: false,
      cancelRequested: false,
      retrying: false,
    });
    return task;
  }

  function startUpload(file: File, folderId: string | null) {
    const task = createTask(file, folderId);
    setUploads((prev) => [...prev, task]);
    queueRef.current.push(task.id);
    pump();
  }

  function updateGroup(id: string, patch: Partial<UploadGroup>) {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }

  /**
   * Uploads a folder selection (web/lib/folder-upload.ts) into `parentFolderId`: checks there's
   * room for it, creates every directory in one request (POST /folders/tree — a top-level name
   * that's already taken comes back as "Name (2)"), then queues each file into its folder.
   */
  async function startFolderUpload(selection: FolderSelection, parentFolderId: string | null) {
    const groupId = crypto.randomUUID();
    const totalBytes = selection.files.reduce((sum, f) => sum + f.file.size, 0);
    setGroups((prev) => [
      ...prev,
      {
        id: groupId,
        name: selection.roots.length === 1 ? selection.roots[0]! : `${selection.roots.length} folders`,
        phase: "preparing",
        totalFiles: selection.files.length,
        totalBytes,
        folderCount: selection.directories.length,
      },
    ]);
    folderSelectionsRef.current.set(groupId, { selection, parentFolderId });
    await prepareFolderUpload(groupId);
  }

  /** Quota check, folder creation and queueing for a folder upload — re-run by retryGroup(). */
  async function prepareFolderUpload(groupId: string) {
    const { selection, parentFolderId } = folderSelectionsRef.current.get(groupId)!;
    const totalBytes = selection.files.reduce((sum, f) => sum + f.file.size, 0);
    try {
      // Fail up front rather than half-way through hundreds of files.
      const usage = await api.get<{ storageUsedBytes: string; storageQuotaBytes: string }>("/users/me/storage");
      const available = Number(usage.storageQuotaBytes) - Number(usage.storageUsedBytes);
      if (totalBytes > available) {
        throw new Error(
          `Not enough storage: this folder needs ${formatSize(totalBytes)}, ${formatSize(Math.max(0, available))} available.`,
        );
      }

      const created = await api.post<{ folders: Record<string, string>; roots: Record<string, string> }>(
        "/folders/tree",
        { parentFolderId, paths: selection.directories },
      );
      if (selection.roots.length === 1) {
        updateGroup(groupId, { name: created.roots[selection.roots[0]!] ?? selection.roots[0]! });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(parentFolderId) });

      const tasks = selection.files.map((f) => createTask(f.file, created.folders[f.dir] ?? null, groupId));
      setUploads((prev) => [...prev, ...tasks]);
      updateGroup(groupId, { phase: "ready" });
      queueRef.current.push(...tasks.map((t) => t.id));
      pump();
    } catch (err) {
      updateGroup(groupId, {
        phase: "failed",
        error: err instanceof Error ? err.message : "Could not upload this folder.",
      });
    }
  }

  // When the last file of a folder upload settles (complete, failed or canceled), refresh every
  // folder listing: each file's completion only refreshes its own folder, but listings show
  // recursive file counts and sizes, so the destination and all its ancestors are stale too.
  function settleGroupIfDone(groupId: string | undefined) {
    if (!groupId) return;
    const unsettled = groupTaskIds(groupId).some((id) => {
      const status = internalRef.current.get(id)?.task.status;
      return status === "queued" || status === "uploading" || status === "paused";
    });
    if (!unsettled) queryClient.invalidateQueries({ queryKey: ["folders"] });
  }

  function groupTaskIds(groupId: string): string[] {
    return [...internalRef.current.values()].filter((i) => i.task.groupId === groupId).map((i) => i.task.id);
  }

  function pauseGroup(groupId: string) {
    for (const id of groupTaskIds(groupId)) {
      const internal = internalRef.current.get(id)!;
      if (internal.task.status === "uploading") pause(id);
      // Not started yet: mark paused so the queue skips it and the UI says so.
      else if (internal.task.status === "queued") {
        internal.pauseRequested = true;
        updateTask(id, { status: "paused" });
      }
    }
  }

  function resumeGroup(groupId: string) {
    for (const id of groupTaskIds(groupId)) {
      if (internalRef.current.get(id)!.task.status === "paused") resume(id);
    }
  }

  function cancelGroup(groupId: string) {
    for (const id of groupTaskIds(groupId)) {
      const status = internalRef.current.get(id)!.task.status;
      if (status === "queued" || status === "uploading" || status === "paused") void cancel(id);
    }
  }

  /**
   * Retry a folder upload: if preparing it failed (quota check, folder creation), run that again;
   * otherwise retry each of its failed files.
   */
  function retryGroup(groupId: string) {
    const group = groupsRef.current.find((g) => g.id === groupId);
    if (group?.phase === "failed") {
      updateGroup(groupId, { phase: "preparing", error: undefined });
      void prepareFolderUpload(groupId);
      return;
    }
    for (const id of groupTaskIds(groupId)) {
      if (internalRef.current.get(id)?.task.status === "error") retry(id);
    }
  }

  function dismissGroup(groupId: string) {
    const ids = new Set(groupTaskIds(groupId));
    for (const id of ids) dismiss(id); // releases any session a failed file still holds
    folderSelectionsRef.current.delete(groupId);
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
  }

  /** Forget the server session so the next run starts this file from scratch. */
  function resetSession(id: string, internal: InternalTaskState) {
    internal.uploadSessionId = null;
    internal.partSize = 0;
    internal.totalParts = 0;
    internal.completedParts = new Set();
    forgetSession(id);
    updateTask(id, { uploadedBytes: 0 });
  }

  /** Retry a failed file: continues from the parts already stored if the session was kept. */
  function retry(id: string) {
    const internal = internalRef.current.get(id);
    if (!internal || internal.task.status !== "error") return;
    internal.pauseRequested = false;
    internal.cancelRequested = false;
    internal.retrying = internal.uploadSessionId !== null;
    updateTask(id, { error: undefined });
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
    if (!internal) return;
    // Flags first, synchronously: the upload loop checks them before sending "complete".
    internal.cancelRequested = true;
    internal.pauseRequested = true;
    if (internal.uploadSessionId) {
      await abortSessionOnServer(internal.uploadSessionId);
      queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage() });
    }
    // A completion already in flight can still win the race on the server (the abort then gets a
    // 404). The file exists in that case, so it stays "complete" rather than being shown as
    // canceled.
    if (internal.task.status === "complete") return;
    forgetSession(id);
    updateTask(id, { status: "canceled" });
    settleGroupIfDone(internal.task.groupId);
  }

  function dismiss(id: string) {
    // A failed upload may still hold a server session (kept for Retry); release it and its quota.
    const sessionId = internalRef.current.get(id)?.uploadSessionId;
    if (internalRef.current.get(id)?.task.status === "error" && sessionId) {
      void abortSessionOnServer(sessionId).then(() =>
        queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage() }),
      );
      forgetSession(id);
    }
    internalRef.current.delete(id);
    setUploads((prev) => prev.filter((t) => t.id !== id));
  }

  const value = React.useMemo(
    () => ({
      uploads,
      groups,
      startUpload,
      startFolderUpload,
      pause,
      resume,
      cancel,
      dismiss,
      retry,
      retryGroup,
      pauseGroup,
      resumeGroup,
      cancelGroup,
      dismissGroup,
    }),
    [uploads, groups],
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
