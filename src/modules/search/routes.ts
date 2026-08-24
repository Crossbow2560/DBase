import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { AppError } from "../accounts/errors.js";
import { resolveSession } from "../accounts/service.js";
import { search } from "./search-service.js";

async function requireSession(request: FastifyRequest) {
  const rawToken = request.cookies[config.sessionCookieName];
  if (!rawToken) throw new AppError(401, "UNAUTHENTICATED", "Login required.");
  const session = await resolveSession(rawToken);
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Session is invalid or has expired.");
  request.session = session;
}

// Subcomponent 8 — the frontend's search page (web/app/(app)/search/page.tsx) has called this
// exact route since it was scaffolded; nothing on the backend ever answered it until now.
export async function searchRoutes(app: FastifyInstance) {
  app.get("/api/v1/search", { preHandler: requireSession }, async (request, reply) => {
    const { q } = request.query as { q?: string };
    const items = await search(request.session!.user_id, q ?? "");
    reply.send({ items });
  });
}
