# Community source qualification contract

Source only: no bundle, image, Linux distribution, installation, migration,
admission, startup or runtime qualification. All authority flags are false.
Base `aebf69526ed168e985f50f9a973a85ea1f7519f9`, tree
`714618d089473c2e7200f0bd4127b4bdde5d49f7`; overlays have a separate explicit
commit in `/private/tmp/hostler-auth-build-overlay-revisions`. Parent verified
the GPT-6 Astra medium CLI builders; a GPT-6.1 Sol CLI builder prepared
formatting/inventory corrections. Independent tool-disabled Claude Opus 5.5
reviews covered prior frozen revisions. Historical final12 overlay
`ff119a0dfebc8778ae4fdfd68c9b06184c5ce2a7`, export receipt SHA256
`4e0081018d39fea4d87c9266decd0df6b23deb8643dc184b7878c126236459bb`,
received actual tool-disabled Opus 5.5 source acceptance. Parent fresh checks on
that exact revision passed: four TypeScript compilers, 448 tests, 31 Python tests,
23 legacy tests, release contract and Biome. The compact review receipt is
`/tmp/hostler-oct4-next/opus-auth-final12-small-review-receipt.json`.
That evidence is revision-bound; this fixture-only successor still requires
independent review and parent fresh gates. No successor review or gate pass is
claimed at this source freeze.

## Source gates

`export_source.py SOURCE FRESH_DEST --overlay-source OVERLAY_REPO
--overlay-revision FULL_COMMIT` reads only pinned committed blobs. It refuses
source/overlay drift, dirty/untracked overlay inputs, restricted path/hash/blob
copies, unsafe/nonregular entries, collisions and extra payloads before output.
It preserves original executable modes and binds materialized modes in receipts.
The legacy NONBUILDABLE exporter, writer modules, maintained source, schemas,
manifests and frozen lock remain byte-identical.

Preservation and source-diff gates apply in the bound-base worktree/export context.
A merge may coexist with newer writer files, but direct qualification from that
combined checkout must refuse pending an explicitly approved new-base rebind,
separate export and complete rerun. Never advance pins automatically.

Use only cached pnpm10.34.5 with `install --offline --frozen-lockfile
--ignore-scripts --store-dir /Users/masonjames/Library/pnpm/store
--package-import-method=copy --config.manage-package-manager-versions=false
--config.side-effects-cache=false`. The executable identity is in the external
handoff. Lock SHA256 is
`779ede461b31522ec830f57c3cd1415e7049c207c6044374f04358cec2ec1e95`.
Installed bcrypt may be compiled offline using the exact recorded node-gyp and
Node24 headers; no downloads, package installation or lifecycle dispatch.

`verify_export.py EXPORT --evidence-prefix FRESH_PREFIX` runs authoritative
Node24.21.0/TS7.0.2 standalone noEmit checks for server, app, API and schedules,
then the scoped exported suites. It binds actual exits, configurations, compiler
inputs/resolutions and realpaths/hashes, tests.json, counted-tests.json, exhaustive
route census, raw resolver trace and validated/classified test-input inventory.
All absolute existing compiler file lines are examined before confinement checks.
Unresolved test graph entries fail; builtins/virtual IDs are explicitly classified.
Restricted inputs and maintained-checkout escapes are forbidden. No absent-module
mocks, added `any`, suppressions or weakened compiler exclusions are permitted.

`PYTHONDONTWRITEBYTECODE=1 COMMUNITY_OVERLAY_REVISION=FULL_COMMIT python3 -m
unittest discover -s community/build/tests -p 'test_*.py'` checks deterministic
export, modes, real dirty/mismatched overlay refusal before output, corrupt
metadata and preserved source/writer identities. Intermediate failed receipts
stay external and remain failures; later green receipts never relabel them.

## Preserved behavior and evidence categories

