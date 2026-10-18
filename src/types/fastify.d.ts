import "fastify";
import type { users } from "@prisma/client";

/**
 * The authenticated caller, set by accounts/guards.ts requireSession. `id` is the sessions row id
 * for a cookie login, or the device_tokens row id for a device token.
 */
export interface AuthSession {
  id: string;
  user_id: string;
  user: users;
  kind: "cookie" | "device";
}

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
    session?: AuthSession;
    rawSessionToken?: string;
    rawDeviceToken?: string;
    // Set by the inbound-email plugin's own JSON body parser — the exact bytes Resend signed,
    // needed for Svix signature verification before the parsed body is trusted.
    rawBody?: string;
  }
}
