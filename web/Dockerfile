# Frontend (Next.js, standalone output — next.config.js sets output: "standalone" specifically
# for this). Standalone traces only the dependencies actually used at runtime rather than
# shipping the full node_modules tree, so this image is deliberately much smaller than the
# backend's (Dockerfile at the repo root, see its comment for why that one ships full deps).

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next.config.js's rewrites() is evaluated once at `next build` time to produce the routes
# manifest — NOT re-read per-request at runtime. A runtime `environment:` var in
# docker-compose.yml has no effect on an already-built image; BACKEND_URL must be baked in here,
# at build time, for the rewrite destination to actually be correct. (Found by actually running
# the built container: the proxy kept hitting localhost:3000 instead of backend:3000 despite the
# env var being correctly set inside the container — this Dockerfile previously had no ARG at
# all and relied on next.config.js's runtime-env-var comment, which was wrong.)
ARG BACKEND_URL=http://backend:3000
ENV BACKEND_URL=$BACKEND_URL
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

EXPOSE 3001
CMD ["node", "server.js"]