B1–B6 remain the source contract. Exact membership and built-in-role checks
precede current-organization resource authority. Owner assignment updates
validate every target before writing. Observer restrictions remain. Invitation
roles are admin/member/observer; default roles are admin/member/null. Cancellation
changes status; unlink removes only the membership. Saved enforced SSO and
protected forward-auth state refuse unsupported changes.

The actual factory enumerates/classifies 92 API entries: 86 HTTP endpoints,
88 method/path pairs and six pathless methods. Unexpected/missing routes fail
construction. Retained admin hooks do not expose admin HTTP; direct API-key HTTP
is denied. Local passwords, sessions, 2FA and passkeys remain; SSO/SCIM/social
login/dynamic-role plugins are removed. Audit storage is explicitly unavailable.

Provider leaf edits resolve subtype-parent linkage, membership and organization
before writes. Own/shared/owner edit rules remain independent of assignment/use
and existing operation permissions. Input cannot transfer organization/user/
provider linkage. Actual-router tests cover refusals and allowed edits.

`test-contract.json` enumerates injected persistence, crypto and external-effect
replacements. In-memory adapters prove policy/order only. Password gates use the
shared production bcrypt cost10 hash/compare configuration with good/bad
credentials. Real TOTP enrollment/challenge verification and ES256 passkey
signatures use synthetic storage and the real clock. All retained permission
suites and the existing WebSocket authorizer suite are counted. Three superseded
license/custom-role suites and meaningful replacement coverage are explicit.

The compact runnable audit inventory retains every one of the original 311
call contexts and exact source identities. Three auth/wrapper calls and two
removed settings calls and the refused global user.remove call are explicitly absent; 305 retained router calls discard
the awaited result. Catch/transaction context is compared, operation failures
remain tested. The full AST/catch-body inventory is external; no unused duplicate
or intermediate qualification trace belongs in the source packet.

## Parent-only PostgreSQL gate — NOT RUN at this source freeze

`pg18-contract.json` freezes the independent oracle and HTTP mappings before
execution: ordinary refusals 403 AUTHORIZATION_DENIED, used invitation 403
INVITATION_NOT_PENDING, existing membership 403 MEMBERSHIP_ALREADY_EXISTS,
transaction rejection 500 AUTH_STATE_WRITE_FAILED. Catch outside transaction;
no raw database error or automatic retry. The shared organization row lock is
intentionally coarse: all invitation accepts for one organization serialize.
Membership/status/session updates remain in that transaction.

Oracle SHA256
`40116667785c6ea8d1bc32f4df97148dc21adef33f3df66b97b9de017e7825a8`.
The oracle is immutable. `pg18_fixture.py` is separate from writer-owned fixtures.
Parent must inspect its exact frozen source and process/cluster ownership before
dispatch. It starts a fresh initdb-owned PG18 cluster, private task directory and
Unix socket, TCP disabled; no imported DB, identities, provider or application
listener. Bounded owned child groups must stop before successful cleanup;
failed/uncertain state is preserved. Output contains semantic hashes, bounded
outcomes and SQLSTATE class, never cookies/tokens/raw database errors.

The exported actual handler must prove B→A session continuity using its real
cookie jar, same/distinct invitation contention, winner-only role, trigger-induced
rollback from another connection, separate recovery and no-write refusals. Two
nonlocking reads while a holder owns A are the negative control; two actual
handler backends must then wait on DB locks before release. BetterAuth1.6.23 does
not require new-cookie issuance with teams disabled: merge returned cookies into
the existing jar and call actual get-session. Real PG concurrency, rollback and
cookie acceptance remain unproved until the parent successfully runs this gate.

Provider-assignment admission reconciliation, combined-source requalification,
Next/esbuild bundles, OCI/Linux/native distribution and runtime/soak remain
separate. Parent independent reruns and tool-disabled Opus5.5 implementation
review remain required; this source does not close the operational route.

## Final corrective source candidate

