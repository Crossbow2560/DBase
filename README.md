# DBase

## 📚 Documentation
| | |
|---|---|
| [⚙️ Architecture](docs/architecture.md) | System design, components and flow |
| [📁 Structure](docs/structure.md) | Project organization and responsibilities |
| [🚀 Installation](docs/installation.md) | Requirements and steps to run the project |
| [🧠 Technical decisions](docs/decisions.md) | Trade-offs and design justifications |
| [📖 Usage guide](docs/usage.md) | How to use the project, flows and examples |
| [🔌 API](docs/api.md) | Endpoints, request/response and examples |
| [🧪 Testing](docs/testing.md) | How to run tests and coverage strategy |

The original design documents are kept alongside these: [REQUIREMENTS.md](docs/REQUIREMENTS.md), [DESIGN.md](docs/DESIGN.md), [APPLICATION_DESIGN.md](docs/APPLICATION_DESIGN.md), [FRONTEND_DESIGN.md](docs/FRONTEND_DESIGN.md), [IMPLEMENTATION_PHASES.md](docs/IMPLEMENTATION_PHASES.md).

---

## Description

DBase is a self-hosted file storage and sharing app, similar to a small Google Drive.

- **What it does:** users upload files into nested folders and share them with other users (viewer/editor roles, inherited through folders) or through public links that can have a password and an expiry. It also covers favorites, tags, search, trash with 30-day retention, thumbnails and inline previews, and zip downloads of folders.
- **What problem it solves:** it gives you a private, multi-user file store on your own hardware. File bytes stay in your own MinIO instance, metadata lives in Postgres, and per-user and system-wide storage quotas are enforced by the database.
- **Real use case:** a single Ubuntu host runs the whole stack with Docker Compose. A GitHub Actions self-hosted runner redeploys it on every push to `main`. An admin manages users, quotas, the system storage limit, MinIO backups and restores, the audit log and outbound/inbound email from the admin panel.

## Quick start

```bash
cp .env.example .env          # fill in DATABASE_URL, DIRECT_URL, MinIO creds, MINIO_KMS_SECRET_KEY
npm install
npm run migrate               # apply supabase/migrations/*.sql
npm run prisma:generate
docker compose up --build -d
docker compose exec -it backend npm run bootstrap:admin -- --email=admin@example.com --name="System Admin"
```

Open http://localhost:3001 and log in as the admin.

## Technologies used

| Layer | Stack |
|---|---|
| Backend | Node.js 22, TypeScript (ESM), Fastify 5, `@fastify/cookie`, `@fastify/rate-limit` |
| Data access | Prisma 6 (client only, no Prisma migrations), `pg` for the migration runner |
| Database | Supabase Postgres (`pg_trgm`, triggers, advisory locks, RLS enabled) |
| Object storage | MinIO (S3-compatible), SSE-S3 encryption at rest with the built-in KMS key |
| Media | `sharp` (images), `ffmpeg` (video frames), `poppler-utils` (PDF pages), `archiver` (zip streaming) |
| Auth | bcryptjs password hashing, opaque session tokens (SHA-256 hashed) in an httpOnly cookie |
| Email | Resend REST API (outbound), Svix-signed Resend webhooks (inbound) |
| Frontend | Next.js 15 (App Router, standalone output), React 19, TanStack Query 5, Tailwind CSS, Radix UI, lucide-react |
| Infra | Docker Compose (backend, frontend, minio, minio-init), GitHub Actions on a self-hosted runner |

## Quick installation

1. `cp .env.example .env` and fill in the Supabase connection strings and the MinIO secrets.
2. `npm install && npm run migrate && npm run prisma:generate`
3. `docker compose up --build`, then bootstrap the first admin.

Full guide: [docs/installation.md](docs/installation.md).

## Architecture (summary)

The backend is a single Fastify process split into domain modules: `accounts`, `filesystem`, `access`, `trash`, `organize`, `search`, `admin`, `lifecycle`, `email`, `thumbnails` and `storage`. In-process `setInterval` workers handle upload-session cleanup, the deletion queue and thumbnail generation. Every authorization decision goes through `access/permission-check.ts`, and every object-store call goes through `storage/client.ts`. The browser only ever talks to the Next.js origin, which proxies `/api/v1/*` to the backend, and file bytes are fetched straight from MinIO through presigned URLs. Invariants that must hold under concurrency (quotas, one owner per item, last admin) are enforced by Postgres triggers and constraints, not just by app code.

Details: [docs/architecture.md](docs/architecture.md).

## Project structure

```
.
├── src/                 # Fastify backend
│   ├── app.ts           # buildApp(): plugins, rate limits, error handler, routes
│   ├── server.ts        # listen + start background workers
│   ├── modules/         # one folder per domain (routes + services + errors)
│   ├── workers/         # setInterval background jobs
│   └── lib/             # password, tokens, email helpers
├── scripts/             # migrate.ts, bootstrap-admin.ts
├── supabase/migrations/ # SQL source of truth for the schema
├── prisma/              # schema.prisma (client generation only)
├── test/                # integration suites (real Postgres + MinIO) and a local preview env
├── web/                 # Next.js frontend
├── docs/                # documentation
└── docker-compose.yml   # backend, frontend, minio, minio-init
```

Details: [docs/structure.md](docs/structure.md).
