import type { FastifyInstance } from "fastify";
import { requireSession, syncBatchRateLimit, syncDownloadRateLimit } from "../accounts/guards.js";
import * as sync from "./service.js";
import { invalidCursor } from "./errors.js";

const uuid = { type: "string", format: "uuid" } as const;

export async function syncRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/sync/tree",
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: "object",
          required: ["root"],
          properties: { root: uuid, after: uuid, limit: { type: "integer", minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { root, after, limit } = request.query as { root: string; after?: string; limit?: number };
      reply.send(await sync.getTree(request.session!.user_id, root, after ?? null, limit ?? sync.MAX_TREE_PAGE));
    },
  );

  app.get(
    "/api/v1/sync/changes",
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: "object",
          required: ["root", "cursor"],
          properties: { root: uuid, cursor: { type: "string" }, limit: { type: "integer", minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { root, cursor, limit } = request.query as { root: string; cursor: string; limit?: number };
      // A string, not an integer: seqs are bigints and must survive JSON round trips exactly.
      if (!/^\d{1,19}$/.test(cursor)) throw invalidCursor();
      reply.send(await sync.getChanges(request.session!.user_id, root, BigInt(cursor), limit ?? sync.MAX_CHANGES_PAGE));
    },
  );

  app.post(
    "/api/v1/sync/download-urls",
    {
      preHandler: requireSession,
      ...syncDownloadRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["fileIds"],
          properties: { fileIds: { type: "array", items: uuid, minItems: 1, maxItems: sync.MAX_DOWNLOAD_URLS } },
        },
      },
    },
    async (request, reply) => {
      const { fileIds } = request.body as { fileIds: string[] };
      reply.send(await sync.getDownloadUrls(request.session!.user_id, fileIds));
    },
  );

  app.post(
    "/api/v1/sync/batch",
    {
      preHandler: requireSession,
      ...syncBatchRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["ops"],
          properties: {
            ops: {
              type: "array",
              minItems: 1,
              maxItems: sync.MAX_BATCH_OPS,
              items: {
                type: "object",
                required: ["type", "id"],
                additionalProperties: false,
                properties: {
                  type: { type: "string", enum: ["file", "folder"] },
                  id: uuid,
                  name: { type: "string" },
                  parentId: { anyOf: [uuid, { type: "null" }] },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { ops } = request.body as { ops: sync.BatchOp[] };
      reply.send(await sync.runBatch(request.session!.user_id, ops));
    },
  );
}
