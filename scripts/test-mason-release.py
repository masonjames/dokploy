#!/usr/bin/env python3
from pathlib import Path
import json
import re


ROOT = Path(__file__).resolve().parents[1]
dockerfile = (ROOT / "Dockerfile").read_text()
workflow = (ROOT / ".github/workflows/mason-immutable-release.yml").read_text()
caddyfile = (ROOT / "packages/server/src/utils/caddy/caddyfile.ts").read_text()
package = json.loads((ROOT / "apps/dokploy/package.json").read_text())
journal = json.loads(
    (ROOT / "apps/dokploy/drizzle/meta/_journal.json").read_text()
)["entries"]
upstream_migration = (
    ROOT / "apps/dokploy/drizzle/0190_upstream_v0305.sql"
).read_text()
previous_snapshot = json.loads(
    (ROOT / "apps/dokploy/drizzle/meta/0189_snapshot.json").read_text()
)
current_snapshot = json.loads(
    (ROOT / "apps/dokploy/drizzle/meta/0190_snapshot.json").read_text()
)

assert package["version"] == "v0.31.0"
assert [entry["tag"] for entry in journal[-13:]] == [
    "0186_heavy_mathemanic",
    "0187_grey_domino",
    "0188_crazy_lionheart",
    "0189_dockhand_image_only_revision",
    "0190_upstream_v0305",
    "0191_cool_christian_walker",
    "0192_light_lake",
    "0193_chemical_the_liberteens",
    "0194_acoustic_prima",
    "0195_classy_whirlwind",
    "0196_worthless_ravenous",
    "0197_logs_and_metrics",
    "0198_nostalgic_mongoose",
]
assert all(a["when"] < b["when"] for a, b in zip(journal[-13:], journal[-12:]))
for statement in (
    'ADD VALUE \'porkbun\'',
    'ADD VALUE \'phase\'',
    'ADD COLUMN "dockerId"',
    'ADD COLUMN "onboardingCompletedAt"',
    'UPDATE "organization_role"',
    'UPDATE "user" SET "onboardingCompletedAt"',
):
    assert statement in upstream_migration
assert current_snapshot["prevId"] == previous_snapshot["id"]
assert "public.immutableReleaseRequest" in current_snapshot["tables"]
assert "releaseConfigRevision" in current_snapshot["tables"]["public.application"]["columns"]
assert "dockerId" in current_snapshot["tables"]["public.network"]["columns"]
assert "onboardingCompletedAt" in current_snapshot["tables"]["public.user"]["columns"]

# Drizzle skips migrations older than the installed timestamp; preserve the fork chain.
for number in range(191, 199):
    snapshot = json.loads(
        (ROOT / f"apps/dokploy/drizzle/meta/{number:04}_snapshot.json").read_text()
    )
    assert snapshot["prevId"] == current_snapshot["id"]
    assert snapshot["tables"]["public.immutableReleaseRequest"] == current_snapshot["tables"]["public.immutableReleaseRequest"]
    for table, columns in {
        "public.application": ("releaseConfigRevision",),
        "public.server": ("webServerProvider", "caddyTrustedProxyConfig"),
        "public.webServerSettings": ("webServerProvider", "caddyTrustedProxyConfig", "requestLogsEnabled"),
    }.items():
        for column in columns:
            assert snapshot["tables"][table]["columns"][column] == current_snapshot["tables"][table]["columns"][column]
    assert snapshot["enums"]["public.webServerProvider"] == current_snapshot["enums"]["public.webServerProvider"]
    current_snapshot = snapshot

assert "ghcr.io/masonjames/dokploy" in workflow
assert not re.search(r"^  (pull_request|push):", workflow, re.MULTILINE)
assert "publish_image:" in workflow and "default: false" in workflow
assert "inputs.publish_image == true && github.ref == 'refs/heads/mj/prod-caddy'" in workflow
assert "type=raw,value=latest" not in workflow
assert "ghcr.io/masonjames/dokploy:latest" not in workflow
assert "provenance: mode=max" in workflow
assert "sbom: true" in workflow
assert "severity: CRITICAL" in workflow
assert "ignore-unfixed: true" in workflow
assert "Inventory unresolved critical vulnerabilities" in workflow
assert "trivy-image-unresolved.txt" in workflow

