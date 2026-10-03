import { db } from "../../db.js";
import { generateToken, hashToken } from "../../lib/tokens.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { checkPermission, resolveEffectiveRole, type ItemType, type Role } from "./permission-check.js";
import { insufficientPermission, shareLinkNotFound, invalidSharePassword, sharePasswordRequired } from "./errors.js";
import { logActivity } from "../admin/audit-service.js";
import * as storage from "../storage/client.js";
import { isPreviewable } from "../filesystem/file-service.js";
import { isThumbnailable } from "../thumbnails/thumbnail-service.js";
import { buildFolderZipArchive } from "../filesystem/folder-service.js";

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

/** DESIGN.md §3.6: the same granting-authority check as a direct PERMISSIONS grant. */
export async function createShareLink(
  actingUserId: string,
  itemType: ItemType,
  itemId: string,
  role: "viewer" | "editor",
  options: { password?: string; expiresAt?: Date },
) {
  const authorized = await checkPermission(actingUserId, itemType, itemId, "editor");
  if (!authorized) throw insufficientPermission();

  const actorRole = await resolveEffectiveRole(actingUserId, itemType, itemId);
  if (!actorRole || ROLE_RANK[role] > ROLE_RANK[actorRole]) throw insufficientPermission();

  const token = generateToken();
  const passwordHash = options.password ? await hashPassword(options.password) : null;

  const link = await db.share_links.create({
    data: {
      item_type: itemType,
      item_id: itemId,
      // Only the hash is stored (supabase/migrations/0024); the raw token is returned to the
      // creator once, below, and never again.
      token_hash: hashToken(token),
      role,
      password_hash: passwordHash,
      expires_at: options.expiresAt ?? null,
      created_by: actingUserId,
    },
  });

  const ownerGrant = await db.permissions.findFirst({ where: { item_type: itemType, item_id: itemId, role: "owner" } });
  await logActivity({
    actorId: actingUserId,
    subjectUserId: ownerGrant?.user_id ?? null,
    itemType,
    itemId,
    action: "create_share_link",
  });

  return { id: link.id, token };
}

export async function revokeShareLink(actingUserId: string, shareLinkId: string): Promise<void> {
  // Only the creator may revoke — REQUIREMENTS.md §5.5 doesn't grant this to the item's owner
  // if they aren't the link's own creator (DESIGN.md §3.8's "a link's fate follows its own
  // creator" rule cuts both ways).
  const link = await db.share_links.findFirst({ where: { id: shareLinkId, created_by: actingUserId } });
  if (!link) throw shareLinkNotFound();

  await db.share_links.delete({ where: { id: shareLinkId } });

  const ownerGrant = await db.permissions.findFirst({
    where: { item_type: link.item_type, item_id: link.item_id, role: "owner" },
  });
  await logActivity({
    actorId: actingUserId,
    subjectUserId: ownerGrant?.user_id ?? null,
    itemType: link.item_type,
    itemId: link.item_id,
    action: "revoke_share_link",
  });
}

/** Every share link on an item, for the share dialog — same editor-or-above gate as listPermissions. */
export async function listShareLinksForItem(actingUserId: string, itemType: ItemType, itemId: string) {
  const authorized = await checkPermission(actingUserId, itemType, itemId, "editor");
  if (!authorized) throw insufficientPermission();

  const links = await db.share_links.findMany({
    where: { item_type: itemType, item_id: itemId },
    orderBy: { created_at: "desc" },
  });

  return links.map((link) => ({
    id: link.id,
    role: link.role,
    hasPassword: link.password_hash !== null,
    expiresAt: link.expires_at?.toISOString() ?? null,
    createdBy: link.created_by,
    createdAt: link.created_at.toISOString(),
  }));
}

/**
 * Proof that a visitor entered a password-protected link's password: the decoded value of the
 * signed, httpOnly unlock cookie set by unlockShareLink()'s route. Only ever built from a cookie
 * whose signature checked out (access/routes.ts), so its fields can be trusted.
 */
export interface UnlockGrant {
  linkId: string;
  expiresAt: number; // epoch ms
}

