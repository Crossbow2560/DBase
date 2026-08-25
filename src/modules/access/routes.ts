import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { AppError } from "../accounts/errors.js";
import { resolveSession } from "../accounts/service.js";
import type { ItemType } from "./permission-check.js";
import * as permissions from "./permission-service.js";
import * as shareLinks from "./share-link-service.js";

// Same duplicated-requireSession pattern as filesystem/routes.ts — see that file's comment on
// why (APPLICATION_DESIGN.md §3.3's shared-module consolidation belongs to a later pass).
async function requireSession(request: FastifyRequest) {
  const rawToken = request.cookies[config.sessionCookieName];
  if (!rawToken) throw new AppError(401, "UNAUTHENTICATED", "Login required.");
  const session = await resolveSession(rawToken);
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Session is invalid or has expired.");
  request.session = session;
}

// Same reasoning as filesystem/routes.ts's identical constant: a slow streamed zip response,
// bounded by the shared folder's own contents, not a generic per-minute request count.
const noRateLimit = { config: { rateLimit: false } } as const;

function parseItemType(raw: string): ItemType {
  if (raw !== "file" && raw !== "folder") {
    throw new AppError(400, "VALIDATION_ERROR", "type must be 'file' or 'folder'.");
  }
  return raw;
}

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
  app.get("/api/v1/public/share-links/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const { password, folderId } = request.query as { password?: string; folderId?: string };
    const contents = await shareLinks.getPublicFolderContents(token, password, folderId);
    reply.send(contents);
  });

  app.get("/api/v1/public/share-links/:token/files/:fileId/download", async (request, reply) => {
    const { token, fileId } = request.params as { token: string; fileId: string };
    const { password } = request.query as { password?: string };
    const url = await shareLinks.getPublicDownloadUrl(token, password, fileId);
    reply.send({ url });
  });

  app.get("/api/v1/public/share-links/:token/files/:fileId/preview", async (request, reply) => {
    const { token, fileId } = request.params as { token: string; fileId: string };
    const { password } = request.query as { password?: string };
    const preview = await shareLinks.getPublicPreviewUrl(token, password, fileId);
    reply.send(preview ? { available: true, ...preview } : { available: false });
  });

  app.get("/api/v1/public/share-links/:token/files/:fileId/thumbnail", async (request, reply) => {
    const { token, fileId } = request.params as { token: string; fileId: string };
    const { password } = request.query as { password?: string };
    const url = await shareLinks.getPublicThumbnailUrl(token, password, fileId);
    reply.send(url ? { available: true, url } : { available: false });
  });

  app.get(
    "/api/v1/public/share-links/:token/folders/:folderId/download-zip",
    { ...noRateLimit },
    async (request, reply) => {
      const { token, folderId } = request.params as { token: string; folderId: string };
      const { password } = request.query as { password?: string };
      const { archive, folderName } = await shareLinks.getPublicFolderZipArchive(token, password, folderId);
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(folderName)}.zip`);
      return reply.send(archive);
    },
  );
}
