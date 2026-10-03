// Runs the real backend (src/server.ts — app + workers) against the preview environment.
//   npm run preview:backend    (after `npm run test:db:up && npm run preview:seed`)
process.env.DOTENV_CONFIG_PATH = "/dev/null";

import { previewEnv } from "./env.js";

Object.assign(process.env, previewEnv());
await import("../../src/server.js");
