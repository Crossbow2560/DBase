# Project structure

```
.
├── .github/workflows/deploy.yml   # build → migrate → up -d on push to main (self-hosted runner)
├── Dockerfile                     # backend image (node:22-slim + ffmpeg + poppler-utils)
├── docker-compose.yml             # backend, frontend, minio, minio-init
├── .env.example                   # the single config file for backend, frontend and compose
├── package.json / tsconfig.json   # backend project (ESM, NodeNext, strict)
├── prisma/
│   └── schema.prisma              # Prisma client models (NOT used for migrations)
├── scripts/
│   ├── migrate.ts                 # applies supabase/migrations/*.sql, tracks them in _migrations
│   └── bootstrap-admin.ts         # creates the first admin (refuses if one exists)
├── supabase/
│   └── migrations/                # 0001_foundation.sql … 0022_preallocate_user_quotas.sql
├── src/
│   ├── server.ts                  # Fastify bootstrap, global rate limit, error handler, workers
│   ├── config.ts                  # env parsing (dotenv), MinIO internal vs public endpoints
│   ├── db.ts                      # the single shared PrismaClient
│   ├── types/fastify.d.ts         # request.session / rawSessionToken / rawBody augmentation
│   ├── lib/
│   │   ├── password.ts (+ .test)  # bcrypt (12 rounds), 8-char minimum
│   │   ├── tokens.ts (+ .test)    # 32-byte base64url tokens, SHA-256 hashing
│   │   ├── email.ts               # Resend send, falls back to console logging
│   │   └── emailTemplate.ts       # HTML email layout
│   ├── modules/
│   │   ├── accounts/              # auth, sessions, profile, storage usage
│   │   ├── filesystem/            # folders, files, uploads, name normalization
│   │   ├── access/                # permission-check, grants, ownership transfer, share links
│   │   ├── trash/                 # trash listing, restore, deletion queue
│   │   ├── organize/              # favorites, tags
│   │   ├── search/                # trigram name search
│   │   ├── thumbnails/            # queue + generation
│   │   ├── lifecycle/             # deactivate / reactivate / delete account
│   │   ├── admin/                 # users, stats, audit log, backups, outbound mail
│   │   ├── email/                 # inbound webhook + received-mail storage
│   │   └── storage/client.ts      # the only MinIO access point
│   └── workers/
│       ├── upload-session-cleanup.ts
│       ├── deletion-queue.ts
│       └── thumbnail-queue.ts
├── web/                           # Next.js frontend (separate npm project)
│   ├── Dockerfile                 # standalone build; BACKEND_URL is a build arg
│   ├── next.config.js             # /api/v1/* rewrite to the backend, loads root .env
│   ├── scripts/with-frontend-port.js  # maps FRONTEND_PORT → PORT for `next dev/start`
│   ├── app/
│   │   ├── layout.tsx, providers.tsx, page.tsx
│   │   ├── (auth)/                # login, register, verify-email, password-reset/{request,confirm}
│   │   ├── (app)/                 # authenticated shell
│   │   │   ├── home, folders/[folderId], shared-with-me, favorites, trash, search, tags
│   │   │   ├── settings/{account,sessions}
│   │   │   └── admin/{users/[userId],stats,activity,system-storage,backup,send-mail,received-mail,failed-jobs}
│   │   └── s/[token]/             # public share-link page
│   ├── components/
│   │   ├── files/                 # folder-browser, upload-tray, share/move/rename/tags modals, previews
│   │   └── ui/                    # button, input, select-menu, ring charts, color picker
│   └── lib/                       # api-client, auth, uploads, query-keys, formatting helpers
└── docs/                          # this documentation + the original design documents
```

## Responsibilities and layer separation

### Backend (`src/`)

| Layer | Location | Rule |
|---|---|---|
| Transport | `modules/*/routes.ts` | Parse params/body (JSON schema), run the `requireSession`/`requireAdmin` preHandler, set the per-route rate limit, call one service function, shape the response. No DB queries. |
| Business logic | `modules/*/*-service.ts` | Authorization through `checkPermission()`, validation, DB access through `db` or `$queryRaw`, audit logging through `admin/audit-service.ts#logActivity`. |
| Errors | `modules/*/errors.ts` | Factories returning `AppError(status, CODE, message)`. Codes are part of the API contract and are mirrored in `web/lib/api-client.ts`. |
| Infrastructure | `storage/client.ts`, `db.ts`, `lib/*` | Shared adapters. |
| Jobs | `workers/*` | Timers only; the work itself lives in the owning module's service. |

What should **not** go where:

- **Permissions:** modules don't query `permissions` directly to make access decisions; they call `access/permission-check.ts`.
- **MinIO:** nothing outside `storage/client.ts` imports `minio` or builds object keys.
- **Workers:** the files in `workers/` don't contain business logic, only scheduling and overlap guards.
- **`requireSession`:** this guard is currently duplicated in each `routes.ts`. Keep the copies identical until it's factored into a shared module.

### Database (`supabase/migrations/`)

- **New migrations:** any schema change is a new, numerically-prefixed SQL file. Don't edit files that are already applied, because `_migrations` tracks them by filename.
- **Prisma schema:** after a migration, update `prisma/schema.prisma` with `npm run prisma:pull` (needs `DIRECT_URL`), reconcile it with the existing snake_case style, then run `npm run prisma:generate`.

### Frontend (`web/`)

- **Pages:** live in `app/` and use route groups to separate the unauthenticated `(auth)` layout from the authenticated `(app)` shell.
- **Reusable UI:** `components/files` holds file-manager widgets. `components/ui` holds design-system primitives built on Radix and CVA.
- **API calls:** go through `lib/api-client.ts`, never through direct `fetch` to `/api/v1`. The exception is the upload engine in `lib/uploads.tsx`, which needs raw `fetch` for binary parts and 429 retry handling.
