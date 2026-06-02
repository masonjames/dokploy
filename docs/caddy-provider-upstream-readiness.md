# Caddy Provider Upstream Readiness

This document tracks the work needed to turn the Caddy web server provider from a working proof of concept into an upstream-ready Dokploy alternative to Traefik.

PR: https://github.com/Dokploy/dokploy/pull/4534

## Scope and Safety

- The upstream PR should contain generic Dokploy code, tests, and user-facing documentation only.
- Keep platform-specific route manifests, hostnames, production logs, secrets, and operational evidence outside this repository.
- Read-only production checks are allowed for proof gathering.
- Live apply, rollback, provider switching, service updates, restarts, or config writes require explicit human approval in the current work session.

## Current PR State

Observed with `gh pr view 4534 --repo Dokploy/dokploy`:

- State: open
- Base: `canary`
- Head: `codex/caddy-web-server-v0296-clean-pr`
- Mergeable: mergeable
- Review decision: review required
- Visible check: `anti-slop` succeeded

Local state observed before this document was added:

- Repo: local Dokploy checkout
- Branch: `codex/caddy-web-server-v0296-clean-pr`
- Working tree: clean except the RepoPrompt export generated during planning, which must not be kept in the PR surface

## Readiness Matrix

| Area | Current evidence | Status | Next proof needed |
| --- | --- | --- | --- |
| Application domain create under Caddy | `createDomain()` inserts the row, dispatches through `manageWebServerDomain()` for application domains, and removes the row if provider route creation fails. Focused service tests prove provider dispatch and cleanup when provider route creation fails. | Locally covered | Add router-level test only if maintainers want end-to-end TRPC proof. |
| Application domain update under Caddy | `domainRouter.update` writes the next Caddy fragment before DB update and restores the old fragment on DB failure. `manageCaddyDomain()` also restores previous fragments when reload fails. | Locally covered | Add runtime proof after explicit approval. |
| Application domain delete under Caddy | `domainRouter.delete` removes provider config before DB deletion and restores on DB failure. `removeCaddyDomain()` also restores previous fragments when reload fails. | Locally covered | Add runtime proof after explicit approval. |
| Compose domain add/update/remove under Caddy | `createComposeDomain()` removes new rows if refresh fails. `removeComposeDomainsForWebServer()` refreshes Caddy with remaining compose domains before non-router delete flows remove rows and restores old fragments if DB deletion fails. `domainRouter.update` restores previous compose domain fields and fragments if refresh fails. `domainRouter.delete` restores all compose routes if DB delete fails. | Locally covered | Add runtime proof after explicit approval. |
| Domain added while creating/duplicating a new application service | `application.create` has no domain payload. The application new-service-with-domain path is project duplication: copied application domains call `createDomain()` with `applicationId`, which invokes provider dispatch. | Locally covered | Add router-level duplication proof only if maintainers want end-to-end TRPC coverage beyond the service contract. |
| Domain added during new compose/template/AI/import creation | `createComposeDomain()` now creates compose domains and refreshes Caddy compose routes with rollback if refresh fails. Template create, template import, AI compose generation, project compose duplication, and `domainRouter.create` use it. Template import also removes prior compose domains through `removeComposeDomainsForWebServer()` so importing a template with zero replacement domains removes stale Caddy fragments. | Locally covered | Add router-level or creation-flow tests if upstream reviewers want proof beyond the focused helper test. |
| Preview domains under Caddy | Preview deployment uses `manageWebServerDomain()` for create and requires `removeWebServerDomain()` cleanup before deleting a preview deployment row when a preview domain exists. Focused tests prove the preview app name is set before provider dispatch, cleanup removes by `uniqueConfigKey`, and route cleanup failures preserve the DB row. | Locally covered | Add runtime proof after explicit approval if preview deployments are included in the live validation pass. |
| Custom SSL certificates | Caddy domains can now select uploaded certificates. Application and compose route intents reference certificate/key files and compiled Caddy JSON emits `apps.tls.certificates.load_files`. Migration dry-runs keep valid uploaded certificates and block missing/cross-org/unreadable references. Backend guards require matching server/org context and readable `chain.crt` plus `privkey.key`; active Caddy domains block certificate file replacement/deletion until the domain is changed. | Locally covered | Add runtime proof after explicit approval. Consider a follow-up schema rename because Caddy currently stores the uploaded certificate path in the existing `customCertResolver` field. |
| LetsEncrypt / automatic HTTPS | Caddy application and compose fragments set `https` from domain settings and pass local LetsEncrypt email where available. Config and route lifecycle tests cover the generated ACME paths. | Locally covered | Add runtime proof after explicit approval. |
| Cloudflare proxy awareness | `compileCaddyConfig()` supports explicit static trusted proxy CIDRs and a Cloudflare preset using static Cloudflare IP ranges plus `CF-Connecting-IP` and `X-Forwarded-For`. Local and remote settings persist the selected mode and Caddy rebuild paths pass it into generated JSON. Default config still trusts no forwarded headers. Strict mode emits a Caddy-compatible boolean. | Locally covered | Add runtime proof after explicit approval by enabling Cloudflare or static trusted proxies and validating generated `caddy.json` plus route behavior. |
| Caddy settings UI | Migration panel, provider selector, Caddy domain certificate labels, Caddy trusted proxy settings, provider-neutral uploaded certificate copy, provider-neutral port-mapping copy, and provider-aware update-server health checks now exist. Existing Traefik file-system views remain Traefik-specific. | Needs manual UI QA | Browser-smoke the settings/domain flows when a Dokploy dev server or review app is available. |
| Caddy dashboard | Caddy admin endpoint is local-only in the current design, and this PR does not expose it through the Dokploy UI. | Deferred | Prefer no public dashboard in this PR; document local-only admin API and track any dashboard proxy as a follow-up with auth and network controls. |
| Migration dry-run/apply/rollback | Current PR includes prepare/apply/rollback, runtime preflight, rollback CLI, fail-closed runtime migration tests, and focused migration tests. Prepare records compile settings and apply rejects stale dry-runs if trusted proxy/ACME settings changed after prepare. | Locally covered | Add runtime proof after explicit approval. |
| Developer paper cuts | Generated RepoPrompt exports, private docs, stale Traefik labels, broad noisy tests, and provider-specific UI names can cause review friction. Current upstream-surface audit found no forbidden prompt exports/private docs/platform runbooks and commit subjects are generic. | Locally covered | Re-run the hygiene audit and `git diff --check` after any further commits before push. |

