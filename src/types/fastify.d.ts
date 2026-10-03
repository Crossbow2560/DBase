import "fastify";
import type { sessions, users } from "@prisma/client";

declare module "fastify" {
  interface FastifyContextConfig {
    // "auth-failures-only": skip the per-IP ceiling in app.ts for this route; the route's guard
    // counts failed authentications against it instead (upload parts).
    ipCeiling?: "auth-failures-only";
  }

  interface FastifyInstance {
    enforceIpCeiling(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }

  interface FastifyRequest {
    session?: sessions & { user: users };
    rawSessionToken?: string;
    // Set by the inbound-email plugin's own JSON body parser — the exact bytes Resend signed,
    // needed for Svix signature verification before the parsed body is trusted.
    rawBody?: string;
  }
}
