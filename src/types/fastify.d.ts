import "fastify";
import type { sessions, users } from "@prisma/client";

declare module "fastify" {
  interface FastifyRequest {
    session?: sessions & { user: users };
    rawSessionToken?: string;
  }
}
