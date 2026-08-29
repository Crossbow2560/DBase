import "fastify";
import type { sessions, users } from "@prisma/client";

declare module "fastify" {
  interface FastifyRequest {
    session?: sessions & { user: users };
    rawSessionToken?: string;
    // Set by the inbound-email plugin's own JSON body parser — the exact bytes Resend signed,
    // needed for Svix signature verification before the parsed body is trusted.
    rawBody?: string;
  }
}