# The publication gate may ignore only the listed, dated exceptions; the unresolved report ignores nothing.
scan_exceptions = [
    line.split()
    for line in (ROOT / "security/release-scan-exceptions.trivyignore").read_text().splitlines()
    if line.strip() and not line.startswith("#")
]
assert scan_exceptions == [["CVE-2026-114607", "exp:2026-12-31"]]
assert workflow.count("trivyignores:") == 1
gate_step = workflow.split("Enforce critical vulnerability threshold before publication", 1)[1].split("- name:", 1)[0]
assert "trivyignores: security/release-scan-exceptions.trivyignore" in gate_step
assert "exit-code: '1'" in gate_step
assert package["dependencies"]["better-auth"] == "1.6.23"
# CVE-2026-114607 needs the Magic Link plugin. Loading it, or changing the pinned version, voids the exception.
magic_link_use = re.compile(r"magicLink\s*\(|better-auth/plugins/magic-link|magicLinkClient")
for source_root in ("packages/server/src", "apps/dokploy"):
    for source in (ROOT / source_root).rglob("*.ts*"):
        if "node_modules" in source.parts or ".next" in source.parts:
            continue
        assert not magic_link_use.search(source.read_text(errors="ignore")), source
assert "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271" in workflow
assert "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e" in workflow
assert re.search(r"Set up pnpm.*?version: 10\.34\.5", workflow, re.DOTALL)
assert workflow.index("Inventory unresolved critical vulnerabilities") < workflow.index("Enforce critical vulnerability threshold before publication")
assert workflow.index("Enforce critical vulnerability threshold before publication") < workflow.index("Build and push immutable image")
assert "image-ref: local/mason-dokploy:${{ github.sha }}" in workflow
assert re.search(
    r'^export const CADDY_IMAGE = "caddy:\d+\.\d+\.\d+";$',
    caddyfile,
    re.MULTILINE,
)

assert re.search(
    r"^FROM node:24\.22\.1-bookworm-slim@sha256:[0-9a-f]{64} AS base$",
    dockerfile,
    re.MULTILINE,
)
assert re.search(
    r"^FROM docker:29\.7\.2-cli@sha256:[0-9a-f]{64} AS docker-cli$",
    dockerfile,
    re.MULTILINE,
)
assert re.search(
    r"^FROM --platform=\$BUILDPLATFORM golang:1\.26\.6-bookworm@sha256:[0-9a-f]{64} AS patched-tools$",
    dockerfile,
    re.MULTILINE,
)
assert "ARG X_CRYPTO_VERSION=v0.55.0" in dockerfile
assert "ARG KANIKO_VERSION=v1.25.20" in dockerfile
pack_build = dockerfile.split("cd /src/pack", 1)[1].split("ARG BUILDX_REVISION", 1)[0]
assert 'go get "golang.org/x/crypto@$X_CRYPTO_VERSION" "github.com/chainguard-dev/kaniko@$KANIKO_VERSION"' in pack_build
assert dockerfile.count('"github.com/chainguard-dev/kaniko@$KANIKO_VERSION"') == 1
assert "ARG RCLONE_REVISION=687d264b689b8c49a67e2e52a8a5e0caa01c04ce" in dockerfile
assert "ARG PACK_REVISION=8210eb15f191cad25a3f7745618417270ec07709" in dockerfile
assert "ARG BUILDX_REVISION=1d8dde89b8aba914e05e45366770736fea1fd690" in dockerfile
assert "ARG COMPOSE_REVISION=870908cc8f07f5e90acdf5d34dd1b96a4fe51d16" in dockerfile
assert "get.docker.com" not in dockerfile
assert "rclone.org/install.sh" not in dockerfile
assert "ARG RAILPACK_VERSION=0.39.0" in dockerfile
for binary in ("docker-buildx", "docker-compose", "rclone", "pack"):
    assert f"COPY --from=patched-tools /out/{binary} " in dockerfile
assert 'org.opencontainers.image.revision="$SOURCE_REVISION"' in dockerfile
assert dockerfile.index("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./") < dockerfile.index("pnpm install --frozen-lockfile")
assert dockerfile.index("pnpm install --frozen-lockfile") < dockerfile.index("COPY . .")
assert "FROM --platform=$BUILDPLATFORM node:24.22.1-bookworm-slim@sha256:" in dockerfile
package_stage = dockerfile.split("FROM base AS package\n", 1)[1].split("FROM base AS dokploy", 1)[0]
assert "pnpm install --frozen-lockfile" in package_stage
assert "COPY --from=build /usr/src/app/packages/server/dist" in package_stage
assert "COPY --from=package /prod/dokploy/node_modules ./node_modules" in dockerfile
assert "COPY --from=build /prod/dokploy/node_modules" not in dockerfile

for match in re.finditer(r"uses:\s+[^\s@]+@([^\s#]+)", workflow):
    ref = match.group(1)
    assert re.fullmatch(r"[0-9a-f]{40}", ref), f"unpinned action ref: {ref}"

print("Mason Dokploy immutable release contracts passed")
