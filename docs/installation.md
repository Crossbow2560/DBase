# Installation

## Prerequisites

- **Supabase project:** you need one for Postgres. The stack does not run its own database.
- **Docker and Docker Compose:** the recommended way to run the stack.
- **Without Docker:** Node.js 18 or newer for the backend (the images use Node 22), Node.js 22 for the frontend, and a reachable MinIO (or any S3-compatible) endpoint.
- **For thumbnails outside Docker:** `ffmpeg` and `pdftoppm` (from `poppler-utils`) on the `PATH`. The backend image already includes them.
- **Optional:** a [Resend](https://resend.com) account for real email. Without one, emails are printed to the backend log.

## 1. Clone

```bash
git clone <repo-url> DBase
cd DBase
```

## 2. Install dependencies

```bash
npm install
cd web && npm install && cd ..
```

## 3. Configure environment

```bash
cp .env.example .env
```

The root `.env` is the **only** config file. The backend, `docker-compose.yml`, `web/next.config.js` and `web/scripts/with-frontend-port.js` all read it.

**Required**

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase **pooled** connection string (Supavisor transaction mode, port `6543`). Used by the app and by `npm run migrate`. |
| `DIRECT_URL` | Direct connection (port `5432`). Used only by `prisma db pull`. Supabase's direct host is IPv6-only. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO credentials used by the containers |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Set these to the same values as above. Only read when the backend runs outside Docker, because compose maps them automatically. |
| `MINIO_KMS_SECRET_KEY` | `<name>:<32-byte base64>`. Generate one with `echo "dbase-master:$(openssl rand -base64 32)"`. Use a different key per environment. |

**Ports** (each value is both the container port and the published host port)

| Variable | Default |
|---|---|
| `PORT` (backend) | `3000` |
| `FRONTEND_PORT` | `3001` |
| `MINIO_PORT` | `9000` |
| `MINIO_CONSOLE_PORT` | `9001` |

**Change these for any non-localhost deployment**

| Variable | Why |
|---|---|
| `MINIO_PUBLIC_ENDPOINT` / `MINIO_PUBLIC_PORT` / `MINIO_PUBLIC_USE_SSL` | The host the **browser** uses to load presigned URLs. If you leave it as `localhost`, downloads and thumbnails break for every remote user. |
| `PUBLIC_APP_URL` | The frontend origin used in verification and password-reset email links |
| `BACKEND_URL` | Only needed if the frontend and backend don't share this compose file. It is a build-time value, so you must rebuild the frontend image after changing it. |

**Optional:** `SESSION_TTL_DAYS` (30), `DEFAULT_USER_QUOTA_BYTES` (15 GiB), `PASSWORD_RESET_TTL_MINUTES` (30), `EMAIL_VERIFICATION_TTL_HOURS` (24), `UPLOAD_SESSION_TTL_MINUTES` (60), `TRASH_RETENTION_DAYS` (30), `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `EMAIL_INBOUND_ADDRESS`.

## 4. Apply the database schema

The schema lives in `supabase/migrations/` and is applied by a plain SQL runner, **not** `prisma migrate`:

```bash
npm run migrate
npm run prisma:generate
```

`migrate` records every applied file in a `_migrations` table, so running it again does nothing once the database is up to date. The deploy workflow runs it automatically before restarting containers.

> Never run `prisma migrate dev` or `prisma db push` against this database. The migrations rely on triggers, deferrable constraints and generated columns that Prisma doesn't model.

## 5. Run

### With Docker (recommended)

```bash
docker compose up --build
```

`minio-init` creates the `dbase` bucket and turns on SSE-S3 default encryption on first start.

Create the first admin:

```bash
docker compose exec backend npm run bootstrap:admin -- --email=admin@example.com --password=changeme123 --name="System Admin"
```

The script refuses to run if an admin already exists. Promote further admins from the admin UI instead.

### Without Docker

Backend:

```bash
docker compose up -d minio minio-init   # or any S3-compatible endpoint
npm run dev                             # tsx watch, http://localhost:3000
npm run bootstrap:admin -- --email=admin@example.com --password=changeme123 --name="System Admin"
```

Frontend, in a separate terminal:

```bash
cd web
npm run dev                             # http://localhost:3001
```

Outside Docker, the frontend proxies `/api/v1/*` to `http://localhost:<PORT>`, using the backend `PORT` from the root `.env`.

## 6. Verify

```bash
curl http://localhost:3000/health                # {"status":"ok"}
curl -i http://localhost:3001/api/v1/auth/me     # 401 UNAUTHENTICATED, which means the proxy works
```

Then open http://localhost:3001 and log in with the bootstrapped admin. Upload an image; a thumbnail should appear within about 30 seconds.

> The session cookie is set with `secure: true`. Browsers accept it on `http://localhost`, but on any other plain-HTTP host login appears to succeed and the session is then lost. Put the app behind HTTPS for remote access.

## Production build

```bash
npm run build              # backend → dist/, start with `npm start`
cd web && npm run build    # frontend → .next/standalone
```

## Continuous deployment

`.github/workflows/deploy.yml` runs on a **self-hosted** runner on every push to `main`:

1. `docker compose build`
2. `docker compose run --rm backend npm run migrate`
3. `docker compose up -d --remove-orphans`
4. `docker image prune -f`

The checkout uses `clean: false` so the server's untracked `.env` survives each deploy.
