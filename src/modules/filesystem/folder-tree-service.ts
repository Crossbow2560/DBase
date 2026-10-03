import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { checkPermission } from "../access/permission-check.js";
import { normalizeName, humanPathBytes, MAX_NAME_BYTES, MAX_PATH_BYTES } from "./normalize.js";
import { folderNotFound, pathTooLong, invalidFolderTree } from "./errors.js";

const POSTGRES_UNIQUE_VIOLATION = "P2002";

// One request creates the whole directory structure of an uploaded folder. Bounded so a single
// request can't insert an unbounded number of rows.
export const MAX_TREE_FOLDERS = 10_000;
const MAX_CREATE_ATTEMPTS = 3;

interface TreeNode {
  key: string; // normalized relative path, "Photos/2024"
  segments: string[]; // normalized names along the path
  parentKey: string | null;
}

/**
 * Creates a folder upload's directory structure under `parentFolderId` (null = the user's root):
 * every path in `rawPaths` ("Photos", "Photos/2024", …, relative, "/"-separated), plus any
 * ancestors they imply, in one transaction of two bulk inserts — the folders and their owner
 * PERMISSIONS rows (DESIGN.md §3.6) — instead of one request and several round trips per folder.
 *
 * Same rules as createFolder(): editor-or-above on the destination, NFC-normalized and trimmed
 * names, the 255-byte name and 4096-byte path limits. A top-level folder whose name is already
 * taken at the destination is created as "Name (2)", "Name (3)", … — never merged into the
 * existing folder, so an upload can't mix its files into, or collide with, someone else's.
 *
 * Returns the id for each input path (keyed by the exact strings the client sent, so it never has
 * to reproduce the server's normalization) and the final name of each top-level folder.
 */
export async function createFolderTree(userId: string, parentFolderId: string | null, rawPaths: string[]) {
  if (rawPaths.length === 0) throw invalidFolderTree("At least one folder path is required.");
  if (rawPaths.length > MAX_TREE_FOLDERS) {
    throw invalidFolderTree(`A folder upload may create at most ${MAX_TREE_FOLDERS} folders.`);
  }

  // Parse and normalize; add implied ancestors.
  const nodes = new Map<string, TreeNode>();
  const keyForRaw = new Map<string, string>();
  for (const raw of rawPaths) {
    const parts = raw.split("/").filter((p) => p !== "");
    if (parts.length === 0 || parts.some((p) => p === "." || p === "..")) {
      throw invalidFolderTree(`Invalid folder path: ${JSON.stringify(raw)}`);
    }
    const segments = parts.map(normalizeName);
    for (let depth = 1; depth <= segments.length; depth++) {
      const key = segments.slice(0, depth).join("/");
      if (!nodes.has(key)) {
        nodes.set(key, {
          key,
          segments: segments.slice(0, depth),
          parentKey: depth === 1 ? null : segments.slice(0, depth - 1).join("/"),
        });
      }
    }
    keyForRaw.set(raw, segments.join("/"));
  }
  if (nodes.size > MAX_TREE_FOLDERS) {
    throw invalidFolderTree(`A folder upload may create at most ${MAX_TREE_FOLDERS} folders.`);
  }

  let parentPath = "/";
  if (parentFolderId) {
    if (!(await checkPermission(userId, "folder", parentFolderId, "editor"))) throw folderNotFound();
    const parent = await db.folders.findFirst({ where: { id: parentFolderId, deleted_at: null } });
    if (!parent) throw folderNotFound();
    parentPath = parent.materialized_path;
  }
  const baseBytes = await humanPathBytes(parentFolderId);

  const ordered = [...nodes.values()].sort((a, b) => a.segments.length - b.segments.length);
  const rootKeys = ordered.filter((n) => n.parentKey === null).map((n) => n.key);

  for (let attempt = 1; ; attempt++) {
    const rootNames = await chooseRootNames(userId, parentFolderId, rootKeys);

    const idByKey = new Map<string, string>();
    const pathByKey = new Map<string, string>();
    const rows: Prisma.foldersCreateManyInput[] = [];
    for (const node of ordered) {
      const id = randomUUID();
      const name = node.parentKey === null ? rootNames.get(node.key)! : node.segments[node.segments.length - 1]!;
      const parentId = node.parentKey === null ? parentFolderId : idByKey.get(node.parentKey)!;
      const parentMaterialized = node.parentKey === null ? parentPath : pathByKey.get(node.parentKey)!;

      // Human-readable path bytes: the destination's own path, then each segment plus a separator
      // (the root segment is measured with its final, possibly suffixed, name).
      const segmentNames = [name, ...node.segments.slice(1)];
      const bytes = baseBytes + segmentNames.reduce((sum, s) => sum + Buffer.byteLength(s, "utf8") + 1, 0);
      if (bytes > MAX_PATH_BYTES) throw pathTooLong();

      idByKey.set(node.key, id);
      pathByKey.set(node.key, `${parentMaterialized}${id}/`);
      rows.push({
        id,
        name,
        owner_id: userId,
        parent_folder_id: parentId,
        materialized_path: `${parentMaterialized}${id}/`,
      });
    }

    try {
      // One multi-row INSERT can reference its own rows as parents: Postgres checks the
      // parent_folder_id foreign key at the end of the statement, after every row is in.
      await db.$transaction([
        db.folders.createMany({ data: rows }),
        db.permissions.createMany({
          data: rows.map((r) => ({
            item_type: "folder" as const,
            item_id: r.id!,
            user_id: userId,
            role: "owner" as const,
            granted_by: userId,
          })),
        }),
      ]);
    } catch (err) {
      // Another request took one of the chosen top-level names between choosing and inserting.
      const conflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION;
      if (conflict && attempt < MAX_CREATE_ATTEMPTS) continue;
      throw err;
    }

    const folders: Record<string, string> = {};
    for (const [raw, key] of keyForRaw) folders[raw] = idByKey.get(key)!;
    // Final top-level names, keyed (like `folders`) by the client's own strings for those paths.
    const roots: Record<string, string> = {};
    for (const [raw, key] of keyForRaw) if (!key.includes("/")) roots[raw] = rootNames.get(key)!;
    return { folders, roots };
  }
}

/** Free names for the top-level folders: the requested name, or "Name (n)" with the lowest free n. */
async function chooseRootNames(userId: string, parentFolderId: string | null, rootKeys: string[]) {
  const siblings = await db.folders.findMany({
    where: {
      deleted_at: null,
      ...(parentFolderId ? { parent_folder_id: parentFolderId } : { owner_id: userId, parent_folder_id: null }),
      OR: rootKeys.map((name) => ({ name: { startsWith: name } })),
    },
    select: { name: true },
  });
  const taken = new Set(siblings.map((s) => s.name));

  const chosen = new Map<string, string>();
  for (const name of rootKeys) {
    let candidate = name;
    for (let n = 2; taken.has(candidate); n++) candidate = withSuffix(name, n);
    taken.add(candidate);
    chosen.set(name, candidate);
  }
  return chosen;
}

/** "Name (n)", truncating the base on a character boundary to stay within the name byte limit. */
function withSuffix(name: string, n: number): string {
  const suffix = ` (${n})`;
  let base = name;
  while (Buffer.byteLength(base + suffix, "utf8") > MAX_NAME_BYTES) base = Array.from(base).slice(0, -1).join("");
  return base + suffix;
}