// How long one successful unlock lasts (capped further by the link's own expiry).
export const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * DESIGN.md §3.8: every access attempt joins to users on created_by and checks is_active —
 * a deactivated creator's links are denied, application-layer, no DB backstop (accepted risk,
 * DESIGN.md §4.3).
 */
async function findLiveShareLink(token: string) {
  const link = await db.share_links.findUnique({ where: { token_hash: hashToken(token) }, include: { creator: true } });
  if (!link || !link.creator.is_active) throw shareLinkNotFound();
  if (link.expires_at && link.expires_at < new Date()) throw shareLinkNotFound();
  return link;
}

/**
 * Checks a password-protected link's password once and returns the grant for the unlock cookie,
 * or null when the link has no password (nothing to unlock).
 *
 * The password used to travel as a ?password= query parameter on every request, which put it
 * into server/proxy logs and browser history. Brute-force protection is now a per-client-IP limit
 * on this endpoint (access/routes.ts) instead of the old per-link failure counter, which let
 * anyone holding the URL lock every legitimate visitor out by failing ten times.
 */
export async function unlockShareLink(token: string, password: string): Promise<UnlockGrant | null> {
  const link = await findLiveShareLink(token);
  if (!link.password_hash) return null;
  if (!(await verifyPassword(password, link.password_hash))) throw invalidSharePassword();
  const cap = link.expires_at ? link.expires_at.getTime() : Infinity;
  return { linkId: link.id, expiresAt: Math.min(Date.now() + UNLOCK_TTL_MS, cap) };
}

/** Resolves a public link for access, requiring a valid unlock grant if it has a password. */
export async function resolveShareLink(token: string, grant: UnlockGrant | null) {
  const link = await findLiveShareLink(token);
  if (link.password_hash) {
    if (!grant || grant.linkId !== link.id || grant.expiresAt <= Date.now()) throw sharePasswordRequired();
  }
  return link;
}

type ResolvedShareLink = Awaited<ReturnType<typeof resolveShareLink>>;

/**
 * A public share link's own validity (resolveShareLink above) IS the authorization for
 * everything under it — there's no userId to run checkPermission against. This is the equivalent
 * scope check: is `itemId` the shared item itself, or (for a folder link) something structurally
 * inside that folder's subtree. Same materialized_path containment check moveOrRenameFolder's
 * cycle detection uses, just checking "is a descendant of" instead of "is an ancestor of".
 */
async function isWithinSharedScope(link: ResolvedShareLink, itemType: ItemType, itemId: string): Promise<boolean> {
  if (link.item_type === "file") {
    return itemType === "file" && itemId === link.item_id;
  }

  if (itemType === "folder") {
    if (itemId === link.item_id) return true;
    const folder = await db.folders.findFirst({ where: { id: itemId, deleted_at: null }, select: { materialized_path: true } });
    return !!folder && folder.materialized_path.includes(`/${link.item_id}/`);
  }

  const file = await db.files.findFirst({ where: { id: itemId, deleted_at: null }, select: { folder_id: true } });
  if (!file || !file.folder_id) return false;
  if (file.folder_id === link.item_id) return true;
  const folder = await db.folders.findFirst({ where: { id: file.folder_id, deleted_at: null }, select: { materialized_path: true } });
  return !!folder && folder.materialized_path.includes(`/${link.item_id}/`);
}

/**
 * Browsable listing for a public share link, à la getFolderContents but scoped to the shared
 * subtree instead of a session's own access — `folderId` lets the visitor navigate into
 * subfolders of a folder-type link (omitted, it defaults to the link's own root item).
 * `isRoot`/`parentFolderId` let the frontend know when to stop offering an "up" link — a visitor
 * can browse down into the shared subtree but never up past its root.
 */
