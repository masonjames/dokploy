# Dokploy v0.30.6 source preparation

Status: local source preparation; no image publication or production update.

## Exact inputs

- Accepted fork: `29aa22fa3c05d6273ecf78f444fb41b2c1a634a3` (v0.30.5).
- Upstream tag: `v0.30.6`, commit
  `6dcd0e185939292c9e07b3829c38b669b3c8cb78`.
- Platform release lock still records v0.30.5 image
  `ghcr.io/masonjames/dokploy@sha256:5353ce9fcbdb7d633cbf9e95543f7a6efb31f37c89c87b3faa67a3b65a615e98`.
  Read-only production inspection on September 16 confirmed this configured
  image, service version `12114240`, and one running task on platform-core.
- Existing platform tracker: draft [PR #614](https://github.com/masonjames/platform-infra/pull/614),
  head `4179909fc9ee9beb5da9d2da94d3417f71fb6b57`. It updates only
  `apps/dokploy/version.txt`; retain it for release reconciliation.

The infrastructure version checker recognizes the custom Dokploy image by
matching its complete deployed reference to the release lock, then reading the
upstream version alongside it. Recognition therefore requires an accepted
immutable runtime and a matching lock. A version-file bump alone cannot provide
that evidence.

## Required fork reconciliation

The upstream merge is textually clean but needs migration reconciliation.
Drizzle executes migrations only when their timestamp exceeds the latest
installed migration. Upstream migration 0191 is dated `1788332224024`, before
our accepted 0190 timestamp `1788470974739`. Set the new 0191 timestamp to
`1788470974740` so the Infomaniak DNS enum migration is applied. Preserve all
already accepted journal entries and SQL bytes.

Keep all five new upstream SQL migrations. Rechain their schema snapshots to
the accepted fork snapshot and preserve the immutable-release table, application
release revision, Caddy provider/configuration columns and request-log setting.
The existing release contract check now verifies strict timestamp order and
these preserved structures through snapshot 0195.

The upstream changes add three provider enum values, an SSO domain-verification
column and a whitelabeling default. The server-side SSO enforcement change also
requires authenticated acceptance before any release closeout.

## Local validation

- Frozen pnpm 10.34.5 dependency installation passed.
- Existing immutable-release contract check passed.
- Exact existing release workflow test selection: 49 files, 326 tests passed.
- Dokploy application and server package type checks passed.
- An initial broader deployment-test selection was interrupted because it
  included unrelated real-deployment fixtures. The scoped release selection
  above is the completed acceptance result; no broad-suite pass is claimed.
- The first production inspection was blocked by automatic approval review.
  After Mason said "proceed", the same read-only check succeeded. Dockhand also
  still matched its accepted H5 image and service version `12115319`.

## Local build default

The existing Mason release workflow is now a manual fallback. Verification is
its default; image publication requires an explicit input on `mj/prod-caddy`.
Source publication and merges do not automatically run hosted compute.

Use platform-infra's pinned `ops/scripts/run-dagger-platform-check.sh` wrapper
and its existing Dagger `core host directory ... docker-build` interface with
`--platform linux/amd64`. Export the exact Git commit into a clean context and
copy `apps/dokploy/.env.production.example` to both `.env.production` and
`apps/dokploy/.env.production`, as the existing release workflow does. Those
tracked defaults contain only the port and production mode. Pass the full
40-character commit as `SOURCE_REVISION` and the local builder architecture as
`BUILDPLATFORM`; retain the OCI export and scan results separately.

An emulated AMD64 Next.js build on the ARM Mac failed with a segmentation fault.
The Dockerfile now compiles JavaScript on the builder architecture, then installs
and packages native dependencies on the AMD64 target stage. Final runtime
dependencies come from that target stage. The existing release contract checks
this distinction. No production image acceptance is implied by a local build.
The patched Go tools also compile on the builder architecture, using their
existing `CGO_ENABLED=0` and explicit Linux AMD64 target. The image build verifies
each binary's embedded target metadata as well as its patched crypto version.

## Remaining release gates

Use platform-infra's existing operator bridge and attended Dokploy release
controller. First verify the actual running/configured image and version.
After source review and signed publication, build the exact source locally
through Dagger's existing Dockerfile interface, scan the resulting image and
retain its immutable identity. Do not replace our Caddy fork with the stock
upstream image or update the release lock to an uninstalled candidate.

Prepare one bounded release card with fresh DB/config backup, isolated restore
and migration proof, compatible rollback image, active-work exclusion, full
non-image service preservation, authenticated UI and route checks, and the
chosen continuous health interval. Reconcile the Swarm self-update image,
version file, manifests and release lock only with observed acceptance.
Production mutation requires approval for that concrete card. Historical
native qualification and natural-soak evidence remain unchanged.