## Code Evidence

Provider selection and resources:

- `packages/server/src/utils/web-server/providers.ts`
- `packages/server/src/services/web-server-settings.ts`
- `apps/dokploy/drizzle/0170_web_server_provider.sql`
- `apps/dokploy/drizzle/0171_caddy_trusted_proxy_config.sql`

Application domain Caddy routing:

- `packages/server/src/utils/web-server/domain.ts`
- `packages/server/src/utils/caddy/domain.ts`
- `packages/server/src/utils/caddy/config.ts`
- `apps/dokploy/server/api/routers/domain.ts`

Compose domain Caddy routing:

- `packages/server/src/utils/caddy/compose.ts`
- `packages/server/src/utils/docker/domain.ts`
- `apps/dokploy/server/api/routers/domain.ts`

Known domain creation call sites now using the shared provider-aware helpers:

- `apps/dokploy/server/api/routers/project.ts`: project duplication creates application domains with `createDomain()` and compose domains with `createComposeDomain()`.
- `apps/dokploy/server/api/routers/compose.ts`: template create and template import create compose domains with `createComposeDomain()`.
- `apps/dokploy/server/api/routers/ai.ts`: AI compose generation creates compose domains with `createComposeDomain()`.

Preview route evidence:

- `packages/server/src/services/preview-deployment.ts` creates a preview domain, mutates `application.appName`, and calls provider-aware web-server domain helpers.
- `apps/dokploy/__test__/caddy/preview-deployment.test.ts` proves provider-aware preview create/remove behavior.

Custom certificate evidence:

- `packages/server/src/utils/caddy/domain.ts` maps Caddy custom certificate domains to uploaded certificate files.
- `packages/server/src/utils/caddy/compose.ts` carries custom certificate file references for compose Caddy routes.
- `packages/server/src/utils/caddy/config.ts` compiles manual certificate files into `apps.tls.certificates.load_files`.
- `apps/dokploy/components/dashboard/application/domains/handle-domain.tsx` lets Caddy domains choose an uploaded certificate from the existing certificate UI surface.
- `apps/dokploy/components/dashboard/settings/certificates/handle-certificate.tsx` is the existing uploaded certificate creation surface.

