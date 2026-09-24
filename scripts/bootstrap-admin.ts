// One-time setup script for the very first admin account on a fresh deployment
// (REQUIREMENTS.md §5.1: "the system must provide *some* mechanism for it, since without one
// no admin could ever be created" — implemented here as an operator-run CLI script rather than
// an HTTP endpoint, so there is no permanently-present "create an admin" attack surface).
//
// Usage:
//   npm run bootstrap:admin -- --email=admin@example.com --password=changeme123 --name="System Admin"

import "dotenv/config";
import { db } from "../src/db.js";
import { hashPassword, isPasswordStrongEnough } from "../src/lib/password.js";
import { config } from "../src/config.js";

function parseArgs() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args.set(match[1]!, match[2]!);
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const email = args.get("email");
  const password = args.get("password");
  const name = args.get("name") ?? "System Admin";

  if (!email || !password) {
    console.error('Usage: npm run bootstrap:admin -- --email=... --password=... [--name="..."]');
    process.exit(1);
  }

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
      storage_quota_bytes: config.defaultUserQuotaBytes,
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
          "system_settings.total_storage_limit_bytes or lower DEFAULT_USER_QUOTA_BYTES.",
      );
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
