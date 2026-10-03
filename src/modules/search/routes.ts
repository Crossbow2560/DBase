import type { FastifyInstance } from "fastify";
import { search } from "./search-service.js";
import { requireSession } from "../accounts/guards.js";

// Subcomponent 8 — backs the frontend's search page (web/app/(app)/search/page.tsx).
export async function searchRoutes(app: FastifyInstance) {
  app.get("/api/v1/search", { preHandler: requireSession }, async (request, reply) => {
    const { q } = request.query as { q?: string };
    const items = await search(request.session!.user_id, q ?? "");
    reply.send({ items });
  });
}
