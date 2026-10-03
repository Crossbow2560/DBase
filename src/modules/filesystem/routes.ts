import type { FastifyInstance } from "fastify";
import { AppError } from "../accounts/errors.js";
import * as folders from "./folder-service.js";
import * as files from "./file-service.js";
import * as uploads from "./upload-service.js";
import { createFolderTree, MAX_TREE_FOLDERS } from "./folder-tree-service.js";
import * as thumbnails from "../thumbnails/thumbnail-service.js";
import { Readable } from "node:stream";
import { requireSession, requireSessionCountingFailures, writeHeavyRateLimit, noRateLimit } from "../accounts/guards.js";
import { lengthRequired, partTooLarge } from "./errors.js";
import { MAX_PART_SIZE_BYTES } from "../storage/client.js";

export async function filesystemRoutes(app: FastifyInstance) {
  app.get("/api/v1/folders/contents", { preHandler: requireSession }, async (request, reply) => {
    const result = await folders.getFolderContents(request.session!.user_id, null);
    reply.send(result);
  });

  app.get("/api/v1/folders/:id/contents", { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await folders.getFolderContents(request.session!.user_id, id);
    reply.send(result);
  });

  app.post(
    "/api/v1/folders",
    {
      preHandler: requireSession,
      ...writeHeavyRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" }, parentFolderId: { type: ["string", "null"] } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; parentFolderId?: string | null };
      const folder = await folders.createFolder(request.session!.user_id, body.parentFolderId ?? null, body.name);
      reply.code(201).send({ folder });
    },
  );

  // Folder uploads: the whole directory structure in one request (folder-tree-service.ts), then the
  // client uploads each file into its folder through the normal upload-session endpoints.
  app.post(
    "/api/v1/folders/tree",
    {
      preHandler: requireSession,
      ...writeHeavyRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["paths"],
          properties: {
            parentFolderId: { type: ["string", "null"], format: "uuid" },
            paths: {
              type: "array",
              minItems: 1,
              maxItems: MAX_TREE_FOLDERS,
              // Generous cap on raw input only; the real 4096-byte path limit (PATH_TOO_LONG) is
              // enforced by the service against the normalized, human-readable path.
              items: { type: "string", minLength: 1, maxLength: 32768 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { parentFolderId?: string | null; paths: string[] };
      const result = await createFolderTree(request.session!.user_id, body.parentFolderId ?? null, body.paths);
      reply.code(201).send(result);
    },
  );

  app.patch(
    "/api/v1/folders/:id",
    { preHandler: requireSession, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; parentFolderId?: string | null };
      const folder = await folders.moveOrRenameFolder(request.session!.user_id, id, body);
      reply.send({ folder });
    },
  );

  app.delete(
    "/api/v1/folders/:id",
    { preHandler: requireSession, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await folders.trashFolder(request.session!.user_id, id);
      reply.code(204).send();
    },
  );

  // REQUIREMENTS.md §5.5 marks this out of scope for the original phase — built anyway on direct
  // request. No rate limit, same reasoning as the upload-part endpoint below: bounded by the
  // folder's own contents and this being a slow streamed response, not a generic per-minute
  // request count. Streamed directly (folders.getFolderZipArchive's archive is a readable
  // stream), not buffered to a temp file first — the response starts as soon as the first file's
  // bytes are ready, not after the whole zip is built.
  app.get(
    "/api/v1/folders/:id/download-zip",
    { preHandler: requireSession, ...noRateLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { archive, folderName } = await folders.getFolderZipArchive(request.session!.user_id, id);
      reply.header("Content-Type", "application/zip");
      reply.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(folderName)}.zip`,
      );
      return reply.send(archive);
    },
  );

  app.patch(
    "/api/v1/files/:id",
    { preHandler: requireSession, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; folderId?: string | null };
      const file = await files.renameOrMoveFile(request.session!.user_id, id, body);
      reply.send({ file: files.serializeFile(file) });
    },
  );

  app.delete(
    "/api/v1/files/:id",
    { preHandler: requireSession, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await files.trashFile(request.session!.user_id, id);
      reply.code(204).send();
    },
  );

  // Home page "Recent Files": newest files anywhere under My Files, not just the root folder.
  app.get(
    "/api/v1/files/recent",
    {
      preHandler: requireSession,
      schema: {
        querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 6 } } },
      },
    },
    async (request, reply) => {
      const { limit } = request.query as { limit: number };
      reply.send({ items: await files.listRecentFiles(request.session!.user_id, limit) });
    },
  );

  app.get("/api/v1/files/:id/download", { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const url = await files.getDownloadUrl(request.session!.user_id, id);
    reply.send({ url });
  });

  // Click-to-open inline preview (image/video/audio/PDF) — "no preview available" is a normal
  // 200 response, same convention as the thumbnail endpoint below.
  app.get("/api/v1/files/:id/preview", { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const preview = await files.getPreviewUrl(request.session!.user_id, id);
    reply.send(preview ? { available: true, ...preview } : { available: false });
  });

  // REQUIREMENTS.md §5.9: "no preview available" is a normal 200 response ({available:false}),
  // never an error — covers not-thumbnailable, still-generating, and permanently-failed alike.
  app.get("/api/v1/files/:id/thumbnail", { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const url = await thumbnails.getThumbnailUrl(request.session!.user_id, id);
    reply.send(url ? { available: true, url } : { available: false });
  });

  app.post(
    "/api/v1/files",
    {
      preHandler: requireSession,
      // Higher than the general write-heavy 60/min: every file in a folder upload starts its own
      // session, so a 300-file folder would otherwise spend five minutes throttled. Starting a
      // session only inserts one short-lived row (cleaned up after UPLOAD_SESSION_TTL_MINUTES);
      // bytes and quota are bounded separately, per part.
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["targetName", "totalParts"],
          properties: {
            targetFolderId: { type: ["string", "null"] },
            targetName: { type: "string" },
            totalParts: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { targetFolderId?: string | null; targetName: string; totalParts: number };
      const result = await uploads.initUploadSession(request.session!.user_id, {
        targetFolderId: body.targetFolderId ?? null,
        targetName: body.targetName,
        totalParts: body.totalParts,
      });
      reply.code(201).send(result);
    },
  );

  app.put(
    "/api/v1/files/upload-sessions/:id/parts/:partNumber",
    {
      preHandler: requireSessionCountingFailures,
      config: { rateLimit: false, ipCeiling: "auth-failures-only" },
      schema: {
        params: {
          type: "object",
          required: ["id", "partNumber"],
          properties: { id: { type: "string", format: "uuid" }, partNumber: { type: "integer", minimum: 0 } },
        },
      },
    },
    async (request, reply) => {
      const { id, partNumber } = request.params as { id: string; partNumber: number };
      const body = request.body;
      if (!(body instanceof Readable)) {
        throw new AppError(400, "VALIDATION_ERROR", "Part body must be raw binary (application/octet-stream).");
      }
      // The declared length is what quota is charged for and what putPartStream holds the body to.
      const declared = request.headers["content-length"];
      const sizeBytes = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : NaN;
      if (!Number.isSafeInteger(sizeBytes)) throw lengthRequired();
      if (sizeBytes > MAX_PART_SIZE_BYTES) throw partTooLarge(MAX_PART_SIZE_BYTES);
      await uploads.uploadPart(request.session!.user_id, id, partNumber, body, sizeBytes);
      reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/files/upload-sessions/:id/complete",
    { preHandler: requireSession },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { mimeType?: string };
      const file = await uploads.completeUpload(request.session!.user_id, id, body.mimeType ?? "application/octet-stream");
      reply.send({ file: files.serializeFile(file) });
    },
  );

  app.delete(
    "/api/v1/files/upload-sessions/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await uploads.cancelUpload(request.session!.user_id, id);
      reply.code(204).send();
    },
  );
}
