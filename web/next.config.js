const path = require("node:path");

// The frontend has no env file of its own — it shares the repo's single root .env (see
// .env.example at the repo root). dotenv never overwrites a var that's already set in
// process.env, so this is a no-op both in Docker (where BACKEND_URL/PORT arrive via
// docker-compose.yml instead, and this file doesn't even exist inside the build context) and
// whenever a shell has already exported these itself.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker deployment (decision: Ubuntu host, Docker wherever possible) needs a minimal,
  // self-contained server bundle rather than requiring the full node_modules tree at runtime —
  // "standalone" traces only the dependencies actually used and emits a runnable server.js.
  output: "standalone",
  // web/ and the backend at the repo root are two genuinely separate npm projects (each with
  // its own package-lock.json), not an accidental monorepo — pin the root explicitly so Next
  // doesn't guess wrong and warn about it.
  outputFileTracingRoot: path.join(__dirname),
  experimental: {
    // Every request this server proxies to the backend (the /api/v1 rewrite below) passes through
    // Next's cloneable-body layer, which silently TRUNCATES bodies beyond this size (default 10 MB)
    // and holds a copy of the body in memory while proxying. Upload parts are up to 32 MiB
    // (web/lib/uploads.tsx; the backend accepts up to 64 MiB), so the default broke every part
    // larger than 10 MB — the backend's exact-length check rejected the truncated bodies.
    middlewareClientMaxBodySize: "70mb",
  },
  // FRONTEND_DESIGN.md §7: a rewrite, not a hand-written Route Handler — a rewrite transparently
  // forwards the request (including the Cookie header) by construction. A Route Handler that
  // manually re-forwarded headers would risk silently dropping the session cookie on a
  // forgotten header, reopening the exact auth gap this reverse-proxy exists to close.
  // IMPORTANT: this function runs once at `next build` time, not per-request at runtime —
  // process.env.BACKEND_URL here is whatever was set when the image was built (web/Dockerfile's
  // ARG/ENV BACKEND_URL), not whatever docker-compose.yml's `environment:` sets at container
  // start. A runtime-only env var here would silently do nothing; this was a real bug, found by
  // running the built container and seeing the proxy hit localhost:3000 instead of backend:3000
  // despite the container's own environment being correct.
  async rewrites() {
    // Non-Docker default: frontend and backend are two processes on the same machine, so the
    // backend's own port (root .env's PORT) is reachable at localhost:<that port>. Docker
    // overrides BACKEND_URL explicitly (docker-compose.yml) to Docker-internal "backend:<port>"
    // instead. BACKEND_PORT (not PORT) below because scripts/with-frontend-port.js overwrites
    // process.env.PORT with FRONTEND_PORT before this file ever runs, for Next's own bind — see
    // its comment. Plain `next build` (no wrapper) never touches PORT, so it's still the
    // backend's port there and the process.env.PORT fallback covers that case.
    const backendUrl =
      process.env.BACKEND_URL ?? `http://localhost:${process.env.BACKEND_PORT ?? process.env.PORT ?? 3000}`;
    return [
      {
        source: "/api/v1/:path*",
        destination: `${backendUrl}/api/v1/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
