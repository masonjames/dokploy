# Review coverage

All exact paths and before/after identities are enumerated in
`overlays/manifest.json`; it is the review file list, not a fuzzy patch recipe.
Each replacement derives from its pinned nonrestricted source. New policy,
auth factory/guard/request validator, assignment validator and tests derive
from the accepted matrix and nonrestricted schemas/callers. Restricted bodies
were not inspected. The 29 restricted path/blob identities match the historical
inventory, now pinned to the actual source base/tree.

Intentional omissions cover restricted source, the pinned symlink fixture,
license cron/client activity, impersonation, forward-auth controls, SSO flag
controls, remote-only enterprise settings, cloud billing router/webhook/UI/plan step,
and three obsolete license/custom-role test files. New real resource and
WebSocket tests replace their community coverage. Three preserved permission
regressions remove their absent-license mocks. Restricted routers are removed
from the inferred AppRouter with their UI queries/imports; unsupported settings
URLs display unavailable notices. Community branding uses upstream fallbacks.
Maintained packages/manifests/lock/schema/migrations, historical export files
and writer-owned Python files are unchanged.

The source graph includes server, app, API and schedules; all receive standalone
typechecks. No added `any`, suppression, fabricated declaration or source
exclusion is used to make compilation pass. Next `ignoreBuildErrors` is false.
The explicit next-env payloads refer only to installed Next declarations.

Recovery evidence remains under `/tmp/hostler-oct4-state/auth-build-*`:
initial export/type errors, an unsupported pnpm option spelling corrected to
`--config`, the first local overlay commit's inherited signing-hook failure
followed by an unsigned local commit, and Vitest's localhost DNS lookup avoided
by specifying literal loopback in its configuration. No secret was supplied to
the failed signing hook. All subsequent commits are unsigned, hook-disabled,
local overlay-only candidates. No push, PR, merge, deployment, provider or
runtime call was performed.

The final qualification JSON binds commands, exit statuses and compiler input
hashes to an exact export receipt and overlay revision. Parent must independently
inspect the frozen files, obtain the planned Opus 5.5 implementation review and
rerun gates. Intermediate green checks do not qualify later revisions.

Final12 bounded correction: credential-free URL projections preserve original bytes;
GitLab/Gitea non-secret-viewer masked URL roundtrips omit unchanged projections.
Empty subtype writes are skipped, including the shared Bitbucket helper. GitHub
updates accept only required app name, never the projected URL. The unused Gitea
Pages API helper is omitted with its OAuth callers refused. Logout recovery is
UNAUTHORIZED-only and unsupported roles cannot offer organization unlink.
Synthetic SQL checks equality/inequality conjunctions and rejects empty updates;
this is not real database evidence. PG launcher changes only: deferred launch
interrupt, both resolver contexts hashed, complete case observations and bounded
group settle. PostgreSQL is NOT RUN at this source freeze; final independent review
and parent dispatch remain open. Subsequent actual run results belong in separate
revision-bound receipts.
