import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { AppError } from "../accounts/errors.js";
import { resolveSession } from "../accounts/service.js";
import type { ItemType } from "../access/permission-check.js";
import * as favorites from "./favorite-service.js";
import * as tags from "./tag-service.js";

// Same duplicated-requireSession pattern as every other module's routes.ts.
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

export async function organizeRoutes(app: FastifyInstance) {
  app.get("/api/v1/favorites", { preHandler: requireSession }, async (request, reply) => {
    const items = await favorites.listFavorites(request.session!.user_id);
    reply.send({ items });
  });

  app.post(
    "/api/v1/items/:type/:id/favorite",
    { preHandler: requireSession, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { type, id } = request.params as { type: string; id: string };
      await favorites.addFavorite(request.session!.user_id, parseItemType(type), id);
      reply.code(204).send();
    },
  );

  app.delete(
    "/api/v1/items/:type/:id/favorite",
    { preHandler: requireSession, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { type, id } = request.params as { type: string; id: string };
      await favorites.removeFavorite(request.session!.user_id, parseItemType(type), id);
      reply.code(204).send();
    },
  );

  app.get("/api/v1/tags", { preHandler: requireSession }, async (request, reply) => {
    const items = await tags.listTags(request.session!.user_id);
    reply.send({ tags: items });
  });

  app.post(
    "/api/v1/tags",
    {
      preHandler: requireSession,
      ...writeHeavyRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" }, color: { type: ["string", "null"] } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; color?: string | null };
      const tag = await tags.createTag(request.session!.user_id, body.name, body.color);
      reply.code(201).send({ tag });
    },
  );

  app.delete("/api/v1/tags/:id", { preHandler: requireSession, ...writeHeavyRateLimit }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await tags.deleteTag(request.session!.user_id, id);
    reply.code(204).send();
  });

  app.get("/api/v1/items/:type/:id/tags", { preHandler: requireSession }, async (request, reply) => {
    const { type, id } = request.params as { type: string; id: string };
    const items = await tags.listItemTags(request.session!.user_id, parseItemType(type), id);
    reply.send({ tags: items });
  });

  app.post(
    "/api/v1/items/:type/:id/tags",
    {
      preHandler: requireSession,
      ...writeHeavyRateLimit,
      schema: { body: { type: "object", required: ["tagId"], properties: { tagId: { type: "string" } } } },
    },
    async (request, reply) => {
      const { type, id } = request.params as { type: string; id: string };
      const { tagId } = request.body as { tagId: string };
      await tags.applyTag(request.session!.user_id, parseItemType(type), id, tagId);
      reply.code(204).send();
    },
  );

  app.delete(
    "/api/v1/items/:type/:id/tags/:tagId",
    { preHandler: requireSession, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { type, id, tagId } = request.params as { type: string; id: string; tagId: string };
      await tags.removeTag(request.session!.user_id, parseItemType(type), id, tagId);
      reply.code(204).send();
    },
  );
}
