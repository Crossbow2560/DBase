import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { api, login, setupTestEnv, type TestEnv } from "./harness.js";

let env: TestEnv;

before(async () => {
  env = await setupTestEnv();
});

after(async () => {
  await env?.teardown();
});

const SCRIPT = fileURLToPath(new URL("../../scripts/bootstrap-admin.ts", import.meta.url));

// Runs the real script as a child process against this file's throwaway database (setupTestEnv
// already put DATABASE_URL/MINIO_* and DOTENV_CONFIG_PATH=/dev/null into process.env). stdin is
// not a TTY here, exactly like a non-interactive provisioning run.
function runBootstrap(args: string[], extraEnv: Record<string, string> = {}) {
  const { BOOTSTRAP_ADMIN_PASSWORD: _drop, ...baseEnv } = process.env;
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    env: { ...baseEnv, ...extraEnv },
    encoding: "utf8",
    input: "",
    timeout: 60_000,
  });
}

describe("bootstrap-admin never takes the password on argv (issue 10)", () => {
  test("--password is refused before touching the database", () => {
    const res = runBootstrap(["--email=a@test.local", "--password=hunter2hunter2"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--password is no longer accepted/);
  });

  test("without a TTY or BOOTSTRAP_ADMIN_PASSWORD it explains how to provide one", () => {
    const res = runBootstrap(["--email=a@test.local"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BOOTSTRAP_ADMIN_PASSWORD/);
  });

  test("BOOTSTRAP_ADMIN_PASSWORD creates a verified admin who can log in", async () => {
    const res = runBootstrap(["--email=first-admin@test.local", "--name=First Admin"], {
      BOOTSTRAP_ADMIN_PASSWORD: "a-strong-password",
    });
    assert.equal(res.status, 0, res.stderr);
    const cookie = await login(env, "first-admin@test.local", "a-strong-password");
    const me = await api(env, cookie).get("/auth/me");
    assert.equal(me.json().user.role, "admin");
  });
});
