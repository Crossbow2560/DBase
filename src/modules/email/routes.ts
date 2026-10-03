import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { AppError } from "../accounts/errors.js";
import { publicRateLimit } from "../accounts/guards.js";
import { storeInboundEmail, verifySvixSignature } from "./inbound-service.js";

/**
 * Inbound email from Resend. Resend's inbound feature delivers each received message to this
 * endpoint as a Svix-signed webhook (see .env.example's RESEND_WEBHOOK_SECRET). The parsed body
 * is only trusted after the signature over the exact received bytes checks out — hence the
 * plugin-local JSON parser below that stashes the raw string on the request.
 *
 * This is a public route (no session): the signature IS the authentication.
 */
export async function emailRoutes(app: FastifyInstance) {
  // Encapsulated to this plugin only — overrides the built-in JSON parser so we keep the raw
  // bytes Svix signed, then still hand a parsed object to the handler.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, bodyString, done) => {
    (req as { rawBody?: string }).rawBody = bodyString as string;
    if (!bodyString) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(bodyString as string));
    } catch {
      done(new AppError(400, "INVALID_JSON", "Body is not valid JSON."), undefined);
    }
  });

  app.post("/api/v1/email/inbound", { ...publicRateLimit }, async (request, reply) => {
    const secret = config.email.inboundWebhookSecret;
    if (!secret) {
      // Never accept unsigned inbound mail — without a configured secret there is no way to know
      // a POST here actually came from Resend.
      throw new AppError(401, "INBOUND_NOT_CONFIGURED", "Inbound email is not configured.");
    }

    const headers = request.headers;
    const ok = verifySvixSignature({
      secret,
      id: String(headers["svix-id"] ?? ""),
      timestamp: String(headers["svix-timestamp"] ?? ""),
      signatureHeader: String(headers["svix-signature"] ?? ""),
      rawBody: request.rawBody ?? "",
    });
    if (!ok) throw new AppError(401, "INVALID_SIGNATURE", "Webhook signature verification failed.");

    // Resend sends non-inbound webhook types here too if the endpoint is subscribed broadly —
    // ignore anything that isn't an inbound message rather than erroring.
    const body = request.body as { type?: string } | undefined;
    const type = body?.type ?? "";
    if (type && !/received|inbound/i.test(type)) {
      reply.code(204).send();
      return;
    }

    await storeInboundEmail(request.body);
    reply.code(204).send();
  });
}
