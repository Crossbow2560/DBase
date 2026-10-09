import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { IgnoreMatcher } from "./ignore.js";
import { normalizeName } from "./names.js";

export interface LocalItem {
  kind: "file" | "folder";
  /** The path on disk, relative to the root, as the filesystem spells it (may not be NFC). */
  diskPath: string;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  /** Keyed by sync path: root-relative, "/"-separated, every segment NFC-normalized. */
  items: Map<string, LocalItem>;
  skipped: { relPath: string; reason: string }[];
}

/**
 * Walks the sync root. Symlinks are never followed (a link out of the root would sync whatever it
 * points at); ignored paths aren't descended into. Two names that differ only in Unicode
 * normalization would map to the same DBase name, so the second is skipped and reported.
 */
export async function scanLocal(rootDir: string, ignore: IgnoreMatcher): Promise<ScanResult> {
  const items = new Map<string, LocalItem>();
  const skipped: ScanResult["skipped"] = [];

  async function walk(diskRel: string, syncRel: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(path.join(rootDir, diskRel));
    } catch {
      return; // vanished mid-scan; the next scan sees the new state
    }
    for (const diskName of names) {
      const childDisk = diskRel ? `${diskRel}/${diskName}` : diskName;
      const childSync = syncRel ? `${syncRel}/${normalizeName(diskName)}` : normalizeName(diskName);
      let st;
      try {
        st = await lstat(path.join(rootDir, childDisk));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({ relPath: childSync, reason: "symbolic links aren't synced" });
        continue;
      }
      const isDir = st.isDirectory();
      if (!isDir && !st.isFile()) continue;
      if (ignore.ignores(childSync, isDir)) continue;
      if (items.has(childSync)) {
        skipped.push({ relPath: childDisk, reason: "another name here is identical after Unicode normalization" });
        continue;
      }
      items.set(childSync, {
        kind: isDir ? "folder" : "file",
        diskPath: childDisk,
        size: isDir ? 0 : st.size,
        mtimeMs: isDir ? 0 : st.mtimeMs,
      });
      if (isDir) await walk(childDisk, childSync);
    }
  }

  await walk("", "");
  return { items, skipped };
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
