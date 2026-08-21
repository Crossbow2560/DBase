### DBase

A file storage/sharing app: Fastify + Prisma backend, Next.js frontend, Postgres via Supabase, and MinIO for object storage.

- `src/` — backend (Fastify, port `3000`)
- `web/` — frontend (Next.js, port `3001`)
- `prisma/` — Prisma schema (models the DB; `supabase/migrations/` is the source of truth for DDL)
- `scripts/bootstrap-admin.ts` — one-time script to create the first admin account

See [APPLICATION_DESIGN.md](APPLICATION_DESIGN.md), [REQUIREMENTS.md](REQUIREMENTS.md), [FRONTEND_DESIGN.md](FRONTEND_DESIGN.md), and [IMPLEMENTATION_PHASES.md](IMPLEMENTATION_PHASES.md) for the full design.

## Prerequisites

- A Supabase project (Postgres database) — this app does not run its own Postgres
- Docker + Docker Compose, **or** Node.js 18+ (backend) and Node.js 22+ (frontend) with a locally running MinIO for a non-Docker setup

## Setup

1. Clone the repo and copy the env template:

   ```bash
   cp .env.example .env
   ```

2. Fill in `.env`:
   - `DATABASE_URL` / `DIRECT_URL` — from your Supabase dashboard under **Project Settings → Database → Connection string**. `DATABASE_URL` must be the pooled (port 6543) connection string; `DIRECT_URL` must be the direct (port 5432) one — it's only used for `prisma db pull`/`prisma generate`.
   - `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` — credentials for the MinIO container.
   - `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` — set these to the same values as `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` (only needed when running the backend outside Docker; Docker Compose maps them automatically).
   - Leave the other defaults unless you have a reason to change them.

3. Apply the database schema. This app **does not use `prisma migrate`** — the schema lives in `supabase/migrations/`, applied through the Supabase dashboard/CLI. Once the Supabase database has the migrations applied, generate the Prisma client against it:

   ```bash
   npm install
   npm run prisma:generate
   ```

## Run with Docker (recommended)

```bash
docker compose up --build
```

This starts three services:

| Service    | URL                              |
|------------|-----------------------------------|
| frontend   | http://localhost:3001            |
| backend    | http://localhost:3000            |
| MinIO API  | http://localhost:9000            |
| MinIO console | http://localhost:9001         |

The `minio-init` one-shot container creates the `dbase` bucket automatically on first run.

Create the first admin account:

```bash
docker compose exec backend npm run bootstrap:admin -- --email=admin@example.com --password=changeme123 --name="System Admin"
```

## Run without Docker

Backend:

```bash
npm install
docker compose up minio minio-init   # or run a local MinIO some other way
npm run prisma:generate
npm run dev                          # http://localhost:3000
```

Bootstrap the first admin:

```bash
npm run bootstrap:admin -- --email=admin@example.com --password=changeme123 --name="System Admin"
```

Frontend (separate terminal):

```bash
cd web
npm install
npm run dev                          # http://localhost:3001
```

Note: outside Docker, the frontend's `/api/v1/*` proxy rewrite defaults to `http://localhost:3000`, which matches the backend's default port above.

## Building for production

```bash
npm run build      # backend -> dist/
cd web && npm run build   # frontend -> .next/standalone
```

The frontend's API proxy target is baked in at build time via the `BACKEND_URL` build arg (see `web/Dockerfile` and `web/next.config.js`) — rebuild the frontend image if the backend's address changes.
