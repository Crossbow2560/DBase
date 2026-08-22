#!/usr/bin/env node
// Loads the repo's single root .env, maps FRONTEND_PORT onto Next's own PORT env var (Next only
// ever looks at PORT, not FRONTEND_PORT — this file exists only because the frontend and backend
// share one env file and can't both claim PORT), then runs the given `next` subcommand.
//
// Only used for local (non-Docker) dev/start. Docker doesn't go through this: docker-compose.yml
// sets PORT directly on the frontend container's environment at runtime instead.
const path = require("node:path");
const { spawnSync } = require("node:child_process");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

// PORT in the shared root .env means "the backend's port" (src/config.ts). Stash it under a
// different name before overwriting PORT for Next's own bind, so next.config.js's rewrite-target
// default (which needs the backend's port) can still find it — see next.config.js.
process.env.BACKEND_PORT = process.env.BACKEND_PORT ?? process.env.PORT ?? "3000";
process.env.PORT = process.env.FRONTEND_PORT ?? "3001";

const args = process.argv.slice(2);
const result = spawnSync("next", args, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
