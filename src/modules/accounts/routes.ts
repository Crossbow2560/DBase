import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { requireSession, unauthenticatedRateLimit } from "./guards.js";
import * as accounts from "./service.js";
import * as lifecycle from "../lifecycle/lifecycle-service.js";

const emailSchema = { type: "string", format: "email" } as const;
const passwordSchema = { type: "string", minLength: 8 } as const;

function setSessionCookie(reply: import("fastify").FastifyReply, rawToken: string, expiresAt: Date) {
  reply.setCookie(config.sessionCookieName, rawToken, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function accountRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/auth/register",
    {
      ...unauthenticatedRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["email", "password", "displayName"],
          properties: {
            email: emailSchema,
            password: passwordSchema,
            displayName: { type: "string", minLength: 1, maxLength: 255 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string; displayName: string };
      const user = await accounts.register(body);
      reply.code(201).send({ user });
    },
  );

  app.post(
    "/api/v1/auth/login",
    {
      ...unauthenticatedRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: { email: emailSchema, password: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string };
      const deviceInfo = request.headers["user-agent"];
      const result = await accounts.login({ ...body, deviceInfo });
      setSessionCookie(reply, result.rawToken, result.expiresAt);
      reply.send({ user: result.user });
    },
  );

  app.get("/api/v1/auth/me", { preHandler: requireSession }, async (request, reply) => {
    const user = request.session!.user;
    reply.send({
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
    });
  });

  // A separate route from /auth/me by decision — quota is polled/refreshed independently of
  // identity (e.g. after every upload/delete), and keeping it off the identity payload avoids
  // re-fetching/re-rendering auth state just to refresh a byte count.
  app.get("/api/v1/users/me/storage", { preHandler: requireSession }, async (request, reply) => {
    const usage = await accounts.getStorageUsage(request.session!.user_id);
    reply.send(usage);
  });

  app.get("/api/v1/users/me/storage-breakdown", { preHandler: requireSession }, async (request, reply) => {
    const breakdown = await accounts.getStorageBreakdown(request.session!.user_id);
    reply.send(breakdown);
  });

  // Backs the share dialog's "share with" input — resolves an email to a userId. Telling a sharer
  // whether an address has an account is inherent to sharing, but it also makes this an account-
  // enumeration oracle for any logged-in user, so it gets a much tighter bound than the general
  // 300/min: plenty for typing collaborators' addresses, useless for sweeping a list of emails.
  app.get(
    "/api/v1/users/lookup",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { querystring: { type: "object", properties: { email: emailSchema } } },
    },
    async (request, reply) => {
      const { email } = request.query as { email: string };
      const user = await accounts.lookupUserByEmail(email);
      reply.send({ user });
    },
  );

  app.patch(
    "/api/v1/users/me",
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: "object",
          properties: { displayName: { type: "string", minLength: 1, maxLength: 255 } },
        },
      },
    },
    async (request, reply) => {
      const { displayName } = request.body as { displayName?: string };
      const user = await accounts.updateProfile(request.session!.user_id, { displayName });
      reply.send({ user });
    },
  );

  app.post(
    "/api/v1/auth/change-password",
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: { currentPassword: { type: "string" }, newPassword: passwordSchema },
        },
      },
    },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body as { currentPassword: string; newPassword: string };
      await accounts.changePassword(request.session!.user_id, request.session!.id, currentPassword, newPassword);
      reply.code(204).send();
    },
  );

  // REQUIREMENTS.md §5.1.1: self-service deletion — always uses the default reassignment
  // policy (lifecycle-service.deleteAccount enforces this regardless of what's passed here).
  app.delete("/api/v1/users/me", { preHandler: requireSession }, async (request, reply) => {
    const userId = request.session!.user_id;
    await lifecycle.deleteAccount(userId, userId);
    reply.clearCookie(config.sessionCookieName, { path: "/" });
    reply.code(204).send();
  });

  app.post("/api/v1/auth/logout", { preHandler: requireSession }, async (request, reply) => {
    await accounts.logout(request.rawSessionToken!);
    reply.clearCookie(config.sessionCookieName, { path: "/" });
    reply.code(204).send();
  });

  app.get("/api/v1/auth/sessions", { preHandler: requireSession }, async (request, reply) => {
    const sessions = await accounts.listSessions(request.session!.user_id);
    reply.send({ sessions });
  });

  app.delete(
    "/api/v1/auth/sessions/:sessionId",
    { preHandler: requireSession },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      await accounts.revokeSession(request.session!.user_id, sessionId);
      reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/auth/password-reset/request",
    {
      ...unauthenticatedRateLimit,
      schema: {
        body: { type: "object", required: ["email"], properties: { email: emailSchema } },
      },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };
      await accounts.requestPasswordReset(email);
      // Always 200, regardless of whether the email exists (REQUIREMENTS.md §5.1 non-enumeration).
      reply.send({ message: "If that email is registered, a reset link has been sent." });
    },
  );

  app.post(
    "/api/v1/auth/verify-email",
    {
      schema: { body: { type: "object", required: ["token"], properties: { token: { type: "string" } } } },
    },
    async (request, reply) => {
      const { token } = request.body as { token: string };
      await accounts.verifyEmail(token);
      reply.send({ message: "Email verified. You can now log in." });
    },
  );

  app.post(
    "/api/v1/auth/resend-verification",
    {
      ...unauthenticatedRateLimit,
      schema: {
        body: { type: "object", required: ["email"], properties: { email: emailSchema } },
      },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };
      await accounts.resendVerificationEmail(email);
      // Always 200, regardless of whether the email exists or is already verified — same
      // non-enumeration reasoning as password-reset/request below.
      reply.send({ message: "If that email is registered and unverified, a new link has been sent." });
    },
  );

  app.post(
    "/api/v1/auth/password-reset/confirm",
    {
      schema: {
        body: {
          type: "object",
          required: ["token", "newPassword"],
          properties: { token: { type: "string" }, newPassword: passwordSchema },
        },
      },
    },
    async (request, reply) => {
      const { token, newPassword } = request.body as { token: string; newPassword: string };
      await accounts.confirmPasswordReset(token, newPassword);
      reply.send({ message: "Password updated. Please log in again." });
    },
  );
}
