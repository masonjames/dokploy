# NONBUILDABLE / nonrunnable — exact prestate reobservation prerequisite

October 4, 2026, America/New_York; platform-infra #788. Actual builder: Codex CLI
GPT-6 Astra medium in this session. Base:
`293180a7d9b9a1a1eeaca135d1d59d93e175ae4e`, branch
`codex/hostler-prestate-boundary`. Coordinator integration results follow below. Review outcomes and covered file
hashes belong in the source PR; this document does not itself establish review
acceptance. No operational authority is supplied by this source packet.

## Executable boundary

`observation_connector.inspect_evidence(binding)` adds a diagnostic digest to the
existing connector. `inspect` and `decode` keep their existing return contracts.
Only a validated empty candidate has a digest, published after rollback framing,
physical client exit and temporary resource cleanup. The digest is SHA-256 of
ASCII canonical JSON (`sort_keys=True`, compact separators, `ensure_ascii=True`)
of `scope` and `observation`. Scope contains the full external Target, Baseline,
TLS hostname, CA path and (when pinned) external CA SHA-256; observation contains the entire validated envelope,
including snapshot, server version, permissions, counts and ACL values. Passwords
are neither hashed nor returned. Changing installation association or TLS scope
cannot reuse an old digest even when the SQL observation is identical.

`prestate_boundary.check(binding, candidate_sha256, expected)` takes a separately
retained `Expected` proposal scope: Target, Baseline, TLS hostname/CA path and required external CA SHA-256, exact
lowercase SHA-256 candidate identity and prestate digest. The caller must obtain
inventory/proposal facts independently and retain evidence from a prior
trusted authenticated observation. There is no untrusted map/config loader and
no claim that constructing a dataclass authenticates inventory or a proposal.
The candidate identity is compared, not loaded, built or verified as an artifact.
The prestate digest is unkeyed and computable from supplied bytes; it does not
prove that a prior authenticated observation occurred. External evidence provenance
is a caller prerequisite, never something the digest authenticates.

All Expected inner fields undergo the same exact native-type and grammar checks
as Binding before equality or filesystem access, including Target, baseline ACLs/
owner, TLS/path and all digests. Trusted caller provenance remains a separate
requirement; shape checks do not authenticate inventory.

The exact check requires a lowercase external CA SHA-256 on both Binding and
Expected. It must come from trusted provisioner/inventory certificate bytes, never
from the observed target or automatic acceptance of whatever the current path
contains. Each fresh read opens the source once with `O_NOFOLLOW | O_NONBLOCK`,
checks the descriptor is a nonempty regular file at most 1 MiB, reads at most
1 MiB + 1 and verifies the digest. Missing, malformed or mismatched pins, empty/
oversized files, final-component symlinks, FIFOs and other special files refuse
before psql. Verified bytes are written exclusively to a new mode-0600 CA child
in the owned private temporary directory. psql receives only that snapshot path;
it never reopens the mutable source. Changing the source after pin verification
cannot change that connection's trust; the next observation pins again. Evidence
is returned only after client reaping and all owned resource cleanup succeeds.
The temporary-directory parent selected by the local environment (including
`TMPDIR`) and the client executable must be trusted. Private directory modes do
not exclude an attacker controlling that parent or the same OS account.
Same-UID mutation of the owned private directory and hard-death cleanup are not
proven filesystem exclusion. Filesystem cleanup failure suppresses evidence;
physical removal cannot be guaranteed when the filesystem itself refuses cleanup.
Legacy unpinned inspect behavior remains available for compatibility; it cannot
satisfy the exact check. The clean psql environment, TLS verify-full, channel
binding and required SCRAM authentication remain unchanged.

Scope mismatch refuses before connection. For `first-migration` only, two new
physical connector observations must each match the expected digest. Either error,
identity mismatch, ACL drift, visible partial/migration/marker state, changed
snapshot/version or incomplete cleanup refuses. Identical reads return positive
`observations_match` evidence **and `REFUSE_WRITER_EXCLUSION`**. Every returned
outcome retains exit 1, false migration/runtime flags and false writer exclusion.
Restart, upgrade, recovery and unknown purposes refuse before connecting. No
callback, runtime dispatch, mutation SQL or first-migration executor exists.

Snapshot comparison deliberately refuses unrelated transaction movement. It is
not an exhaustive database fingerprint, proof of first use, zero writes, temporal
lease or atomic prestate. Uncommitted work, ABA changes, changes outside the
catalog inventory and writes after either read can escape this comparison.
No advisory lock or matching observations establish database-wide exclusion.
There is no time-based validity claim: even immediately matching reads refuse
admission. See the [connector packet](connector-packet.md) for inherited catalog,
peer, PG18/macOS and external inventory trust limitations. This exact path
replaces the legacy CA-path-only assumption with external content pinning.

## Interruption and preservation

Each call starts again; there is no session handle, receipt loader, resume state,
installation marker or migration progress journal. Diagnostic expectations may
be serialized by a caller, but remain nonauthorizing and always require fresh
reads. Cancellation propagates after connector cleanup. Hard process death cannot
produce a returned comparison and is not claimed to run Python cleanup; no local
memory state is recovery authority. The existing server transaction timeout is
not a writer-exclusion mechanism. Partial state discovered after interruption
refuses; synthetic later-empty state only restores comparison evidence, never
proves safe repair or permits a retry/migration. No database cleanup/repair runs.

