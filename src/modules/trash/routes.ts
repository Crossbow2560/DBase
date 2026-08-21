import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { AppError } from "../accounts/errors.js";
import { resolveSession } from "../accounts/service.js";
import type { ItemType } from "../access/permission-check.js";
import * as deletionQueue from "./deletion-queue-service.js";
import * as restore from "./restore-service.js";

// Same duplicated-requireSession pattern as filesystem/routes.ts and access/routes.ts.
async function requireSession(request: FastifyRequest) {
  const rawToken = request.cookies[config.sessionCookieName];
  if (!rawToken) throw new AppError(401, "UNAUTHENTICATED", "Login required.");
  const session = await resolveSession(rawToken);
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Session is invalid or has expired.");
  request.session = session;
}

function parseItemType(raw: string): ItemType {
  if (raw !== "file" && raw !== "folder") {
    throw new AppError(400, "VALIDATION_ERROR", "type must be 'file' or 'folder'.");
  }
  return raw;
}

const writeHeavyRateLimit = {
  config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
} as const;

export async function trashRoutes(app: FastifyInstance) {
  app.get("/api/v1/trash", { preHandler: requireSession }, async (request, reply) => {
    const items = await deletionQueue.listTrash(request.session!.user_id);
    reply.send({ items });
  });

  app.post(
    "/api/v1/trash/:type/:id/restore",
    { preHandler: requireSession, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { type, id } = request.params as { type: string; id: string };
      await restore.restoreItem(request.session!.user_id, parseItemType(type), id);
      reply.code(204).send();
    },
  );

  app.delete(
    "/api/v1/trash/:type/:id",
    { preHandler: requireSession, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { type, id } = request.params as { type: string; id: string };
      await deletionQueue.purgeNow(request.session!.user_id, parseItemType(type), id);
      reply.code(204).send();
    },
  );
}
