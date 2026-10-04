# NONBUILDABLE / nonrunnable — authenticated observation connector packet

October 4, 2026, America/New_York; platform-infra #788 remains In Progress / Needs
assessment. October 8 preparation / October 9 viable-artifact route unchanged.
Builder: actual Codex CLI GPT-6 Astra medium, no delegated builder or reviewer.
Base: `5feba8036d20f166b08511e49033c65253bd2a31`, branch
`codex/hostler-observation-connector`. Accountable: Mason. Coordinator integrates,
reruns and obtains independent tool-disabled Opus 5.5 review. The source PR binds
actual review coverage and coordinator checks to the final file identities.

## Source contract

`observation_connector.inspect(Binding(...))` consumes one explicit, externally
trusted `Target`, CA/name, password and provisioning `Baseline`. It returns the
existing always-failing `Exit`, with both authority flags false. There is no CLI
configuration loader, generic SQL/DSN/executable input, application import,
migration dispatch, startup, restart or upgrade admission. Import and ordinary
unit discovery never connect. The older injected seam remains separately inert.

The caller must authenticate its provisioning inventory and bind the installation
ID to the complete Target and baseline **before** calling. This object does not
manufacture independent installation identity, validate a claimant's authority,
or accept a baseline learned from the database being assessed. TLS authenticates
the configured peer under the caller's CA; clones/cert reuse and incorrect
external inventory remain the caller's trust boundary. Stock catalog/builtin and
local executable, system OpenSSL configuration, temporary-directory parent and
CA-file integrity are assumed. The CA is bound by a trusted path, not a content
digest; the caller must prevent replacement between validation and client open. No operator grant is executed or requested.

This preparatory adapter currently supports the explicitly installed macOS
Homebrew PG18 client only; Linux/toolchain acquisition and packaging remain
unqualified. Only `/opt/homebrew/opt/postgresql@18/bin/psql` is launched,
without a shell, with a numeric host address, separate TLS hostname, exact database
and role, `sslmode=verify-full`, explicit CA, SCRAM-only authentication and required
channel binding; client certificates are explicitly disabled. Only PG18
server-version results are accepted; standby/recovery and superuser observers
refuse. Client encoding is explicitly UTF-8. IPv4-mapped IPv6 text and NAT/port
forwarding may conservatively fail identity comparison. No retries,
pooling, downgrade, service selection, rc files or inherited environment are
used. A new private empty HOME and system-config directory isolate default TLS
and user files; passfiles/service files point at `/dev/null`. Password is supplied
only in the child's fresh environment, excluded from Binding repr and argv.
Same-user or privileged local process inspection can expose the child password
environment and remains outside this boundary. CA and password
are supplied explicitly; there are no operational environment/credential readers.
Names use a deliberately narrow lower-case identifier grammar. Host names,
numeric addresses, ports, baseline types and CA file presence are checked before
process launch; paths use libpq keyword-value escaping, never SQL interpolation.

One fixed script begins READ ONLY / REPEATABLE READ, sets catalog search path and
statement limit, performs a single SELECT and rolls back. Exact command tags,
one JSON object with exact unique fields, native observation types, PG18 version,
external identity, catalog permissions and baseline equality must validate.
A ROLLBACK tag and successful physically exited/reaped client are required before
any candidate. Unexpected stderr, extra/missing/malformed/oversize output, query
failure, timeout or cleanup failure refuses with sanitized text. Connect and
statement limits are 2 seconds (lock limit 1 second); communication wall limit is
5 seconds, with kill/reap and a further 2-second reap bound. Cancellation propagates after successful cleanup. A cleanup exception may replace
cancellation and return a sanitized refusal; no candidate survives cleanup failure. Failed queries physically close/abort instead of
claiming a confirmed rollback. No process handle is pooled or reused. Output is
spooled to owned temporary files, read at most 65,537 bytes and refused over 64 KiB;
the spool itself has no byte quota during the wall-bounded fixed query.

`pg_subscription` now reads/counts only `oid`, checking column privilege and
non-RLS status rather than demanding full-table SELECT on secret columns.
The dedicated observer needs pre-provisioned EXECUTE on `pg_control_system()`
and SELECT(oid) on `pg_subscription`, plus normal catalog/public-schema/database
visibility. The fixture revokes the corresponding PUBLIC grants and then provisions only
those metadata grants to its observer, so revocation tests remove effective
access. Stock PG18 PUBLIC grants may already supply that access. The connector
never grants privileges, and superuser observation explicitly refuses.

The new SELECT also compares exact external public-schema owner and raw public
and database ACL text (including NULL versus explicit ACL) and counts user OIDs in
casts/operators/operator classes/families, collations/conversions, text-search
objects, languages/access methods/transforms. All foreign-data wrappers, security
labels (including shared labels) and replication slots refuse; every added catalog
has full SELECT/non-RLS checks. ACL ordering differences conservatively refuse.
Existing database ownership binding and original structure/default-ACL/settings/
prepared-transaction checks remain. The public-schema baseline for the fixture is
an explicitly declared PG18 stock expectation, not captured from its target.
Cluster ID and DB OID are obtained as creation receipts from the exclusively owned
new fixture cluster, never a preexisting installation.

