import { db } from "../../db.js";
import { nameTooLong, pathTooLong } from "./errors.js";

const MAX_NAME_BYTES = 255;
const MAX_PATH_BYTES = 4096;

// DESIGN.md §3.3/§3.4: name must be stored NFC-normalized and trimmed before any write or
// comparison — case-sensitive, but Unicode-normalized so visually-identical names composed of
// different code points collide (REQUIREMENTS.md §5.2).
export function normalizeName(rawName: string): string {
  const normalized = rawName.normalize("NFC").trim();
  if (Buffer.byteLength(normalized, "utf8") > MAX_NAME_BYTES) {
    throw nameTooLong();
  }
  if (normalized.length === 0) {
    throw nameTooLong(); // empty-after-trim is also invalid; reuses the same client-facing shape
  }
  return normalized;
}

/**
 * REQUIREMENTS.md §5.2 / DESIGN.md §3.3: the 4096-byte human-readable path limit is distinct
 * from materialized_path (an id-path). Walks the parent chain via parent_folder_id, summing
 * each ancestor's name byte length plus one separator per segment, and throws if adding the new
 * segment would exceed the limit.
 */
export async function assertPathLengthOk(parentFolderId: string | null, newSegmentName: string): Promise<void> {
  let totalBytes = Buffer.byteLength(newSegmentName, "utf8") + 1; // +1 for this segment's separator
  let currentId = parentFolderId;

  while (currentId) {
    const folder = await db.folders.findUniqueOrThrow({
      where: { id: currentId },
      select: { name: true, parent_folder_id: true },
    });
    totalBytes += Buffer.byteLength(folder.name, "utf8") + 1;
    if (totalBytes > MAX_PATH_BYTES) {
      throw pathTooLong();
    }
    currentId = folder.parent_folder_id;
  }

  if (totalBytes > MAX_PATH_BYTES) {
    throw pathTooLong();
  }
}

/**
 * Byte length of the human-readable path down to and including `folderId` (each segment's name
 * plus one separator, the same accounting as assertPathLengthOk), so a caller building many paths
 * under one folder (folder-tree uploads) can check each against MAX_PATH_BYTES without re-walking
 * the ancestor chain per path.
 */
export async function humanPathBytes(folderId: string | null): Promise<number> {
  let total = 0;
  let currentId = folderId;
  while (currentId) {
    const folder = await db.folders.findUniqueOrThrow({
      where: { id: currentId },
      select: { name: true, parent_folder_id: true },
    });
    total += Buffer.byteLength(folder.name, "utf8") + 1;
    currentId = folder.parent_folder_id;
  }
  return total;
}

export { MAX_NAME_BYTES, MAX_PATH_BYTES };
