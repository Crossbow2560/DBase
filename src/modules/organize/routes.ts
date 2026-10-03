import type { FastifyInstance } from "fastify";
import * as favorites from "./favorite-service.js";
import * as tags from "./tag-service.js";
import { requireSession, parseItemType, writeHeavyRateLimit } from "../accounts/guards.js";

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

  app.patch(
    "/api/v1/tags/:id",
    {
      preHandler: requireSession,
      ...writeHeavyRateLimit,
      schema: { body: { type: "object", properties: { color: { type: ["string", "null"] } } } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { color } = request.body as { color?: string | null };
      await tags.updateTagColor(request.session!.user_id, id, color ?? null);
      reply.code(204).send();
    },
  );

  app.delete("/api/v1/tags/:id", { preHandler: requireSession, ...writeHeavyRateLimit }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await tags.deleteTag(request.session!.user_id, id);
    reply.code(204).send();
  });

  app.get("/api/v1/tags/:id/items", { preHandler: requireSession }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const items = await tags.listItemsByTag(request.session!.user_id, id);
    reply.send({ items });
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
