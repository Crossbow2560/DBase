import { db } from "../../db.js";
import { generateToken } from "../../lib/tokens.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { checkPermission, resolveEffectiveRole, type ItemType, type Role } from "./permission-check.js";
import { insufficientPermission, shareLinkNotFound, invalidSharePassword, tooManyPasswordAttempts } from "./errors.js";
import { logActivity } from "../admin/audit-service.js";
import * as storage from "../storage/client.js";
import { isPreviewable } from "../filesystem/file-service.js";
import { isThumbnailable } from "../thumbnails/thumbnail-service.js";
import { buildFolderZipArchive } from "../filesystem/folder-service.js";

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSWORD_ATTEMPTS = 10;

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
      token,
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

  return link;
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
    token: link.token,
    role: link.role,
    hasPassword: link.password_hash !== null,
    expiresAt: link.expires_at?.toISOString() ?? null,
    createdBy: link.created_by,
    createdAt: link.created_at.toISOString(),
  }));
}

/**
 * DESIGN.md §3.8: every access attempt joins to users on created_by and checks is_active —
 * a deactivated creator's links are denied, application-layer, no DB backstop (accepted risk,
 * DESIGN.md §4.3). Also enforces the password-attempt throttle (10 failures / 15-minute window,
 * keyed on the token itself) when the link is password-protected.
 */
export async function resolveShareLink(token: string, password?: string) {
  const link = await db.share_links.findUnique({ where: { token }, include: { creator: true } });
  if (!link || !link.creator.is_active) throw shareLinkNotFound();
  if (link.expires_at && link.expires_at < new Date()) throw shareLinkNotFound();

  if (link.password_hash) {
    const now = new Date();
    const windowExpired =
      !link.failed_attempts_window_started_at ||
      now.getTime() - link.failed_attempts_window_started_at.getTime() > PASSWORD_ATTEMPT_WINDOW_MS;

    const attemptsBefore = windowExpired ? 0 : link.failed_password_attempts;
    if (attemptsBefore >= MAX_PASSWORD_ATTEMPTS) throw tooManyPasswordAttempts();

    const passwordOk = password ? await verifyPassword(password, link.password_hash) : false;

    if (!passwordOk) {
      await db.share_links.update({
        where: { id: link.id },
        data: {
          failed_password_attempts: attemptsBefore + 1,
          failed_attempts_window_started_at: windowExpired ? now : link.failed_attempts_window_started_at,
        },
      });
      throw invalidSharePassword();
    }

    if (attemptsBefore > 0 || windowExpired) {
      await db.share_links.update({
        where: { id: link.id },
        data: { failed_password_attempts: 0, failed_attempts_window_started_at: null },
      });
    }
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
export async function getPublicFolderContents(token: string, password: string | undefined, folderId?: string) {
  const link = await resolveShareLink(token, password);

  if (link.item_type === "file") {
    const file = await db.files.findFirst({ where: { id: link.item_id, deleted_at: null } });
    if (!file) throw shareLinkNotFound();
    return {
      name: file.name,
      role: link.role,
      folderId: null,
      parentFolderId: null,
      isRoot: true,
      items: [] as ReturnType<typeof serializePublicItems>,
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

export async function getPublicDownloadUrl(token: string, password: string | undefined, fileId: string): Promise<string> {
  const link = await resolveShareLink(token, password);
  if (!(await isWithinSharedScope(link, "file", fileId))) throw shareLinkNotFound();

  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file || file.upload_status !== "complete") throw shareLinkNotFound();

  return storage.getPresignedDownloadUrl(file.storage_key, 300, file.name);
}

export async function getPublicPreviewUrl(
  token: string,
  password: string | undefined,
  fileId: string,
): Promise<{ url: string; mimeType: string } | null> {
  const link = await resolveShareLink(token, password);
  if (!(await isWithinSharedScope(link, "file", fileId))) throw shareLinkNotFound();

  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file || file.upload_status !== "complete") throw shareLinkNotFound();
  if (!isPreviewable(file.mime_type)) return null;

  const url = await storage.getPresignedPreviewUrl(file.storage_key, file.mime_type);
  return { url, mimeType: file.mime_type };
}

export async function getPublicThumbnailUrl(
  token: string,
  password: string | undefined,
  fileId: string,
): Promise<string | null> {
  const link = await resolveShareLink(token, password);
  if (!(await isWithinSharedScope(link, "file", fileId))) throw shareLinkNotFound();

  const file = await db.files.findFirst({ where: { id: fileId, deleted_at: null } });
  if (!file) throw shareLinkNotFound();
  if (!isThumbnailable(file.mime_type) || file.thumbnail_status !== "ready" || !file.thumbnail_key) return null;
  return storage.getPresignedDownloadUrl(file.thumbnail_key);
}

export async function getPublicFolderZipArchive(token: string, password: string | undefined, folderId: string) {
  const link = await resolveShareLink(token, password);
  if (!(await isWithinSharedScope(link, "folder", folderId))) throw shareLinkNotFound();

  const folder = await db.folders.findFirst({ where: { id: folderId, deleted_at: null } });
  if (!folder) throw shareLinkNotFound();

  return { archive: buildFolderZipArchive(folderId), folderName: folder.name };
}
