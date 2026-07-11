#!/usr/bin/env python3
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
dockerfile = (ROOT / "Dockerfile").read_text()
workflow = (ROOT / ".github/workflows/mason-immutable-release.yml").read_text()
caddy_setup = (ROOT / "packages/server/src/setup/caddy-setup.ts").read_text()

assert "ghcr.io/masonjames/dokploy" in workflow
assert "type=raw,value=latest" not in workflow
assert "ghcr.io/masonjames/dokploy:latest" not in workflow
assert "provenance: mode=max" in workflow
assert "sbom: true" in workflow
assert "severity: CRITICAL" in workflow
assert "ignore-unfixed: true" in workflow
assert "Inventory unresolved critical vulnerabilities" in workflow
assert "trivy-image-unresolved.txt" in workflow
assert workflow.index("Enforce critical vulnerability threshold before publication") < workflow.index("Build and push immutable image")
assert "image-ref: local/mason-dokploy:${{ github.sha }}" in workflow
assert "CADDY_IMAGE" in caddy_setup

assert re.search(
    r"^FROM node:24\.4\.0-slim@sha256:[0-9a-f]{64} AS base$",
    dockerfile,
    re.MULTILINE,
)
assert re.search(
    r"^COPY --from=buildpacksio/pack:0\.40\.7@sha256:[0-9a-f]{64} ",
    dockerfile,
    re.MULTILINE,
)
assert "sh get-docker.sh --version 29.6.1" in dockerfile
assert "ARG RAILPACK_VERSION=0.30.1" in dockerfile
assert 'org.opencontainers.image.revision="$SOURCE_REVISION"' in dockerfile

for match in re.finditer(r"uses:\s+[^\s@]+@([^\s#]+)", workflow):
    ref = match.group(1)
    assert re.fullmatch(r"[0-9a-f]{40}", ref), f"unpinned action ref: {ref}"

print("Mason Dokploy immutable release contracts passed")