Maintained launch remains migration first (`apps/dokploy/package.json`), then
server initialization/Next/listener/WebSockets/Caddy/workers. A server-body guard
would be too late. This separate Python seam does not guard or dispatch that
launch. Maintained runtime, schemas/auth, proprietary implementation, exporter,
pinned contract/inventory/policy and empty overlays remain unchanged. These new
files are excluded from the pinned inspection export.

## Verification and review packet

Ordinary synthetic discovery patches the psql process surface; it never opens a
DB. Tests cover each external target field, candidate and trust-scope substitution,
old evidence moved to another installation, stale prestate, second-read drift and
errors, visible partial state, cancellation in either read, cleanup failure and
fresh recovery, canonical digest coverage, inert imports and identical observations
with hypothetical invisible concurrency. The latter is an explicit limitation
trace, not a real concurrency/exclusion experiment. Cancellation and malformed
truncated output are synthetic crash-path evidence, not a hard-kill experiment.
No OS shared-memory/loopback fixture gate was run in this builder sandbox.

Commands and final results are recorded in the builder return. Review inputs:
`observation_connector.py`, `prestate_boundary.py`, `test_prestate.py`, this packet,
README pointer, extended `pg18_fixture_tests.py`, unchanged observation/policy/entry
contracts and the base diff.
The coordinator must bind review coverage to final file identities.

Next smallest prerequisite: specify an enforceable database-wide writer boundary
and uncertain-write reconciliation under the future mutation controller, including
external target/content-pin provenance and compatible restart/upgrade policy. A
read-only connector cannot establish that boundary; operations and migration
execution need separate exact authority and implementation/review.

Source checks are not build, installation, runtime journey or natural-soak proof.
October 9's viable locally tested artifact plus concrete contents, naming and
redistribution rights remains at risk and is not satisfied here. Export revision,
auth/API/UI closure, Linux packaging and compiler/emitted-content evidence remain
separate gates.

Builder results after the content-pin and Expected-validation correction:

- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s community -p 'test_*.py' -q`: **61 tests passed**.
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-mason-release.py`: passed.
- `git diff --check`: passed.
- AST parsing of every community Python file (including the explicit harness): passed.

New offline tests cover verified snapshot bytes/modes, source replacement after
pin validation, same-path changed CA, missing/malformed pins, empty/oversized
files, symlink/FIFO/directory rejection, adversarial Expected fields (including
bool/int aliases, string subclasses and hostile equality), snapshot creation,
launch, cancellation and cleanup failures. No synthetic test failures occurred
in this correction run (intermediate discovery: 60 tests; final: 61).

The explicit PG18 harness now retains the fixture provisioner's CA pin before
observations and adds authenticated prior evidence followed by two real fresh
reads, partial schema between reads, candidate/target/pin drift with no launch,
and source-path replacement with real psql consuming the verified snapshot.
Assertions distinguish authenticated first-read evidence from second-read pin
refusal. **The builder did not execute this extended harness.** The coordinator separately
ran the installed PG18/OpenSSL fixture gate as recorded below. No artifact build,
installation, runtime journey or soak gate was run.


## Coordinator integration evidence

The coordinator inspected the complete diff and reran the actual final-source
commands with existing Python 3.14.8, PostgreSQL/psql 18.6 and OpenSSL 3.6.5:

- `PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 -m unittest discover -s community -p 'test_*.py' -v`: **61 passed**.
- `PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 community/pg18_fixture_tests.py`: **16 passed** in an exclusively owned disposable synthetic loopback cluster. The clean-stop/owned-directory cleanup gate passed.
- `PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 scripts/test-mason-release.py`: passed.
- `PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 community/observe_entry.py`: expected `REFUSE_UNCONFIGURED`, exit **1**, both authority flags false.
- Python AST, Markdown relative links, tracked/untracked whitespace and exact preserved-source checks passed. Changes are confined to the six reviewed community files; the maintained runtime, fixed exporter/contract/inventory/policy and empty overlays remain unchanged.

The real new-boundary gate proves three physical authenticated observations
(prior evidence and two fresh reads) still end in writer-exclusion refusal. A
partial table committed between reads refuses. A separate create-then-drop
fixture leaves enumerated state empty but advances the snapshot; the second
observation is a candidate and its digest mismatch reaches `REFUSE_PRESTATE`. Target/candidate/pin drift launches
no client. Replacing the original CA path after snapshot creation leaves the first
real authenticated client using the verified bytes; the next observation rejects
the changed pin before launching a second client. No existing service, imported
data or operational credential was used; no dependency was acquired.

Integration corrected two initial source gaps before review: expected inner
fields previously reached equality without full validation, and CA trust was
bound only by pathname. Hostile equality tests use an external call counter so
catching an assertion cannot hide a comparison. Failure/recovery traces retain
partial-output, query/cleanup failure, cancellation and fresh partial/empty
reobservation; they never establish a successful migration or safe write retry.

The concurrency trace remains synthetic identical observations; no test claims
to exclude a concurrent PostgreSQL writer. No hard process-kill recovery or
compatible restart/upgrade admission is established. Local passing tests do not
claim hosted CI, a viable community build, installation or natural soak.


Initial independent Opus 5.5 review found two documentation blockers: the inherited
Python floor did not cover the expanded test suite, and the introductory review
wording could imply acceptance of its own bytes. Both were corrected. The
coordinator also added a real snapshot-drift refusal and captured the three actual
client processes in the positive comparison fixture. Review revision coverage and
any corrective verdict remain in the PR, independently of this document.
