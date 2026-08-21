import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { AppError } from "../accounts/errors.js";
import { checkPermission } from "../access/permission-check.js";
import type { ItemType } from "../access/permission-check.js";
import { logActivity } from "../admin/audit-service.js";
import { itemNotFound, tagNotFound, tagNameCollision } from "./errors.js";

const POSTGRES_UNIQUE_VIOLATION = "P2002";
const MAX_TAG_NAME_BYTES = 100;

function normalizeTagName(raw: string): string {
  const normalized = raw.normalize("NFC").trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > MAX_TAG_NAME_BYTES) {
    throw new AppError(400, "VALIDATION_ERROR", `Tag name must be 1-${MAX_TAG_NAME_BYTES} bytes (UTF-8) after trimming.`);
  }
  return normalized;
}

/** REQUIREMENTS.md §5.8: tags are per-user (TAGS.owner_id), not shared or visible cross-user. */
export async function createTag(userId: string, rawName: string, color?: string | null) {
  const name = normalizeTagName(rawName);
  try {
    return await db.tags.create({ data: { owner_id: userId, name, color: color ?? null } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw tagNameCollision();
    }
    throw err;
  }
}

export async function listTags(userId: string) {
  return db.tags.findMany({ where: { owner_id: userId }, orderBy: { name: "asc" } });
}

/** DESIGN.md §3.12: cascade-deletes the tag's ITEM_TAGS rows via the DB's own ON DELETE CASCADE. */
export async function deleteTag(userId: string, tagId: string): Promise<void> {
  const result = await db.tags.deleteMany({ where: { id: tagId, owner_id: userId } });
  if (result.count === 0) throw tagNotFound();
}

/**
 * DESIGN.md §3.12 (Pass 4 + Pass 6 fix): two independent write-path checks, not one —
 * (1) editor-or-above on the item being tagged, and (2) the tag itself must be owned by the
 * acting user. Neither check substitutes for the other: (1) alone would let an editor apply
 * someone else's private tag_id to an item they can write to; (2) alone says nothing about
 * whether the acting user may write to the item at all.
 */
export async function applyTag(userId: string, itemType: ItemType, itemId: string, tagId: string): Promise<void> {
  if (!(await checkPermission(userId, itemType, itemId, "editor"))) throw itemNotFound();

  const tag = await db.tags.findFirst({ where: { id: tagId, owner_id: userId } });
  if (!tag) throw tagNotFound();

  await db.$executeRaw`
    INSERT INTO item_tags (tag_id, item_type, item_id) VALUES (${tagId}::uuid, ${itemType}::item_type, ${itemId}::uuid)
    ON CONFLICT (tag_id, item_type, item_id) DO NOTHING
  `;

  // Tags are personal to their creator (REQUIREMENTS.md §5.8) — subject === actor, same
  // reasoning as favorites, even though the item tagged may be owned by someone else.
  await logActivity({ actorId: userId, subjectUserId: userId, itemType, itemId, action: "tag", metadata: { tagId } });
}

export async function removeTag(userId: string, itemType: ItemType, itemId: string, tagId: string): Promise<void> {
  // Ownership of the tag is enough to authorize removal — no separate editor-on-item check:
  // if the acting user's own tag is somehow still attached to an item they've since lost write
  // access to, they must still be able to detach their own label from it.
  const tag = await db.tags.findFirst({ where: { id: tagId, owner_id: userId } });
  if (!tag) throw tagNotFound();

  await db.item_tags.deleteMany({ where: { tag_id: tagId, item_type: itemType, item_id: itemId } });
  await logActivity({ actorId: userId, subjectUserId: userId, itemType, itemId, action: "untag", metadata: { tagId } });
}

/** REQUIREMENTS.md §5.8: only the acting user's own tags are ever visible, even on their own items. */
export async function listItemTags(userId: string, itemType: ItemType, itemId: string) {
  if (!(await checkPermission(userId, itemType, itemId, "viewer"))) throw itemNotFound();

  const rows = await db.item_tags.findMany({
    where: { item_type: itemType, item_id: itemId, tag: { owner_id: userId } },
    include: { tag: true },
  });
  return rows.map((row) => row.tag);
}