This is still an enumerated point-in-time `NEW_EMPTY_CANDIDATE`, not complete
absence, history, rights, build, installation, runtime or production proof.
Catalog administrator tampering, stock-object alterations, policies/role membership
semantics, shared roles/tablespaces, databases other than the target, externally
managed resources and concurrent/uncommitted writes are not exhaustively qualified.
Functions, privilege/system caches, slots and shared metadata are not claimed to
share one atomic catalog snapshot. No writer exclusion or future admission lease
exists. All remaining inventory/identity and restart/upgrade gaps keep startup
inadmissible on every path.

## Verification and retained failures

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 -m unittest discover -s community -p 'test_*.py' -v
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 community/pg18_fixture_tests.py
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 scripts/test-mason-release.py
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 community/observe_entry.py
git diff --check
```

Builder results: ordinary discovery **44/44 passed**, including 4 connector unit
methods, 17 existing observation methods and 23 foundation methods. Release
contracts passed. Standalone entry remains `REFUSE_UNCONFIGURED`, exit 1, both
flags false. Whitespace and owned-path/preserved-byte checks passed.

The builder's real PostgreSQL gate ran **zero SQL methods**: the sandbox denied
`initdb` shared memory (`shmget`). No bypass occurred. The coordinator inspected
the harness and ran it through the normal approval path for this authorized
fresh synthetic loopback fixture. PostgreSQL/psql **18.6**, OpenSSL **3.6.5** and
Python **3.14.8** were already installed; no dependencies were acquired.

The first coordinator run exposed ineffective permission revocation: removing an
observer grant left PUBLIC access effective. The fixture now removes that PUBLIC
access before granting the dedicated observer. Its original timeout-readiness
query also contended with the locked catalog; the final harness locks
`pg_subscription` and tracks the exact owned backend PID. These were fixture
failures, not passing or skipped cases. The connector cleanup now closes stdin
even if process cleanup raises, and disables client certificates explicitly.

After integration, the coordinator reran **44 unit methods and 11 real PG18
fixture methods**, all passing. The real gate exercises authenticated empty
observation with a nonsuperuser/no-full-subscription-access role; wrong CA,
hostname and password; external identity and an owned unlistening endpoint;
effective permission denial; hidden/RLS/migration/marker/type state; external
public/database ACL/ownership drift; extra metadata; poisoned ambient variables;
actual catalog-lock timeout and fresh partial → empty recovery, and superuser
observer refusal. An additional
adversarial fixture first proves the owned TLS server accepts a wrong password
under `trust`, then proves the connector refuses that authentication downgrade.
Cancellation and wall-timeout fault injection kill/reap a real owned client and
assert its input pipe closed; this is fault-injection evidence, not a naturally
expired communication timer. The real lock timeout exercises the unchanged
connector and its lock-timeout setting; it does not separately exercise the
statement-timeout setting. Standby and non-PG18 refusal are decoder tests; no
replica or different PostgreSQL major was launched. Real permission revocations
exercise SQL permission errors, not a completed result with false permission flags. Every outcome retains false
migration/runtime flags and exit code 1.

Independent tool-disabled Opus 5.5 found no merge blocker in the first candidate.
Its standby recommendation led to explicit recovery/superuser refusal, stronger
process assertions, fixture cleanup/reload waits and more precise trust/evidence
limits. The PR binds the corrective review to the final file hashes.

A separate coordinator decoder probe rejected **145 malformed observation-field
cases, four invalid snapshots and five framing attacks**. Its positive control
remains a candidate with both authority flags false. Release contracts passed;
standalone entry still refuses unconfigured. These are local checks, not hosted
CI, production or installation evidence. The source PR retains exact review and
final revision coverage.

The fixture owns one random private directory, loopback-only listener, disabled
Unix sockets and generated throwaway TLS/credentials; it stops its exact
postmaster and removes only its own directory after a clean confirmed exit.
Unclean/forced postmaster exit retains the owned directory and fails the gate;
client exits and authentication reloads are boundedly awaited. The fixture
passes its password only to its psql clients, not initdb/OpenSSL/postmaster. No existing
service or imported data is contacted. Secrets/raw logs are not review inputs.
Default discovery does not match/import this explicit harness. Missing binaries
or denied shared-memory/loopback capability fail explicitly rather than skipping.

Changed files: `state_observation.py` (safe subscription visibility), new
`observation_connector.py`, `test_connector.py`, `pg18_fixture_tests.py`, this doc,
and the README pointer. Maintained source/runtime, schema/auth/proprietary code,
foundation exporter/pinned contract/inventory/policy and empty overlays are
byte-identical. The whole community directory remains excluded from the pinned
NONBUILDABLE inspection export. No maintained installation or live operational action is exercised by these tests.

## Next reviewable gate

Keep coordinator reruns and revision-bound tool-disabled Opus 5.5 review on the
source PR. The next source slice must define writer exclusion/reobservation and distinct initial migration versus
bound compatible restart/upgrade state admission, with crash/partial-migration
and recovery tests. Runtime handoff, export revision, auth/API/UI source closure,
compiler/emitted-content checks and installation qualification remain separate.

Primary references: [libpq connection parameters](https://www.postgresql.org/docs/18/libpq-connect.html),
[TLS verification](https://www.postgresql.org/docs/18/libpq-ssl.html),
[psql error handling](https://www.postgresql.org/docs/18/app-psql.html), and
[subscription column visibility](https://www.postgresql.org/docs/18/catalog-pg-subscription.html).
