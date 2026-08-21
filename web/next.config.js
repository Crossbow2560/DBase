const path = require("node:path");

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
    const backendUrl = process.env.BACKEND_URL ?? "http://localhost:3000";
    return [
      {
        source: "/api/v1/:path*",
        destination: `${backendUrl}/api/v1/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