Trusted proxy evidence:

- `packages/server/src/db/schema/web-server-settings.ts` persists local Caddy trusted proxy settings.
- `packages/server/src/db/schema/server.ts` persists remote-server Caddy trusted proxy settings.
- `packages/server/src/services/web-server-settings.ts` normalizes trusted proxy settings and maps them into Caddy compile options.
- `apps/dokploy/server/api/routers/settings.ts` exposes Caddy trusted proxy read/update endpoints and rebuilds Caddy config when active.
- `apps/dokploy/components/dashboard/settings/web-server/caddy-trusted-proxy-settings.tsx` provides the local/remote UI dialog.

Migration and live-readiness evidence:

- `packages/server/src/utils/caddy/migration/prepare.ts`
- `packages/server/src/utils/caddy/migration/apply.ts`
- `packages/server/src/utils/caddy/migration/rollback.ts`
- `packages/server/src/utils/caddy/migration/upstream-preflight.ts`
- `apps/dokploy/scripts/caddy-migration-rollback.ts`
- `apps/dokploy/__test__/caddy/migration/*`
- `apps/dokploy/__test__/db/runtime-migration.test.ts`

## Implementation Plan

### 1. Preserve the proof document

- Keep this file upstream-safe.
- Update the readiness matrix as gaps close.
- Add proof log entries with command summaries, commit SHAs, and sanitized notes.
- Do not add prompt exports, private route manifests, or platform-specific production evidence to the PR.

### 2. Harden compose domain refresh for non-router creation flows

Original issue: `domainRouter.create` refreshed compose Caddy routes, but several service creation/import flows called `createDomain()` directly. That meant compose domains could be present in the DB without matching Caddy fragments until a later domain edit or deploy refresh.

Preferred design:

- Move the router-local Caddy compose refresh behavior into a reusable helper.
- Make it no-op for Traefik and refresh Caddy compose fragments when the active provider is Caddy.
- Call it after compose domain creation in template create, template import, AI compose generation, and project duplication paths.
- Keep rollback behavior local to shared compose domain create/delete helpers.

Implemented:

- `packages/server/src/services/domain.ts` exports `refreshCaddyComposeRoutes()`, `createComposeDomain()`, and `removeComposeDomainsForWebServer()`.
- `domainRouter.create`, template create, template import, AI compose generation, and project compose duplication now use `createComposeDomain()`.
- Template import removes old compose domain rows through `removeComposeDomainsForWebServer()` so Caddy fragments are refreshed even when the imported template has no replacement domains.
- `apps/dokploy/__test__/caddy/compose/domain.test.ts` proves the helper writes Caddy fragments for domains created outside the domain router and skips refresh for Traefik.
- `apps/dokploy/__test__/caddy/application/domain-service.test.ts` proves imported-template domain deletion refreshes Caddy with zero remaining domains, restores old routes if DB deletion fails, and skips Caddy refresh under Traefik.

Required tests:

- New compose from template under active Caddy writes fragments.
- Template import under active Caddy writes fragments.
- AI compose generation under active Caddy writes fragments.
- Project compose duplication under active Caddy writes fragments.
- Failure to write/reload Caddy leaves no orphaned domain rows or restores previous route fragments.
- Template import with zero replacement domains removes stale Caddy fragments.

### 3. Make preview domains provider-aware

Original issue: preview deployment route management imported and called Traefik `manageDomain()` directly after creating a preview domain.

Preferred design:

- Route preview domain management through `manageWebServerDomain()`.
- Ensure `application.appName` is still set to the preview deployment app name before provider dispatch.
- Add tests for preview domain creation under Caddy.

Implemented:

- Preview create now calls `manageWebServerDomain()`.
- Preview removal now calls `removeWebServerDomain()` when the preview deployment has a domain.
- `apps/dokploy/__test__/caddy/preview-deployment.test.ts` proves provider-aware create/remove behavior.

### 4. Prove application and compose domain lifecycle rollback

Application domains:

