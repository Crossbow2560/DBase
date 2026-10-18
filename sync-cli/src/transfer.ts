import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError, type Api, type UploadedFile } from "./api.js";
import { TEMP_SUFFIX } from "./ignore.js";
import type { State } from "./state.js";

// DBase's upload sessions take parts of 5–64 MiB, any of them in any order, except that the last
// may be smaller (storage/client.ts). Parts are idempotent server-side, so a resumed upload can
// safely resend any part it isn't sure about.
export const PART_SIZE = 8 * 1024 * 1024;
const PARALLEL_PARTS = 4;

export interface UploadTarget {
  rootId: number;
  relPath: string;
  absPath: string;
  hash: string;
  size: number;
  mtime: number;
  /** A new file: its name and parent folder. */
  name?: string;
  parentId?: string;
  /** Or a content replace, with the version the client last saw (compare-and-swap). */
  replaceFileId?: string;
  expectedVersion?: string | null;
}

/**
 * Uploads a file through an upload session, resuming the session recorded in state if it's for
 * the same content and still alive. Throws ApiError on a refusal (NAME_COLLISION,
 * CONTENT_CONFLICT, QUOTA_EXCEEDED, ...); the caller decides what that means.
 */
export async function uploadFile(api: Api, state: State, t: UploadTarget): Promise<UploadedFile> {
  const totalParts = Math.max(1, Math.ceil(t.size / PART_SIZE));
  const pending = state.upload(t.rootId, t.relPath);
  let sessionId: string;
  let done: Set<number>;
  if (pending && pending.hash === t.hash && pending.size === t.size && pending.mtime === t.mtime) {
    sessionId = pending.session_id;
    done = new Set(JSON.parse(pending.parts_done) as number[]);
  } else {
    if (pending) await api.cancelUpload(pending.session_id);
    sessionId = await startSession(api, t, totalParts);
    done = new Set();
    record(state, t, sessionId, done);
  }

  try {
    await sendParts(api, state, t, sessionId, totalParts, done);
  } catch (err) {
    // The recorded session expired or was cleaned up meanwhile: start over once.
    if (!(err instanceof ApiError && err.status === 404 && pending?.session_id === sessionId)) throw err;
    sessionId = await startSession(api, t, totalParts);
    done = new Set();
    record(state, t, sessionId, done);
    await sendParts(api, state, t, sessionId, totalParts, done);
  }

  try {
    const { file } = await api.completeUpload(sessionId);
    return file;
  } finally {
    // Completed, or refused for good (conflict, collision, quota): either way this session is
    // finished, and the server has already refunded a refused one.
    state.deleteUpload(t.rootId, t.relPath);
  }
}

async function startSession(api: Api, t: UploadTarget, totalParts: number): Promise<string> {
  const res = t.replaceFileId
    ? await api.initUpload({
        replaceFileId: t.replaceFileId,
        ...(t.expectedVersion ? { expectedVersion: t.expectedVersion } : {}),
        totalParts,
        checksum: t.hash,
      })
    : await api.initUpload({ targetName: t.name!, targetFolderId: t.parentId!, totalParts, checksum: t.hash });
  return res.uploadSessionId;
}

function record(state: State, t: UploadTarget, sessionId: string, done: Set<number>): void {
  state.putUpload({
    root_id: t.rootId,
    rel_path: t.relPath,
    session_id: sessionId,
    hash: t.hash,
    size: t.size,
    mtime: t.mtime,
    parts_done: JSON.stringify([...done]),
  });
}

async function sendParts(
  api: Api,
  state: State,
  t: UploadTarget,
  sessionId: string,
  totalParts: number,
  done: Set<number>,
): Promise<void> {
  const handle = await open(t.absPath, "r");
  try {
    const queue = Array.from({ length: totalParts }, (_, i) => i).filter((i) => !done.has(i));
    const worker = async () => {
      for (let part = queue.shift(); part !== undefined; part = queue.shift()) {
        const offset = part * PART_SIZE;
        const length = Math.min(PART_SIZE, t.size - offset);
        const buffer = Buffer.alloc(Math.max(0, length));
        if (length > 0) await handle.read(buffer, 0, length, offset);
        await api.putPart(sessionId, part, buffer);
        done.add(part);
        record(state, t, sessionId, done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, queue.length) }, worker));
  } finally {
    await handle.close();
  }
}

/** A temp file next to `absPath`, hidden and matched by the default ignore rules. */
export function tempPathFor(absPath: string): string {
  return path.join(path.dirname(absPath), `.${path.basename(absPath)}.${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`);
}

/**
 * Downloads a presigned URL into a temp file in the destination's directory, hashing as it
 * writes. Returns the temp path and the SHA-256; the caller renames it into place (an atomic
 * replace on the same filesystem), so a reader never sees a half-written file.
 */
export async function downloadToTemp(url: string, absPath: string, expectedChecksum: string | null): Promise<{ tmp: string; hash: string }> {
  const tmp = tempPathFor(absPath);
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const hash = createHash("sha256");
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => hash.update(chunk));
    await pipeline(body, createWriteStream(tmp));
    const digest = hash.digest("hex");
    if (expectedChecksum && digest !== expectedChecksum) {
      throw new Error(`downloaded content doesn't match its checksum (expected ${expectedChecksum}, got ${digest})`);
    }
    return { tmp, hash: digest };
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function moveIntoPlace(tmp: string, absPath: string): Promise<void> {
  try {
    await rename(tmp, absPath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