The overlay-only repository contains community/build tooling and nonrestricted
replacement/addition payloads, including full replacement files preserving modified
maintained source. It contains no complete checkout or proprietary implementation
bodies. Maintained runtime files remain unchanged in the source worktree; original
base pins and exact before-blob provenance remain authoritative.

OAuth setup/initiation/callback is explicitly unavailable (503) in GitHub setup,
GitLab callback and Gitea authorize/callback, independent of method or parameters.
The unused Gitea Pages helper is omitted. UI creation/connection actions are disabled;
configured-provider use and ordinary CRUD remain. OAuth completion remains an open,
unqualified capability, distinct from the local BetterAuth route census.

Member responses redact stored Bitbucket credentials and provider URL userinfo.
Blank masked Bitbucket/Gitea secret replacements preserve stored values. Owner/admin
same-organization secret authority remains. Profile edits whitelist ordinary fields,
reject changed email before writes, and update passwords only on credential accounts.
Global account deletion refuses; UI removal uses organization.removeMember. Member
role updates compare organization and prior role and require one returned row.

All 22 settings server-ID handlers and server.getDefaultCommand authorize concrete
current-organization targets first. Member file access intersects assignments;
cleanup validates active state and performs a scoped conditional update before
scheduling. Traefik-only operations refuse Caddy before env/port probes. Omitted IDs
retain the inherited shared-manager/singleton behavior, which has no organization
ownership model and is NOT tenant-isolation or admission proof. Authorization is
not atomic across later remote/background execution or concurrent revocation.

PG launcher hardening is source only; NOT RUN at this source freeze.
Subsequent actual results belong in separate revision-bound receipts. Fixed Node24/PG18
binaries run with a minimal environment and fresh private HOME. Exclusive private
receipts track owned child groups, bounded shutdown and output hashes; failed or
uncertain state is preserved. Cleanup requires a clean postmaster exit, stopped
owned groups and matching root/socket/HOME device, inode, UID and mode identities.
Production/API/UI and default 448-test bytes remain unchanged from accepted
final12. Its acceptance covers those exact historical bytes; the new fixture-only
delta requires independent review and parent fresh gates.

The first actual final12 PG receipt,
`/tmp/hostler-oct4-next/coordinator-auth12-pg18-first.json`, records failure at
`transaction-failure` after single-invitation and both contention/session
observations passed. All owned children stopped and the postmaster exited cleanly;
the failed fixture remains preserved. The complete rollback/recovery/refusal gate
did not pass. A fourth-seed sign-in limiter rejection remains a source-supported
inference because that original receipt lacks check identity. Successor PG is
NOT RUN at this source freeze; any subsequent result belongs in a separate
revision-bound receipt.

Explicit parent-authorized rebind from historical `6724c191bca8d30c8985d50f873a15e8620551c3` to `aebf69526ed168e985f50f9a973a85ea1f7519f9` preserves all noncommunity tree entries and overlay before identities; all 13 incoming writer files are separately preserved. The application exporter omits community/**, so writer tools require separate OCI assembly inclusion/binding; ancestry does not qualify a combined image. Historical oracle `2cbf7f8a3ff9dc2131b058fb2954c10e2af0400d27e6343e2d38139d86246808` remains unchanged; the separately authored combined-base oracle `40116667785c6ea8d1bc32f4df97148dc21adef33f3df66b97b9de017e7825a8` preserves its outcomes.

Final verifier rejects optimized Python, reused evidence prefixes, inventory drift and first-party graph files absent from or differing from the export receipt. Fixed Node24 and a fresh private HOME with minimal explicit child environment are used; this is not an OS network sandbox. Test replacements do not prove production lib/auth.ts runtime wiring or transitive runtime dependency behavior.

Unsupported saved-role editing is disabled without a member fallback; stale active-organization refusal points to the existing Account → Log out path without promising recovery. Six static unavailable settings pages remain signed-out presentation surfaces without protected data/SSR redirects; this is a recorded nonblocking limit. Runtime/bundle qualification remains open.
