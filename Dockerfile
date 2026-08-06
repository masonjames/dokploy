# syntax=docker/dockerfile:1
FROM node:24.18.0-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g npm@12.0.1
RUN corepack enable
RUN corepack prepare pnpm@10.34.5 --activate

FROM base AS build
WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y python3 make g++ git python3-pip pkg-config libsecret-1-dev && rm -rf /var/lib/apt/lists/*

# Install dependencies from manifests first so source-only changes reuse the
# frozen dependency layer without changing resolution or build inputs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/dokploy/package.json ./apps/dokploy/package.json
COPY apps/schedules/package.json ./apps/schedules/package.json
COPY packages/server/package.json ./packages/server/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .

# Deploy only the dokploy app

ENV NODE_ENV=production
RUN pnpm --filter=@dokploy/server build
RUN pnpm --filter=./apps/dokploy run build
RUN test -f /usr/src/app/apps/dokploy/dist/caddy-migration-rollback.mjs

RUN pnpm --filter=./apps/dokploy --prod deploy --legacy /prod/dokploy

RUN cp -R /usr/src/app/apps/dokploy/.next /prod/dokploy/.next
RUN cp -R /usr/src/app/apps/dokploy/dist /prod/dokploy/dist

FROM base AS dokploy
WORKDIR /app

# Set production
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y curl unzip zip apache2-utils iproute2 rsync git-lfs python3 procps util-linux \
    && git lfs install \
    && rm -rf /var/lib/apt/lists/*

COPY apps/dokploy/docker/build-admission/host-capacity-gate /usr/local/bin/dokploy-host-capacity-gate
COPY apps/dokploy/docker/build-admission/df /usr/local/libexec/dokploy-build-admission/df
COPY apps/dokploy/docker/build-admission/verify-builder-env-transport /usr/local/libexec/dokploy-build-admission/verify-builder-env-transport
RUN chmod 0755 /usr/local/bin/dokploy-host-capacity-gate /usr/local/libexec/dokploy-build-admission/df /usr/local/libexec/dokploy-build-admission/verify-builder-env-transport

# Copy only the necessary files
COPY --from=build /prod/dokploy/.next ./.next
COPY --from=build /prod/dokploy/dist ./dist
COPY --from=build /prod/dokploy/next.config.mjs ./next.config.mjs
COPY --from=build /prod/dokploy/public ./public
COPY --from=build /prod/dokploy/package.json ./package.json
COPY --from=build /prod/dokploy/drizzle ./drizzle
COPY .env.production ./.env
COPY --from=build /prod/dokploy/components.json ./components.json
COPY --from=build /prod/dokploy/node_modules ./node_modules
RUN test -f /app/dist/caddy-migration-rollback.mjs \
  && node -r dotenv/config /app/dist/caddy-migration-rollback.mjs --help | grep -q "Usage: caddy-migration-rollback"

# Install docker
RUN curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh --version 29.6.1 && rm get-docker.sh && curl https://rclone.org/install.sh | bash

# Install Nixpacks and tsx
# | VERBOSE=1 VERSION=1.21.0 bash

ARG NIXPACKS_VERSION=1.41.0
RUN curl -sSL https://nixpacks.com/install.sh -o install.sh \
    && chmod +x install.sh \
    && ./install.sh \
    && pnpm install -g tsx

# Install Railpack
ARG RAILPACK_VERSION=0.30.1
RUN curl -sSL https://railpack.com/install.sh | bash

# Install buildpacks
COPY --from=buildpacksio/pack:0.40.7@sha256:b3e4bb190749586d1f15a4f7de013ca7b76dea756a6919255e12281ed129c6ca /usr/local/bin/pack /usr/local/bin/pack
RUN /usr/local/libexec/dokploy-build-admission/verify-builder-env-transport

ARG SOURCE_REVISION=unknown
ARG SOURCE_URL=https://github.com/masonjames/dokploy
LABEL org.opencontainers.image.source="$SOURCE_URL" \
  org.opencontainers.image.revision="$SOURCE_REVISION"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/trpc/settings.health || exit 1

# Ejecutar node directamente: pnpm como wrapper queda residente (~100MB RSS)
  CMD ["sh", "-c", "node -r dotenv/config dist/wait-for-postgres.mjs && node -r dotenv/config dist/migration.mjs && exec node -r dotenv/config dist/server.mjs"]