- Create should route through the active web server provider when a domain is created for a copied/new application service. Covered by `apps/dokploy/__test__/caddy/application/domain-service.test.ts`.
- Create should not leave a DB row if Caddy write/reload fails. Covered by `apps/dokploy/__test__/caddy/application/domain-service.test.ts`.
- Update should restore the old fragment if Caddy write/reload fails. Covered by `apps/dokploy/__test__/caddy/config.test.ts`.
- Update should restore the old fragment if DB update fails. Covered by `apps/dokploy/__test__/caddy/domain-router-lifecycle.test.ts`.
- Delete should restore the fragment if Caddy write/reload fails. Covered by `apps/dokploy/__test__/caddy/config.test.ts`.
- Delete should restore the fragment if DB delete fails. Covered by `apps/dokploy/__test__/caddy/domain-router-lifecycle.test.ts`.

Compose domains:

- Create should remove the new DB row and restore previous fragments if Caddy refresh fails. Covered by `apps/dokploy/__test__/caddy/application/domain-service.test.ts`.
- Update should restore DB fields and previous fragments if Caddy refresh fails. Covered by `apps/dokploy/__test__/caddy/domain-router-lifecycle.test.ts`.
- Delete should restore fragments if Caddy refresh or DB delete fails. Covered by `apps/dokploy/__test__/caddy/domain-router-lifecycle.test.ts`.

### 5. Decide and implement custom certificate behavior

Implemented behavior: support uploaded certificates for Caddy domains.

Implemented:

- Caddy application and compose route intents can carry uploaded certificate file references.
- Caddy config compilation emits manual certificate file loaders while keeping automatic HTTPS available for other routes.
- The Caddy domain UI labels the `custom` certificate provider as an uploaded certificate flow and restricts selection to certificates available to the current server.
- Missing custom certificate references fail before writing Caddy config.
- Migration dry-runs keep DB fallback routes with readable uploaded custom certificates and include the manual certificate files in the draft Caddy JSON.
- Migration dry-runs emit a blocking warning instead of generating DB fallback Caddy routes when a custom certificate reference does not map to an uploaded certificate with readable files for the same server and organization.
- Custom certificate guards ignore stale uploaded-certificate fields when HTTPS is disabled.
- Shared domain validation only requires `customCertResolver` when HTTPS custom certificates are selected, so preview-domain and API submissions are not blocked by hidden certificate fields.
- Active Caddy domains block deleting an uploaded certificate or replacing its cert/key files until the domain no longer references it.

Tradeoff:

- The implementation reuses the existing `customCertResolver` column to store the uploaded certificate path for Caddy, while Traefik keeps using it as a resolver name.
- This avoids a database migration in the PR, but the field name is Traefik-shaped. A provider-neutral schema rename or additive field remains a cleanup candidate if maintainers want stricter data semantics.

### 6. Add Cloudflare/proxy awareness

Default behavior:

- Do not trust arbitrary forwarded headers by default.

Cloudflare opt-in behavior:

- Provide a Caddy trusted-proxy mode for Cloudflare only when public traffic is expected to reach Dokploy through Cloudflare.
- Use static trusted proxy ranges in the standard Caddy image; the dynamic Cloudflare IP-source module is non-standard and should not be required by this PR.
- Validate any custom CIDRs before writing config.
- Document SSL mode caveats:
  - DNS-only works normally.
  - Orange-cloud proxy hides the real TCP peer behind Cloudflare.
  - Flexible SSL is not recommended for Dokploy origins.
  - Full strict is preferred with a valid origin certificate.

Tests:

- Default config does not trust forwarded headers globally.
- Cloudflare mode emits trusted proxy config.
- Custom CIDRs validate and compile.
- Invalid CIDRs fail before config write.

Implemented:

- `packages/server/src/utils/caddy/config.ts` supports trusted proxy compile options.
- `packages/server/src/utils/caddy/types.ts` defines compile and persisted trusted proxy setting types.
- Local `webServerSettings` and remote `server` rows persist Caddy trusted proxy settings.
- Caddy domain, compose, dashboard, migration dry-run, migration apply setup, and web-server setup paths pass persisted trusted proxy options into Caddy compilation.
- Settings -> Web Server exposes a Caddy trusted proxy dialog for local settings; remote web-server actions expose the same dialog for remote Caddy.
- The Caddy trusted proxy dialog includes Cloudflare origin SSL mode guidance: DNS-only or Full (strict) are acceptable; Flexible SSL is not recommended.
- `apps/dokploy/__test__/caddy/config.test.ts` covers default no-trust behavior, Cloudflare trusted proxy config, custom static CIDRs, invalid CIDR/header rejection, and persisted-setting normalization.

