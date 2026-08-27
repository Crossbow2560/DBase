// Applies every not-yet-applied file under supabase/migrations/, in filename order (the numeric
// prefix is the ordering — same convention the files already follow), and records each one in a
// `_migrations` bookkeeping table so re-running this script is a no-op once everything is caught
// up. README.md still calls this "applied through the Supabase dashboard/CLI" — this script is
// what now does that automatically, wired into .github/workflows/deploy.yml's deploy step, run
// once per push to main, before the rebuilt containers start serving traffic.
//
// Talks to the database with a plain `pg` client, not Prisma's $executeRawUnsafe: several
// migrations (0001, 0002, 0008, 0015) define trigger functions with `$$`-quoted bodies containing
// their own internal semicolons. `pg`'s simple query protocol — used automatically for a plain,
// parameter-less query string — runs a whole multi-statement file exactly the way `psql` does;
// Prisma's raw-query methods are not guaranteed to.
//
// Uses DATABASE_URL (Supavisor's transaction-pooler connection, APPLICATION_DESIGN.md §1.3.1),
// not DIRECT_URL — found as a real deploy failure: DIRECT_URL's host
// (db.<ref>.supabase.co) only accepts IPv6, which this app's self-hosted Ubuntu runner has no
// outbound route to, while the pooler host is IPv4-reachable and is what the running app
// already talks to successfully via this same var. Transaction-mode pooling is not a problem
// here despite the name — each migration file below runs inside its own explicit
// begin/commit, so Supavisor holds one real backend connection for that whole transaction
// either way; DIRECT_URL is kept as a fallback purely for a local dev machine that does have
// IPv6 and no DATABASE_URL configured.
//
// Usage: npm run migrate

import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "supabase", "migrations");

async function main() {
  const connectionString = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!connectionString) {
    console.error("Missing DATABASE_URL/DIRECT_URL — nothing to connect to.");
    process.exit(1);
  }

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(
      `create table if not exists _migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );

    const { rows } = await client.query<{ name: string }>("select name from _migrations");
    const applied = new Set(rows.map((r) => r.name));

    let ranCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`Applying ${file}...`);

      // One transaction per file: either the whole migration lands and gets recorded, or neither
      // does — never a half-applied file silently marked as done.
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into _migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
      ranCount++;
    }

    console.log(ranCount === 0 ? "Database already up to date." : `Applied ${ranCount} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
