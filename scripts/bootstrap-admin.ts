// One-time setup script for the very first admin account on a fresh deployment
// (REQUIREMENTS.md §5.1: "the system must provide *some* mechanism for it, since without one
// no admin could ever be created" — implemented here as an operator-run CLI script rather than
// an HTTP endpoint, so there is no permanently-present "create an admin" attack surface).
//
// Usage (interactive — the password is prompted for, hidden, and confirmed):
//   npm run bootstrap:admin -- --email=admin@example.com --name="System Admin"
//   docker compose exec -it backend npm run bootstrap:admin -- --email=admin@example.com
// Non-interactive (CI, provisioning): pass the password through the environment instead:
//   BOOTSTRAP_ADMIN_PASSWORD=... npm run bootstrap:admin -- --email=admin@example.com
//
// The password is deliberately NOT accepted as a command-line flag: argv is visible to every user
// on the machine (`ps`) and lands in shell history.

import "dotenv/config";
import { db } from "../src/db.js";
import { hashPassword, isPasswordStrongEnough } from "../src/lib/password.js";
import { getDefaultUserQuotaBytes } from "../src/modules/accounts/default-quota.js";

function parseArgs() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args.set(match[1]!, match[2]!);
  }
  return args;
}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error("No terminal to prompt on — set BOOTSTRAP_ADMIN_PASSWORD, or run with a TTY (docker compose exec -it ...)."),
    );
  }
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  const first = await promptHidden("Admin password: ");
  const second = await promptHidden("Confirm password: ");
  if (first !== second) throw new Error("Passwords don't match.");
  return first;
}

async function main() {
  const args = parseArgs();
  const email = args.get("email");
  const name = args.get("name") ?? "System Admin";

  if (args.has("password")) {
    console.error(
      "--password is no longer accepted (it would be visible in `ps` and shell history). " +
        "Omit it to be prompted, or set BOOTSTRAP_ADMIN_PASSWORD.",
    );
    process.exit(1);
  }
  if (!email) {
    console.error('Usage: npm run bootstrap:admin -- --email=... [--name="..."]  (password is prompted for)');
    process.exit(1);
  }

  const password = await readPassword();

  if (!isPasswordStrongEnough(password)) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const existingAdminCount = await db.users.count({ where: { role: "admin" } });
  if (existingAdminCount > 0) {
    console.error(
      `Refusing to run: ${existingAdminCount} admin account(s) already exist. ` +
        "This script is only for bootstrapping the very first admin on a fresh deployment — " +
        "promote further admins through the regular admin API instead.",
    );
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const admin = await db.users.upsert({
    where: { email },
    create: {
      email,
      password_hash: passwordHash,
      display_name: name,
      role: "admin",
      storage_quota_bytes: await getDefaultUserQuotaBytes(),
      // Whoever runs this script already controls the deployment — there's no one to prove
      // the email to, and login() refuses unverified accounts. Verifying is also what allocates
      // the quota out of the system storage limit (supabase/migrations/0022).
      email_verified: true,
    },
    update: {
      role: "admin",
      password_hash: passwordHash,
      email_verified: true,
    },
  });

  console.log(`Admin account ready: ${admin.email} (${admin.id})`);
}

main()
  .catch((err) => {
    if (err instanceof Error && err.message.includes("SYSTEM_STORAGE_ALLOCATION_EXCEEDED")) {
      console.error(
        "Not enough unallocated system storage for the admin's quota — raise " +
          "system_settings.total_storage_limit_bytes or lower the default quota for new users.",
      );
      process.exit(1);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