Still needed:

- Runtime proof after explicit approval.

### 7. Polish UI and dashboard behavior

UI changes:

- Use provider-neutral visible labels where users still see Traefik-specific wording for generic web server controls.
- Add a Caddy settings section for trusted proxy mode if Cloudflare support lands.
- Keep the provider selector guardrails: direct Caddy activation should go through migration apply, and Caddy to Traefik should go through rollback.
- Make dry-run/apply/rollback safety copy explicit.
- Warn in the migration panel that changing Caddy settings after a dry run requires preparing a fresh dry run before apply.
- Make update-server health checks provider-aware so the modal checks and displays Caddy when Caddy is the active web server.

Dashboard decision:

- Do not expose a public Caddy dashboard or admin API in this PR.
- Keep Caddy admin local-only.
- If a dashboard is desired later, it should be an authenticated Dokploy proxy and likely a follow-up PR.

### 8. Keep migration hardening intact

Do not weaken these gates:

- Apply fails closed on blocking warnings.
- Apply fails closed on runtime upstream preflight failure.
- Caddy config validation runs before Traefik is stopped.
- Apply fails closed if Caddy compile settings changed after the dry-run artifact was prepared.
- Rollback uses backup metadata and restores Traefik resources.
- Rollback CLI exits non-zero on failure.
- Runtime DB migration failure exits non-zero.

## Validation Ladder

Run and record the narrowest checks that prove the changed behavior.

Static checks:

```bash
git diff --check
```

Focused Caddy tests:

```bash
pnpm --filter=dokploy test --run __test__/caddy
pnpm --filter=dokploy test --run __test__/db/runtime-migration.test.ts
```

Targeted type and format checks:

```bash
pnpm --filter=dokploy typecheck
pnpm --filter=@dokploy/server typecheck
pnpm format
```

Shell checks, only if shell scripts are touched:

```bash
bash -n <script>
```

Read-only production checks, only when production proof is needed:

```bash
docker ps --filter label=com.docker.swarm.service.name=dokploy
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
docker service ps dokploy
docker service inspect dokploy-traefik
docker service inspect dokploy-caddy
```

Forbidden without explicit approval:

- Caddy migration apply
- Caddy migration rollback
- Provider state changes
- Docker service updates
- Docker service scale changes
- Container or service restarts
- Writing live Caddy or Traefik config files

## Live Mutation Approval Gate

No live mutation has been approved for this document.

Before any production mutation, fill this in:

```text
Approved by:
Approval time:
Mutation scope:
Rollback plan:
Expected read-only checks before mutation:
Expected post-mutation checks:
```

## Proof Log

