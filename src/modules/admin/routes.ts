import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { AppError } from "../accounts/errors.js";
import { resolveSession } from "../accounts/service.js";
import * as admin from "./user-admin-service.js";
import * as lifecycle from "../lifecycle/lifecycle-service.js";

async function requireSession(request: FastifyRequest) {
  const rawToken = request.cookies[config.sessionCookieName];
  if (!rawToken) throw new AppError(401, "UNAUTHENTICATED", "Login required.");
  const session = await resolveSession(rawToken);
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Session is invalid or has expired.");
  request.session = session;
}

/**
 * DESIGN.md §4.2: the admin bypass inside checkPermission() governs item-level access; this is
 * the separate, coarser gate on the admin API surface itself — every route in this file is
 * admin-only regardless of any item-level permission.
 */
async function requireAdmin(request: FastifyRequest) {
  await requireSession(request);
  if (request.session!.user.role !== "admin") {
    throw new AppError(403, "INSUFFICIENT_PERMISSION", "Admin access required.");
  }
}

const writeHeavyRateLimit = {
  config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
} as const;

export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/users", { preHandler: requireAdmin }, async (_request, reply) => {
    const users = await admin.listUsers();
    reply.send({ users });
  });

  app.patch(
    "/api/v1/admin/users/:id/quota",
    {
      preHandler: requireAdmin,
      ...writeHeavyRateLimit,
      schema: {
        body: { type: "object", required: ["quotaBytes"], properties: { quotaBytes: { type: "integer" } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { quotaBytes } = request.body as { quotaBytes: number };
      await admin.changeQuota(request.session!.user_id, id, quotaBytes);
      reply.code(204).send();
    },
  );

  app.patch(
    "/api/v1/admin/users/:id/role",
    {
      preHandler: requireAdmin,
      ...writeHeavyRateLimit,
      schema: {
        body: { type: "object", required: ["role"], properties: { role: { type: "string", enum: ["user", "admin"] } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { role } = request.body as { role: "user" | "admin" };
      await admin.changeRole(request.session!.user_id, id, role);
      reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/admin/users/:id/deactivate",
    { preHandler: requireAdmin, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await lifecycle.deactivateAccount(request.session!.user_id, id);
      reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/admin/users/:id/reactivate",
    { preHandler: requireAdmin, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await lifecycle.reactivateAccount(request.session!.user_id, id);
      reply.code(204).send();
    },
  );

  app.delete(
    "/api/v1/admin/users/:id",
    { preHandler: requireAdmin, ...writeHeavyRateLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { replacementOwnerId?: string };
      await lifecycle.deleteAccount(request.session!.user_id, id, body.replacementOwnerId);
      reply.code(204).send();
    },
  );

  app.get("/api/v1/admin/users/:id/files", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { folderId } = request.query as { folderId?: string };
    const result = await admin.adminGetUserFiles(request.session!.user_id, id, folderId);
    reply.send(result);
  });

  app.get("/api/v1/admin/stats", { preHandler: requireAdmin }, async (_request, reply) => {
    const stats = await admin.getSystemStats();
    reply.send(stats);
  });

  app.get("/api/v1/admin/system-storage", { preHandler: requireAdmin }, async (_request, reply) => {
    const settings = await admin.getSystemStorageSettings();
    reply.send(settings);
  });

  app.patch(
    "/api/v1/admin/system-storage",
    {
      preHandler: requireAdmin,
      ...writeHeavyRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["totalStorageLimitBytes"],
          properties: { totalStorageLimitBytes: { type: "integer" } },
        },
      },
    },
    async (request, reply) => {
      const { totalStorageLimitBytes } = request.body as { totalStorageLimitBytes: number };
      await admin.setSystemStorageLimit(request.session!.user_id, totalStorageLimitBytes);
      reply.code(204).send();
    },
  );

  app.get("/api/v1/admin/activity", { preHandler: requireAdmin }, async (_request, reply) => {
    const entries = await admin.listActivity();
    reply.send({ entries });
  });

  app.get("/api/v1/admin/failed-jobs", { preHandler: requireAdmin }, async (_request, reply) => {
    const jobs = await admin.listFailedDeletions();
    reply.send({ jobs });
  });
}
