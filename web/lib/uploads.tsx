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
import { ApiError } from "./api-client";

const CHUNK_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const STORAGE_KEY_PREFIX = "dbase:upload-session:";

export type UploadStatus = "uploading" | "paused" | "error" | "complete" | "canceled";

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

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const [uploads, setUploads] = React.useState<UploadTask[]>([]);
  const internalRef = React.useRef<Map<string, InternalTaskState>>(new Map());

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
        const res = await fetch("/api/v1/files", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetFolderId: internal.task.folderId,
            targetName: internal.file.name,
            totalParts,
          }),
        });
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
          updateTask(id, { status: "paused" });
          return;
        }

        const start = internal.nextPartNumber * CHUNK_SIZE_BYTES;
        const end = Math.min(start + CHUNK_SIZE_BYTES, internal.file.size);
        const chunk = internal.file.slice(start, end);

        const res = await fetch(
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
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new ApiError(res.status, body?.error?.code ?? "INTERNAL_ERROR", body?.error?.message ?? "Upload failed.");
        }

        internal.nextPartNumber += 1;
        updateTask(id, { uploadedBytes: end });

        if (end >= internal.file.size) break;
      }

      const completeRes = await fetch(`/api/v1/files/upload-sessions/${internal.uploadSessionId}/complete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: internal.file.type || "application/octet-stream" }),
      });
      if (!completeRes.ok) {
        const body = await completeRes.json().catch(() => null);
        throw new ApiError(completeRes.status, body?.error?.code ?? "INTERNAL_ERROR", body?.error?.message ?? "Could not finalize upload.");
      }

      window.localStorage.removeItem(`${STORAGE_KEY_PREFIX}${id}`);
      updateTask(id, { status: "complete", uploadedBytes: internal.file.size });
    } catch (err) {
      updateTask(id, {
        status: "error",
        error: err instanceof ApiError ? err.message : "Something went wrong.",
      });
    }
  }

  function startUpload(file: File, folderId: string | null) {
    const id = crypto.randomUUID();
    const task: UploadTask = {
      id,
      fileName: file.name,
      folderId,
      totalBytes: file.size,
      uploadedBytes: 0,
      status: "uploading",
    };
    internalRef.current.set(id, { task, file, uploadSessionId: null, nextPartNumber: 0, pauseRequested: false });
    setUploads((prev) => [...prev, task]);
    void runUploadLoop(id);
  }

  function pause(id: string) {
    const internal = internalRef.current.get(id);
    if (internal) internal.pauseRequested = true;
  }

  function resume(id: string) {
    const internal = internalRef.current.get(id);
    if (!internal) return;
    internal.pauseRequested = false;
    updateTask(id, { status: "uploading" });
    void runUploadLoop(id);
  }

  async function cancel(id: string) {
    const internal = internalRef.current.get(id);
    if (internal?.uploadSessionId) {
      await fetch(`/api/v1/files/upload-sessions/${internal.uploadSessionId}`, {
        method: "DELETE",
        credentials: "include",
      }).catch(() => undefined);
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