| Date | Evidence | Result | Notes |
| --- | --- | --- | --- |
| 2026-06-01 | RepoPrompt Deep Plan run with Dokploy and infrastructure workspace roots | Complete | Generated implementation plan for upstream Caddy readiness. Generated prompt export must be removed from PR surface. |
| 2026-06-01 | `gh pr view 4534 --repo Dokploy/dokploy` | Complete | PR open, mergeable, review required, visible `anti-slop` check succeeded. |
| 2026-06-01 | `git status --short --branch` | Complete | Branch `codex/caddy-web-server-v0296-clean-pr`; clean before document work except generated RepoPrompt export. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/compose/domain.test.ts` | Passed | 1 file, 9 tests. Proves shared compose refresh writes Caddy fragments and skips Traefik. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/config.test.ts` | Passed | 1 file, 15 tests. Proves Caddy trusted proxy defaults, Cloudflare/static CIDR config, and validation. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 13 files, 84 tests before the custom certificate slice. Covers focused Caddy config, domain, migration, rollback, and runtime migration tests. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/application/domain.test.ts __test__/caddy/compose/domain.test.ts __test__/caddy/config.test.ts` | Passed | 3 files, 31 tests. Covers custom Caddy certificate file loading, compose domain refresh, and trusted proxy config. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 13 files, 86 tests after the custom certificate slice. Covers focused Caddy config, domain, migration, rollback, and runtime migration tests. |
| 2026-06-02 | `pnpm --filter=dokploy migration:generate` | Passed | Generated `0171_caddy_trusted_proxy_config.sql` for local and remote Caddy trusted proxy JSON settings. Node v26 produced the same engine warning. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/config.test.ts __test__/caddy/dashboard-route.test.ts` | Passed | 2 files, 18 tests. Covers persisted trusted proxy normalization and dashboard route settings shape. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 13 files, 87 tests after persisted trusted proxy settings. Covers focused Caddy config, domain, migration, rollback, and runtime migration tests. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/config.test.ts __test__/caddy/application/domain-service.test.ts __test__/caddy/preview-deployment.test.ts` | Passed | 3 files, 21 tests. Covers application create rollback, Caddy domain removal rollback, and provider-aware preview create/remove. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 15 files, 92 tests after preview and application route lifecycle proof. Covers focused Caddy config, domain, preview, migration, rollback, and runtime migration tests. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/domain-router-lifecycle.test.ts __test__/caddy/application/domain-service.test.ts __test__/caddy/config.test.ts __test__/caddy/preview-deployment.test.ts` | Passed | 4 files, 26 tests. Covers application and compose router lifecycle rollback plus service-level create cleanup. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 16 files, 97 tests after router lifecycle proof. Covers focused Caddy config, domain, preview, migration, rollback, and runtime migration tests. |
| 2026-06-02 | `pnpm --filter=dokploy typecheck` | Passed | App typecheck passed. Node v26 produced an engine warning because the repo wants Node `^24.4.0`. |
| 2026-06-02 | `pnpm --filter=@dokploy/server typecheck` | Passed | Server package typecheck passed. Node v26 produced the same engine warning. |
| 2026-06-02 | RepoPrompt oracle plan for the new-service domain tracker gap | Complete | Confirmed normal `application.create` has no domain payload and the application new-service-with-domain path is project duplication through `createDomain()`. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/application/domain-service.test.ts` | Passed | 1 file, 3 tests. Maps copied/new-service application domains to `createDomain()` provider dispatch and rollback coverage. |
| 2026-06-02 | Provider-neutral uploaded certificate UI copy | Complete | Replaced Traefik-only copy on the certificate settings page because uploaded certificates can now be selected by Caddy domains. |
| 2026-06-02 | `git diff --check` | Passed | No whitespace errors in the current local diff. |
| 2026-06-02 | RepoPrompt review with `back:3` diff artifacts | Complete | Incorporated production-code recommendations for Caddy certificate mounts, custom certificate availability checks, application domain creation compensation, preview route cleanup, and descriptive migration naming. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/migration/prepare.test.ts` | Passed | 1 file, 9 tests. Covers migration dry-run blocking warnings for missing uploaded custom certificate references. |
| 2026-06-02 | RepoPrompt review mode over `HEAD~3..HEAD` / `back:3` | Complete | Review findings incorporated locally: trusted proxy strict boolean, server/org/readable custom certificate guards, active Caddy certificate lifecycle blocks, stale migration compile-settings rejection, preview cleanup fail-closed behavior, and HTTPS-gated custom certificate fields. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/config.test.ts __test__/caddy/certificate-guard.test.ts __test__/caddy/migration/prepare.test.ts __test__/caddy/application/domain-service.test.ts __test__/caddy/compose/domain.test.ts` | Passed | 5 files, 43 tests. Covers strict trusted proxy JSON, certificate availability guard, migration custom-certificate blocking, and Caddy domain/compose route flows after review fixes. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/preview-deployment.test.ts __test__/caddy/config.test.ts __test__/caddy/certificate-guard.test.ts __test__/caddy/migration/prepare.test.ts` | Passed | 4 files, 36 tests. Covers preview route cleanup fail-closed behavior and certificate/trusted-proxy regressions. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/migration/apply-rollback.test.ts __test__/caddy/migration/prepare.test.ts` | Passed | 2 files, 21 tests. Covers migration apply rejection when compile settings changed after prepare. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/certificate-guard.test.ts __test__/caddy/certificate-lifecycle.test.ts` | Passed | 2 files, 6 tests. Covers same-server/org/readable custom certificate guards and active Caddy certificate delete/update blocks. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 18 files, 109 tests after RepoPrompt review hardening. Covers focused Caddy config, certificates, domain lifecycle, preview cleanup, migration prepare/apply/rollback, upstream preflight, and runtime migration tests. |
| 2026-06-02 | `pnpm --filter=dokploy typecheck` and `pnpm --filter=@dokploy/server typecheck` | Passed | App and server package typechecks passed. Node v26 produced the expected engine warning because the repo wants Node `^24.4.0`. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/domain-validation.test.ts __test__/caddy/preview-deployment.test.ts __test__/caddy/domain-router-lifecycle.test.ts` | Passed | 3 files, 11 tests. Covers optional custom certificate resolver validation when HTTPS is disabled plus preview and router domain regressions. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 19 files, 111 tests after shared domain validation cleanup. Covers focused Caddy config, certificates, domain lifecycle, validation, preview cleanup, migration prepare/apply/rollback, upstream preflight, and runtime migration tests. |
| 2026-06-02 | `pnpm --filter=dokploy typecheck`, `pnpm --filter=@dokploy/server typecheck`, and `git diff --check` | Passed | App/server typechecks and whitespace checks passed after the shared validation cleanup. Node v26 produced the expected engine warning. |
| 2026-06-02 | Provider-neutral Caddy UI copy pass | Complete | Updated trusted-proxy Cloudflare SSL guidance, migration stale-settings safety copy, and provider-neutral additional port mapping text. |
| 2026-06-02 | Upstream hygiene audit against `upstream/canary...HEAD` | Passed | 88 changed files. No `prompt-exports/`, `docs/plans/`, `docs/reviews/`, `AGENTS.md`, or `CLAUDE.md` in the PR surface. Private-string scan only found generic test values such as `private.registry.example` and HTTP cache header text. Commit subjects are generic. |
| 2026-06-02 | RepoPrompt Deep Plan pass for remaining Caddy PR gaps | Complete | Identified template import domain deletion as the highest-value production correctness gap because direct row deletion could leave stale Caddy compose fragments when an imported template has no replacement domains. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/application/domain-service.test.ts` | Passed | 1 file, 6 tests. Covers provider-aware application create, compose create cleanup, imported-template compose domain delete refresh with zero remaining domains, DB-delete rollback restoration, and Traefik no-op behavior. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 19 files, 114 tests after template-import compose-domain deletion hardening. Covers focused Caddy config, certificates, domain lifecycle, validation, preview cleanup, migration prepare/apply/rollback, upstream preflight, and runtime migration tests. |
| 2026-06-02 | `pnpm --filter=dokploy typecheck` and `pnpm --filter=@dokploy/server typecheck` | Passed | App and server package typechecks passed after template-import compose-domain deletion hardening. Node v26 produced the expected engine warning because the repo wants Node `^24.4.0`. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/web-server-health.test.ts` | Passed | 1 file, 4 tests. Covers active-provider web-server health checks for Caddy and Traefik, including Caddy swarm-service fallback and the existing Traefik helper. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 20 files, 118 tests after provider-aware update-server health hardening. Covers focused Caddy config, certificates, domain lifecycle, validation, preview cleanup, migration prepare/apply/rollback, upstream preflight, runtime migration, and active web-server health checks. |
| 2026-06-02 | `pnpm --filter=dokploy typecheck` and `pnpm --filter=@dokploy/server typecheck` | Passed | App and server package typechecks passed after provider-aware update-server health hardening. Node v26 produced the expected engine warning because the repo wants Node `^24.4.0`. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy/compose/domain.test.ts __test__/caddy/migration/prepare.test.ts` | Passed | 2 files, 21 tests. Covers compose custom uploaded certificate `load_files` and migration dry-run success with a readable same-server/org uploaded custom certificate. |
| 2026-06-02 | `pnpm --filter=dokploy test --run __test__/caddy __test__/db/runtime-migration.test.ts` | Passed | 20 files, 120 tests after custom certificate success-path proof. Covers focused Caddy config, custom certificates, domain lifecycle, validation, preview cleanup, migration prepare/apply/rollback, upstream preflight, runtime migration, and active web-server health checks. |
| 2026-06-02 | `pnpm --filter=dokploy typecheck` and `pnpm --filter=@dokploy/server typecheck` | Passed | App and server package typechecks passed after custom certificate success-path proof. Node v26 produced the expected engine warning because the repo wants Node `^24.4.0`. |

## Upstream Hygiene Checklist

- [x] No `prompt-exports/` files in the current diff.
- [x] No platform-specific hostnames, route manifests, or production logs in this repo.
- [x] No private runbooks or agent files added to PR surface.
- [x] Caddy fixtures remain generic.
- [x] Proof log entries are sanitized.
- [x] Commit messages describe generic Dokploy behavior, not private deployment details.
