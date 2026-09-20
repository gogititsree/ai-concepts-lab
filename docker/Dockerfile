# syntax=docker/dockerfile:1

# One image for the whole app: the API process also serves apps/web/dist, so production
# is single-origin (no CORS, no second service on the free tier).
ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------- base ----
FROM ${NODE_IMAGE} AS base
# CI=true keeps pnpm non-interactive (it otherwise refuses to prune node_modules
# without a TTY).
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /app

# ------------------------------------------------------------------------ manifests ----
# Just the files that decide what gets installed, so the install layers stay cached until
# a package.json or the lockfile actually changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/nn-core/package.json packages/nn-core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

# --------------------------------------------------------------------------- build ----
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# `content/` is a BUILD INPUT, not just runtime data. Module 3's tokenizer bundles
# `corpus.txt` and the embeddings fallback bundles `embeddings-precomputed.json`, both via
# Vite `?raw` imports, so omitting this directory fails the web build outright. It is also
# what `pnpm db:seed` reads, so the image can seed its own database.
COPY content ./content
# pnpm -r builds in topological order: shared and nn-core before api and web.
RUN pnpm -r run build

# ----------------------------------------------------------------------- prod-deps ----
# A second, independent install with no dev dependencies. Doing it in its own stage (as
# opposed to pruning the build stage) keeps TypeScript, Vite, Vitest and friends out of
# the shipped node_modules entirely.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ------------------------------------------------------------------------- runtime ----
FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    GIT_SHA=${GIT_SHA}
WORKDIR /app

# Manifests + production node_modules (including the workspace symlinks), then the
# compiled output on top of it.
COPY --from=prod-deps --chown=node:node /app /app
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/nn-core/dist ./packages/nn-core/dist
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
# Runtime copy as well, so `pnpm db:seed` can run inside the container (Render's shell)
# instead of only from a laptop pointed at the production database.
COPY --from=build --chown=node:node /app/content ./content

# The `node` user ships with the official image; never run the server as root.
USER node

EXPOSE 3000

# busybox wget is already in the alpine base, so no extra package is installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:3000/api/v1/health || exit 1

CMD ["node", "apps/api/dist/server.js"]
