import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import * as permissions from "./permission-service.js";
import * as shareLinks from "./share-link-service.js";
import { requireSession, parseItemType, publicRateLimit, publicZipRateLimit } from "../accounts/guards.js";
import type { UnlockGrant } from "./share-link-service.js";

const UNLOCK_COOKIE = "dbase_share_unlock";

// Scoped to this one link's public API path, so a browser only ever sends a link's unlock cookie
// back to that same link's endpoints (and holds one cookie per unlocked link).
const unlockCookiePath = (token: string) => `/api/v1/public/share-links/${encodeURIComponent(token)}`;

function setUnlockCookie(reply: FastifyReply, token: string, grant: UnlockGrant) {
  reply.setCookie(UNLOCK_COOKIE, `${grant.linkId}.${grant.expiresAt}`, {
    signed: true,
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: unlockCookiePath(token),
    expires: new Date(grant.expiresAt),
  });
}

/** The unlock grant from a correctly-signed cookie, or null (missing, tampered, or malformed). */
function readUnlockGrant(request: FastifyRequest): UnlockGrant | null {
  const raw = request.cookies[UNLOCK_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const [linkId, expiresAt] = unsigned.value.split(".");
  if (!linkId || !expiresAt || !/^\d+$/.test(expiresAt)) return null;
  return { linkId, expiresAt: Number(expiresAt) };
}

// Brute-force bound for link passwords: per client IP AND per link, so guessing at one link can't
// lock other visitors out of it (the old per-link counter could) and can't spend budget on others.
const unlockRateLimit = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: "15 minutes",
      keyGenerator: (request: FastifyRequest) =>
        `unlock:${request.ip}:${(request.params as { token?: string }).token ?? ""}`,
    },
  },
} as const;

export async function accessRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/items/:type/:id/permissions",
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: "object",
          required: ["userId", "role"],
          properties: { userId: { type: "string" }, role: { type: "string", enum: ["viewer", "editor"] } },
        },
      },
    },
    async (request, reply) => {
      const { type, id } = request.params as { type: string; id: string };
      const body = request.body as { userId: string; role: "viewer" | "editor" };
      await permissions.grantPermission(request.session!.user_id, parseItemType(type), id, body.userId, body.role);
      reply.code(204).send();
    },
  );

  app.delete(
    "/api/v1/items/:type/:id/permissions/:userId",
    { preHandler: requireSession },
    async (request, reply) => {
      const { type, id, userId } = request.params as { type: string; id: string; userId: string };
      await permissions.revokePermission(request.session!.user_id, parseItemType(type), id, userId);
      reply.code(204).send();
    },
  );

  app.get("/api/v1/items/:type/:id/permissions", { preHandler: requireSession }, async (request, reply) => {
    const { type, id } = request.params as { type: string; id: string };
    const collaborators = await permissions.listPermissions(request.session!.user_id, parseItemType(type), id);
    reply.send({ collaborators });
  });

  app.get("/api/v1/shared-with-me", { preHandler: requireSession }, async (request, reply) => {
    const items = await permissions.listSharedWithMe(request.session!.user_id);
    reply.send({ items });
  });

  app.post(
    "/api/v1/items/:type/:id/transfer-ownership",
    {
      preHandler: requireSession,
      schema: {
        body: { type: "object", required: ["newOwnerId"], properties: { newOwnerId: { type: "string" } } },
      },
    },
    async (request, reply) => {
      const { type, id } = request.params as { type: string; id: string };
      const { newOwnerId } = request.body as { newOwnerId: string };
      await permissions.transferOwnership(request.session!.user_id, parseItemType(type), id, newOwnerId);
      reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/items/:type/:id/share-links",
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: "object",
          required: ["role"],
          properties: {
            role: { type: "string", enum: ["viewer", "editor"] },
            password: { type: "string" },
            expiresAt: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { type, id } = request.params as { type: string; id: string };
      const body = request.body as { role: "viewer" | "editor"; password?: string; expiresAt?: string };
      const link = await shareLinks.createShareLink(request.session!.user_id, parseItemType(type), id, body.role, {
        password: body.password,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      });
      reply.code(201).send({ token: link.token, id: link.id });
    },
  );

  app.delete("/api/v1/share-links/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await shareLinks.revokeShareLink(request.session!.user_id, id);
    reply.code(204).send();
  });

  app.get("/api/v1/items/:type/:id/share-links", { preHandler: requireSession }, async (request, reply) => {
    const { type, id } = request.params as { type: string; id: string };
    const links = await shareLinks.listShareLinksForItem(request.session!.user_id, parseItemType(type), id);
    reply.send({ links });
  });

  // Deliberately no requireSession on any /public/share-links/* route below — REQUIREMENTS.md
  // §5.5: access without an account. `folderId` lets a folder-type link's visitor browse into
  // subfolders; share-link-service.ts's own scope check (not checkPermission — there's no
  // userId) is what keeps that walk confined to the shared subtree.
  app.post(
    "/api/v1/public/share-links/:token/unlock",
    {
      ...unlockRateLimit,
      schema: { body: { type: "object", required: ["password"], properties: { password: { type: "string" } } } },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const { password } = request.body as { password: string };
      const grant = await shareLinks.unlockShareLink(token, password);
      if (grant) setUnlockCookie(reply, token, grant);
      reply.code(204).send();
    },
  );

  app.get("/api/v1/public/share-links/:token", { ...publicRateLimit }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { folderId } = request.query as { folderId?: string };
    const contents = await shareLinks.getPublicFolderContents(token, readUnlockGrant(request), folderId);
    reply.send(contents);
  });

  app.get("/api/v1/public/share-links/:token/files/:fileId/download", { ...publicRateLimit }, async (request, reply) => {
    const { token, fileId } = request.params as { token: string; fileId: string };
    const url = await shareLinks.getPublicDownloadUrl(token, readUnlockGrant(request), fileId);
    reply.send({ url });
  });

  app.get("/api/v1/public/share-links/:token/files/:fileId/preview", { ...publicRateLimit }, async (request, reply) => {
    const { token, fileId } = request.params as { token: string; fileId: string };
    const preview = await shareLinks.getPublicPreviewUrl(token, readUnlockGrant(request), fileId);
    reply.send(preview ? { available: true, ...preview } : { available: false });
  });

  app.get("/api/v1/public/share-links/:token/files/:fileId/thumbnail", { ...publicRateLimit }, async (request, reply) => {
    const { token, fileId } = request.params as { token: string; fileId: string };
    const url = await shareLinks.getPublicThumbnailUrl(token, readUnlockGrant(request), fileId);
    reply.send(url ? { available: true, url } : { available: false });
  });

  app.get(
    "/api/v1/public/share-links/:token/folders/:folderId/download-zip",
    { ...publicZipRateLimit },
    async (request, reply) => {
      const { token, folderId } = request.params as { token: string; folderId: string };
        const { archive, folderName } = await shareLinks.getPublicFolderZipArchive(token, readUnlockGrant(request), folderId);
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(folderName)}.zip`);
      return reply.send(archive);
    },
  );
}