export async function getPublicFolderContents(token: string, grant: UnlockGrant | null, folderId?: string) {
  const link = await resolveShareLink(token, grant);

  if (link.item_type === "file") {
    const file = await db.files.findFirst({ where: { id: link.item_id, deleted_at: null } });
    if (!file) throw shareLinkNotFound();
    // Was always `items: []` here — a file-type link's own listing never actually included the
    // file it shares, so the public page rendered "This folder is empty" no matter what, with
    // nothing to click to preview or download. downloadFile/previewFile below were always correct
    // (isWithinSharedScope already permits this exact file for a file-type link) — the listing
    // just never surfaced it as something to click on in the first place.
    return {
      name: file.name,
      role: link.role,
      folderId: null,
      parentFolderId: null,
      isRoot: true,
      items: serializePublicItems([], [file]),
    };
  }

  const targetFolderId = folderId ?? link.item_id;
  if (targetFolderId !== link.item_id && !(await isWithinSharedScope(link, "folder", targetFolderId))) {
    throw shareLinkNotFound();
  }

  const folder = await db.folders.findFirst({ where: { id: targetFolderId, deleted_at: null } });
  if (!folder) throw shareLinkNotFound();

  const [subFolders, files] = await Promise.all([
    db.folders.findMany({ where: { parent_folder_id: folder.id, deleted_at: null }, orderBy: { name: "asc" } }),
    db.files.findMany({ where: { folder_id: folder.id, deleted_at: null }, orderBy: { name: "asc" } }),
  ]);

  return {
    name: folder.name,
    role: link.role,
    folderId: folder.id,
    parentFolderId: folder.id === link.item_id ? null : folder.parent_folder_id,
    isRoot: folder.id === link.item_id,
    items: serializePublicItems(subFolders, files),
  };
}

function serializePublicItems(
  folders: { id: string; name: string; updated_at: Date }[],
  files: { id: string; name: string; size_bytes: bigint; mime_type: string; updated_at: Date }[],
) {
  return [
    ...folders.map((f) => ({ id: f.id, name: f.name, type: "folder" as const, updatedAt: f.updated_at.toISOString() })),
    ...files.map((f) => ({
      id: f.id,
      name: f.name,
      type: "file" as const,
      sizeBytes: f.size_bytes.toString(),
      mimeType: f.mime_type,
      updatedAt: f.updated_at.toISOString(),
    })),
  ];
}

export async function getPublicDownloadUrl(token: string, grant: UnlockGrant | null, fileId: string): Promise<string> {
  const link = await resolveShareLink(token, grant);
  if (!(await isWithinSharedScope(link, "file", fileId))) throw shareLinkNotFound();

  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file || file.upload_status !== "complete") throw shareLinkNotFound();

  return storage.getPresignedDownloadUrl(file.storage_key, 300, file.name);
}

export async function getPublicPreviewUrl(
  token: string,
  grant: UnlockGrant | null,
  fileId: string,
): Promise<{ url: string; mimeType: string } | null> {
  const link = await resolveShareLink(token, grant);
  if (!(await isWithinSharedScope(link, "file", fileId))) throw shareLinkNotFound();

  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file || file.upload_status !== "complete") throw shareLinkNotFound();
  if (!isPreviewable(file.mime_type)) return null;

  const url = await storage.getPresignedPreviewUrl(file.storage_key, file.mime_type);
  return { url, mimeType: file.mime_type };
}

export async function getPublicThumbnailUrl(
  token: string,
  grant: UnlockGrant | null,
  fileId: string,
): Promise<string | null> {
  const link = await resolveShareLink(token, grant);
  if (!(await isWithinSharedScope(link, "file", fileId))) throw shareLinkNotFound();

  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file) throw shareLinkNotFound();
  if (!isThumbnailable(file.mime_type) || file.thumbnail_status !== "ready" || !file.thumbnail_key) return null;
  return storage.getPresignedDownloadUrl(file.thumbnail_key);
}

export async function getPublicFolderZipArchive(token: string, grant: UnlockGrant | null, folderId: string) {
  const link = await resolveShareLink(token, grant);
  if (!(await isWithinSharedScope(link, "folder", folderId))) throw shareLinkNotFound();

  const folder = await db.folders.findFirst({ where: { id: folderId, deleted_at: null } });
  if (!folder) throw shareLinkNotFound();

  return { archive: buildFolderZipArchive(folderId), folderName: folder.name };
}
