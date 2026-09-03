# syntax=docker/dockerfile:1
FROM node:24.18.0-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g npm@12.0.1
RUN corepack enable
RUN corepack prepare pnpm@10.34.5 --activate

FROM docker:29.7.2-cli@sha256:3f4743208d2338c934d7b8bcfbe1bb54c0b2355c510ad5e0f31c0c4a54bd704e AS docker-cli

FROM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS patched-tools
ARG X_CRYPTO_VERSION=v0.55.0

ARG RCLONE_REVISION=9ee9d0a0cafd5e5fe3b271d2280b090ab6e64048
RUN git clone --filter=blob:none https://github.com/rclone/rclone.git /src/rclone \
    && git -C /src/rclone checkout "$RCLONE_REVISION" \
    && test "$(git -C /src/rclone rev-parse HEAD)" = "$RCLONE_REVISION"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd /src/rclone \
    && go get "golang.org/x/crypto@$X_CRYPTO_VERSION" \
    && CGO_ENABLED=0 go build -trimpath -ldflags "-s -X github.com/rclone/rclone/fs.Version=v1.75.0" -o /out/rclone .

ARG PACK_REVISION=8210eb15f191cad25a3f7745618417270ec07709
RUN git clone --filter=blob:none https://github.com/buildpacks/pack.git /src/pack \
    && git -C /src/pack checkout "$PACK_REVISION" \
    && test "$(git -C /src/pack rev-parse HEAD)" = "$PACK_REVISION"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd /src/pack \
    && go get "golang.org/x/crypto@$X_CRYPTO_VERSION" \
    && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X github.com/buildpacks/pack/pkg/client.Version=0.40.9" -o /out/pack .

ARG BUILDX_REVISION=1d8dde89b8aba914e05e45366770736fea1fd690
RUN git clone --filter=blob:none https://github.com/docker/buildx.git /src/buildx \
    && git -C /src/buildx checkout "$BUILDX_REVISION" \
    && test "$(git -C /src/buildx rev-parse HEAD)" = "$BUILDX_REVISION"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd /src/buildx \
    && GOFLAGS=-mod=mod go get "golang.org/x/crypto@$X_CRYPTO_VERSION" \
    && CGO_ENABLED=0 GOFLAGS=-mod=mod go build -trimpath -ldflags "-s -w -X github.com/docker/buildx/version.Version=v0.36.1 -X github.com/docker/buildx/version.Revision=$BUILDX_REVISION -X github.com/docker/buildx/version.Package=github.com/docker/buildx" -o /out/docker-buildx ./cmd/buildx

ARG COMPOSE_REVISION=870908cc8f07f5e90acdf5d34dd1b96a4fe51d16
RUN git clone --filter=blob:none https://github.com/docker/compose.git /src/compose \
    && git -C /src/compose checkout "$COMPOSE_REVISION" \
    && test "$(git -C /src/compose rev-parse HEAD)" = "$COMPOSE_REVISION"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd /src/compose \
    && go get "golang.org/x/crypto@$X_CRYPTO_VERSION" \
    && CGO_ENABLED=0 go build -trimpath -ldflags "-w -X github.com/docker/compose/v5/internal.Version=v5.5.0" -o /out/docker-compose ./cmd

RUN for binary in rclone pack docker-buildx docker-compose; do \
      go version -m "/out/$binary" | grep -Eq 'dep[[:space:]]+golang.org/x/crypto[[:space:]]+v0\.55\.0'; \
    done

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
    && apt-get install -y tini curl unzip zip apache2-utils iproute2 rsync git-lfs python3 procps util-linux \
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

# Install only the Docker client and its patched CLI plugins. Dokploy uses the
# host socket and does not need a second daemon or rootless runtime in its image.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=patched-tools /out/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=patched-tools /out/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=patched-tools /out/rclone /usr/local/bin/rclone

# Install Nixpacks and tsx
# | VERBOSE=1 VERSION=1.21.0 bash

ARG NIXPACKS_VERSION=1.41.0
RUN curl -sSL https://nixpacks.com/install.sh -o install.sh \
    && chmod +x install.sh \
    && ./install.sh \
    && pnpm install -g tsx

# Install Railpack
ARG RAILPACK_VERSION=0.39.0
RUN curl -sSL https://railpack.com/install.sh | bash

# Install buildpacks
COPY --from=patched-tools /out/pack /usr/local/bin/pack
RUN /usr/local/libexec/dokploy-build-admission/verify-builder-env-transport

ARG SOURCE_REVISION=unknown
ARG SOURCE_URL=https://github.com/masonjames/dokploy
LABEL org.opencontainers.image.source="$SOURCE_URL" \
  org.opencontainers.image.revision="$SOURCE_REVISION"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/trpc/settings.health || exit 1

# tini reaps HEALTHCHECK child processes that Node (as PID 1) leaves defunct.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Ejecutar node directamente: pnpm como wrapper queda residente (~100MB RSS)
  CMD ["sh", "-c", "node -r dotenv/config dist/wait-for-postgres.mjs && node -r dotenv/config dist/migration.mjs && exec node -r dotenv/config dist/server.mjs"]
