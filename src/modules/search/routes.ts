import type { FastifyInstance } from "fastify";
import { search, searchWithin } from "./search-service.js";
import { requireSession } from "../accounts/guards.js";

// Subcomponent 8 — backs the frontend's search page (web/app/(app)/search/page.tsx).
export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/search",
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: "object",
          properties: {
            q: { type: "string", maxLength: 255 },
            // A folder id, or "mine" (My Files root): search that subtree at any depth, with each
            // result's location. Omitted: search everything the user can access (/search page).
            within: { anyOf: [{ type: "string", format: "uuid" }, { type: "string", const: "mine" }] },
          },
        },
      },
    },
    async (request, reply) => {
      const { q, within } = request.query as { q?: string; within?: string };
      if (within) {
        reply.send(await searchWithin(request.session!.user_id, q ?? "", within));
        return;
      }
      const items = await search(request.session!.user_id, q ?? "");
      reply.send({ items });
    },
  );
}
