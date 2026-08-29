import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { AppError } from "../accounts/errors.js";
import { resolveSession, getStorageBreakdown, getSystemStorageBreakdown } from "../accounts/service.js";
import * as admin from "./user-admin-service.js";
import * as lifecycle from "../lifecycle/lifecycle-service.js";
import * as backup from "./backup-service.js";
import { sendAdminEmail } from "./notify-service.js";

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

  // Backs the admin stats page's system-wide MultiRingChart — same shape as the per-user
  // GET /users/me/storage-breakdown the home page's own MultiRingChart already consumes.
  app.get("/api/v1/admin/system-storage-breakdown", { preHandler: requireAdmin }, async (_request, reply) => {
    const breakdown = await getSystemStorageBreakdown();
    reply.send(breakdown);
  });

  // Same breakdown, for whichever user the admin picks in the per-user selector — reuses the
  // exact query a user runs on themselves, just without the requester === owner restriction
  // (requireAdmin above is the gate here, same pattern as adminGetUserFiles).
  app.get("/api/v1/admin/users/:id/storage-breakdown", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const breakdown = await getStorageBreakdown(id);
    reply.send(breakdown);
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

  app.post(
    "/api/v1/admin/send-email",
    {
      preHandler: requireAdmin,
      ...writeHeavyRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["to", "subject", "body"],
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { to, subject, body } = request.body as { to: string; subject: string; body: string };
      await sendAdminEmail({ to, subject, body });
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

  // Stricter than writeHeavyRateLimit above — these walk and server-side-copy every object in a
  // bucket, so they're the admin actions here with a real per-call cost worth throttling harder
  // than a routine PATCH.
  const backupRateLimit = { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } } as const;

  app.post("/api/v1/admin/backup", { preHandler: requireAdmin, ...backupRateLimit }, async (request, reply) => {
    const result = await backup.runBackup(request.session!.user_id);
    reply.send(result);
  });

  // The restore page's picklist of available backups — cheap (one listBuckets call), so this
  // deliberately isn't behind backupRateLimit above.
  app.get("/api/v1/admin/backups", { preHandler: requireAdmin }, async (_request, reply) => {
    const backups = await backup.listBackups();
    reply.send({ backups });
  });

  app.post(
    "/api/v1/admin/backups/:name/restore",
    { preHandler: requireAdmin, ...backupRateLimit },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      const result = await backup.restoreBackup(request.session!.user_id, name);
      reply.send(result);
    },
  );
}
