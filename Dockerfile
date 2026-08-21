# Backend (Fastify + Prisma). Built as a Linux container regardless of host OS, so Prisma's
# `generate` step here always produces the correct (linux) query-engine binary — no cross-
# compilation concern even when built on a non-Linux dev machine.
#
# Deliberately ships full node_modules (not a --omit=dev prune) rather than a slimmer prod-only
# image: scripts/bootstrap-admin.ts needs tsx (a devDependency) to run, and it's meant to be
# runnable operationally via `docker compose exec backend npm run bootstrap:admin` — a larger
# image in exchange for that staying simple, not an oversight.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Subcomponent 5 (Thumbnails): shelled out to for video-frame and PDF-page extraction
# (src/modules/thumbnails/generate.ts) rather than pulling in native npm bindings for a
# background, best-effort, low-stakes job.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY package.json ./

EXPOSE 3000
CMD ["node", "dist/src/server.js"]
