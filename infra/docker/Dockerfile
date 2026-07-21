# syntax=docker/dockerfile:1.7
#
# ASH Delivery API.
#
# Node 24 LTS (maintained to April 2028). The image ships TypeScript SOURCE and runs it under
# Node's native type stripping — which is exactly why `pnpm check:strip` is a CI gate: syntax
# that needs a transform fails at LOAD time here, i.e. a crash-looping container rather than a
# test failure.

# ── deps ─────────────────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Copy only manifests first, so a source change does not invalidate the dependency layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/domain/package.json      packages/domain/
COPY packages/contracts/package.json   packages/contracts/
COPY packages/adapters/package.json    packages/adapters/
COPY packages/testkit/package.json     packages/testkit/
COPY packages/db/package.json          packages/db/
COPY apps/api/package.json             apps/api/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false

# ── runtime ──────────────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps ./apps

# node:* images ship an unprivileged `node` user. Nothing here needs root.
USER node

EXPOSE 3000

# Fastify's own /health, so the orchestrator's idea of "up" and the app's agree.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No init shim: the app installs SIGTERM/SIGINT handlers and closes Fastify gracefully, so an
# in-flight shift approval finishes rather than being cut mid-transaction.
CMD ["node", "apps/api/src/server.ts"]
