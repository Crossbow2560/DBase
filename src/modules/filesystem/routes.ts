import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { AppError } from "../accounts/errors.js";
import { resolveSession } from "../accounts/service.js";
import * as folders from "./folder-service.js";
import * as files from "./file-service.js";
import * as uploads from "./upload-service.js";
import * as thumbnails from "../thumbnails/thumbnail-service.js";

// Subcomponent 1 stub: every route here requires a session (via the same requireSession guard
// pattern as accounts/routes.ts) but does NOT yet check EFFECTIVE_PERMISSIONS/sharing — that's
// Subcomponent 2. Every service function scopes to owner_id itself (folder-service.ts's header
// comment explains why that's a safe stub, not a bypass).
//
// Mirrors accounts/routes.ts's requireSession rather than importing it directly — duplicated
// for now; consolidating into one shared auth precondition belongs to whichever subcomponent
// first needs a THIRD module to share it (APPLICATION_DESIGN.md §3.3 will want this factored
// out once `access` exists as its own module).
async function requireSession(request: FastifyRequest) {
  const rawToken = request.cookies[config.sessionCookieName];
  if (!rawToken) throw new AppError(401, "UNAUTHENTICATED", "Login required.");
  const session = await resolveSession(rawToken);
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Session is invalid or has expired.");
  request.session = session;
}

// APPLICATION_DESIGN.md §4.7: folder/file create, move, delete are the "write-heavy" class —
// a tighter bound (60/min) than the general authenticated default (300/min, server.ts),
// separate from the read-heavy listing/download endpoints below.
const writeHeavyRateLimit = {
  config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
} as const;

// §4.7's table excludes multipart upload part endpoints from the general per-minute counters
// entirely — bounded instead by UPLOAD_SESSIONS.total_parts and the session's own lifecycle
// (DESIGN.md §3.5), not a generic request-rate limiter. A large legitimate upload can exceed a
// generic per-minute count without being abusive.
const noRateLimit = { config: { rateLimit: false } } as const;

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
      ...writeHeavyRateLimit,
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
    { preHandler: requireSession, ...noRateLimit },
    async (request, reply) => {
      const { id, partNumber } = request.params as { id: string; partNumber: string };
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new AppError(400, "VALIDATION_ERROR", "Part body must be raw binary data.");
      }
      await uploads.uploadPart(request.session!.user_id, id, Number(partNumber), body);
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
