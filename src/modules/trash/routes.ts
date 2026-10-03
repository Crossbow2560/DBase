import type { FastifyInstance } from "fastify";
import * as deletionQueue from "./deletion-queue-service.js";
import * as restore from "./restore-service.js";
import { requireSession, parseItemType, writeHeavyRateLimit } from "../accounts/guards.js";

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
