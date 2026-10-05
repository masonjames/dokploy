# First synthetic maintenance/migration increment — parent gates passed

The parent’s independent fifth PostgreSQL **18.6** synthetic gate passed:
two methods ran in three newly owned clusters. The small hand-authored catalog
and row oracle matched, with two ledger rows. Maintained Drizzle and independent
psql each completed the selected **196-migration** chain with matching bounded
catalog descriptors and ledgers. This is **differential-only evidence**, not an
independent full-state, application-data or security-integrity proof. All **93
offline tests passed**. The three successful fixture roots were removed after
known clean exits; cleanup receipts are present. No final build, runtime or
artifact is qualified.

Base `6724c191bca8d30c8985d50f873a15e8620551c3`, branch
`codex/hostler-writer-boundary`. Builder: actual Codex CLI GPT-6 Astra medium. Actual `claude-opus-5-5` tool-disabled
implementation review accepted the explicit prior 13-file packet for fixture-only
increment 1 source merge, **conditional on C1’s README requirements correction**.
It found no blocking defect in the 11 executable/test/fixture files. The reviewer
used no tools or repository access, did not recompute hashes, and relied on
parent-reported gate results. The retained source-review receipt is
`/tmp/hostler-oct4-next/opus-writer-implementation-review.md`; its scope is the
prior hashes preserved in `writer-source-identities-before-opus-docs.json` in
that directory. C1 is corrected in the README. The pull request retains the final
documentation-delta review and integrating-agent verification. This is source
review only, with no build, runtime or operational approval.

Parent approved the static oracle before DB execution; it remains frozen at
SHA-256 `07d170089696e8275900c0bf30e4860b07392f44cb58c024b59ee8bf51c0250d`.
The parent’s external exact approved-oracle SHA verification is the current
binding. The fixture records the digest but does not internally enforce that
approved digest.

The source adds a direct, new-initdb-owned private PG18 fixture, an internal
installed-Drizzle executor, a separate read-only observer and an independent psql
chain derivation. Only `pg18_writer_fixture_tests.py` has an invocation entrypoint.
Supporting Python and MJS modules are inert on import. No existing directory,
DSN, socket, installation, service or database can be selected through the explicit
gate interface. This is not confinement of arbitrary internal Python API callers:
`OwnedFixture.command` allowlists executables but can accept caller-supplied
arguments. Same-UID/root callers are trusted; this is not a security boundary
against them.
No package acquisition, application startup, maintained SQL repair, runtime/auth
integration or export change is included. The old prestate boundary remains
byte-identical and always refuses writer exclusion with all authority flags false.

## Superseded failures and corrections

These four parent attempts preceded the successful fifth gate. The linked public
primary sources were verified in the parent’s diagnosis notes; they were not
inferred from observed fixture output. Fixed configuration, SQL, journals and the
approved oracle remain unchanged by the corrections.

| Failed attempt | Cause and bounded correction | Public primary source |
| --- | --- | --- |
| First: archive display | PG18 renders `archive_command` as `(disabled)` under `archive_mode = off`. Exact configured bytes (`archive_command = ''`, mode off, empty library) remain required; only this documented display is accepted, with exact source/path/pending-restart checks. | [REL_18_6 xlog.c: show_archive_command](https://raw.githubusercontent.com/postgres/postgres/REL_18_6/src/backend/access/transam/xlog.c), [xlog.h: XLogArchivingActive](https://raw.githubusercontent.com/postgres/postgres/REL_18_6/src/include/access/xlog.h) |
| Second: settings visibility | Nonsuperuser `pg_settings` hides exactly `session_preload_libraries`, `shared_preload_libraries`, and `unix_socket_directories`. The full exact administrator check, empty parameter ACL (checked before nonsuperuser queries), empty DB/role settings, fixed files and membership checks remain. Each role must match the exact 14-visible-field projection; extras, other omissions, nulls or changed values refuse. Visible `local_preload_libraries` must remain empty. No privilege is granted. | [REL_18_6 guc_funcs.c](https://raw.githubusercontent.com/postgres/postgres/REL_18_6/src/backend/utils/misc/guc_funcs.c), [guc_tables.c](https://raw.githubusercontent.com/postgres/postgres/REL_18_6/src/backend/utils/misc/guc_tables.c), [guc.c](https://raw.githubusercontent.com/postgres/postgres/REL_18_6/src/backend/utils/misc/guc.c) |
| Third: control diagnostics | COPY PROGRAM requires `42501`; disabled ALTER SYSTEM requires `0A000` before privilege checks. Each literal statement requires exactly one anchored, well-formed ERROR header with its own SQLSTATE. Wrong/swapped, extra/conflicting or malformed headers and FATAL/PANIC refuse. Auxiliary formatting is irrelevant and cannot supply a code. Both complete captured sanitized outputs remain exact offline test strings, including the WARNING/ERROR spacing difference that required a follow-up parser correction. | [REL_18_6 guc.c: AlterSystemSetConfigFile](https://raw.githubusercontent.com/postgres/postgres/REL_18_6/src/backend/utils/misc/guc.c), [copy.c: DoCopy](https://raw.githubusercontent.com/postgres/postgres/REL_18_6/src/backend/commands/copy.c), [errcodes.txt](https://raw.githubusercontent.com/postgres/postgres/REL_18_6/src/backend/utils/errcodes.txt) |
| Fourth: Darwin child environment | Darwin startup injected exact key `__CF_USER_TEXT_ENCODING`. On Darwin only, the helper deletes that key without reading its value, then strictly requires planned HOME and LC_ALL=C. Other unexpected names and that key on non-Darwin refuse. The same helper is exported inertly by `migrate_owned.mjs`, used before DB-library loading, and exercised by a cheap fixed-Node startup smoke before initdb. No prefix wildcard or ambient defaults are accepted. | Apple’s historical public [CFRuntime.c](https://raw.githubusercontent.com/apple-oss-distributions/CF/main/CFRuntime.c) explains potential startup insertion; it is not host-binary attestation. |

The startup smoke uses a fresh owned `hostler-node-smoke-*` temporary directory,
HOME set to that directory and LC_ALL=C, checks Node major 24, and imports only
the inert helper and Node standard-library modules. `settings.json` retains the
full administrator rows; `session-settings.json` records both exact visible maps,
the three hidden names and zero parameter ACL rows. These receipts confer no
new authority or reentry support.

## Retained evidence

Authoritative sanitized parent summary:
`/tmp/hostler-oct4-next/coordinator-writer-passing-summary.json`.
Retained success evidence directory:
`/private/tmp/hostler-writer-evidence-frypwe5y`.
These are **local scratch evidence pointers**, not portable source attachments.
No raw output is copied here.

The summary records Node **24.21.0**, installed Drizzle **0.45.2** and postgres-js
**3.4.4** execution, 116 loaded CJS modules and 2,704 inventoried files;
`registry_integrity_verified=false`. This was an internal installed-library
invocation, not a shipped dist/migration artifact. Small, maintained Drizzle and
maintained psql roots respectively were `hw-tli5hnqy`, `hw-q_q7fg17` and
`hw-hnnj0dgf` under `/private/tmp`; all are reported absent.
`small-cleanup.json` and `maintained-cleanup.json` report clean exit and removal.

Logs under `/tmp/hostler-oct4-next/` are
`coordinator-writer-pg18-{first,second,third,fourth,fifth}.log`.
The passing summary binds these current receipts:

| Receipt | SHA-256 |
| --- | --- |
| `coordinator-writer-pg18-fifth.log` | `f4320154de6fedc8e4248dbe58e024bc01483e44215624b0e14ec5a76811df7d` |
| `coordinator-writer-offline-93.log` | `bac5b74f956fd6f825805ebf0dab1fd1d5199fb6d071cffb12b673e644381dd4` |

Prior failed roots remain preserved under `/private/tmp`:
first `hw-4zu0znex`, `hw-a9hlt2wb`; second `hw-n7_vc45y`, `hw-tgmcz4ph`;
third `hw-qnvnjpln`, `hw-811j9qvx`, `hw-5yqeoet6`;
fourth `hw-as3zf9bo`, `hw-11g22zxf`, `hw-o17_3b0g`.
Parent confirmed stopped processes and absent pidfiles; fourth-attempt stop
receipt is `writer-fourth-stop-receipt.json` in the same scratch directory.
The four diagnosis notes are `archive-display-diagnosis.md`,
`session-visibility-diagnosis.md`, `negative-control-diagnosis.md` and
`darwin-child-environment-diagnosis.md`. These retained roots are outside this
documentation correction.

The pre-DB checkpoint is `astra-writer-oracle-checkpoint.md` in that directory.
`writer-source-identities-before-opus-docs.json` preserves the exact reviewed
13-file manifest; `writer-source-identities.json` records the updated 13-file
source identities. All 11 nondocumentation entries remain byte-identical.
The correction receipt is `astra-writer-opus-docs-result.md` in that directory;
the pull request records final review and integration of this docs delta.

## Commands and cleanup contract

For reference, the parent’s explicit synthetic gate command from this checkout
requires its exact fixture execution authority; it was not rerun for these docs:

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 community/pg18_writer_fixture_tests.py
```

It runs two methods creating three fresh clusters. The small case requires two
ledger entries, the exact descriptor and rows `(1,seed-upgraded,new,2)` and
`(2,second,ready,1)`. The maintained cases require 196 exact ledger rows each and
equal descriptors. A maintained SQL failure fails the gate, retains SQLSTATE and
statement boundary where available, and still attempts the second-client
derivation. This applies to maintained SQL failure; an arbitrary nonzero executor
exit can raise before the psql attempt. It never patches, retries, drops bootstrap
state or promotes partial success.

Before cleanup, the gate retains provisioning/config/settings, source/oracle/SQL
digests, installed byte identities, results, ledgers and catalogs in its printed
evidence directory. Failed or uncertain fixtures remain. Successful roots are
removed only after the exact owned postmaster and all tracked clients exit
cleanly; absent receipts do not qualify cleanup, and unknown cleanup fails the
gate. Each captured child has a private 0600 `child-*.json` receipt within its
owned 0700 root: argv, input SQL digest or Drizzle/journal purpose, PID, exact exit
(null if unknown), exception/drain classes and stdout/stderr byte counts.
Each stream retains at most 16 KiB head plus 16 KiB tail, with truncation marked.
Timeouts/interruptions attempt kill/reap; unknown exits stay tracked and refuse
cleanup. Raw diagnostics remain private. There is no stale-PID signalling or
recursive cleanup of caller-selected paths.

Offline commands (for reproducibility; no tests were rerun for this docs delta):

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 -m unittest discover -s community -p 'test_*.py' -v
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3 scripts/test-mason-release.py
/opt/homebrew/opt/node@24/bin/node --check community/migrate_owned.mjs
git diff --check
```

## Contracts and evidence limits

**B1 — independent oracle.** `writer_fixture/oracle.json` is authored from SQL
semantics, not learned from a target. Version 1 includes explicit schemas,
relations (kind, persistence, RLS and forced-RLS flags), policies,
columns/types/defaults/nullability, constraints, indexes, ordered
enums, sequence definitions/owned-column links, functions, triggers, extensions,
owners, explicit ACLs and default ACLs. Empty sections are asserted. OIDs and
sequence current values are absent. Catalog SQL deparses with `pg_catalog` search
path. Rows are sorted by compact canonical JSON; native scalar types are checked.
Not-null constraints use column metadata; indexes have definitions and their
PostgreSQL-enforced table ownership is represented by the owning relation.
System namespaces are excluded from application sections; extensions are global.
Policies enumerate every non-system relation policy by schema/relation/name,
command, permissive flag, sorted role names (OID zero means PUBLIC), USING and
WITH CHECK expressions, including nullable expressions. The small oracle asserts
no policies and permanent relations with both RLS flags false, including the
serial sequence's static catalog flags. Owners include function overload identity;
explicit ACLs include standalone types and functions. The enum's NULL ACL yields
no explicit rows. These are static semantic assertions, never observed-output
expectations. This bounded descriptor and the hand-authored rows do not establish
complete database or security-state integrity.
Full-chain comparison covers that descriptor and ledger, **not application row
semantics**. Its rows section is unused. There is no independent maintained
application-state oracle: label the result differential equivalence only.
Descriptor gaps include view definitions, generated/identity column flags,
collations, trigger enabled state, domain base types and rules. Maintained-case
owners, grants and default grants reflect fixture roles, not deployment state.
`psql_chain` constructs ledger rows from the expected manifest itself and shares
the `--> statement-breakpoint` split with the Drizzle path. The installed Drizzle
library produces its own ledger; the psql ledger and shared split impose
common-mode limits on this bounded differential.

**B2 — bootstrap.** Installed 0.45.2 dialect source separately awaits schema and
serial-table creation before one transaction containing pending SQL and ledger
inserts. Schema/table are explicitly pinned to `drizzle.__drizzle_migrations`;
`public.migrations` refuses. `none`, `schema-only`, and schema plus empty table,
sequence and PK index are distinct synthetic states, checked against the static
bootstrap subset of the oracle. `ledger()` sorts by `created_at`: validation
checks the correct row set, every hash and strict timestamp prefix, not insertion
order. It intentionally never reads/requires contiguous IDs.
The fresh dispatcher accepts only `none`. Bootstrap failures are retained, never
repaired/retried. This classifier does not modify existing prestate classification.

**B3/B4 — trusted fixture scope.** Provisioning records bind the actual successful
initdb argv, root/device/inode, owned subdirectories, spawned-process parent,
system identifier, postmaster start time and fixed config hashes. An in-memory
registry proves creation in this invocation; no public record loader accepts a
caller claim. Actual owned process handles control shutdown. Same UID/root,
executables and storage are trusted. Peer mapping is not hostile-same-UID
exclusion. There is no service inhibition, monotonic rollback detection,
power-loss qualification or installation authority. Increment 1 has **no reentry**:
uncertainty retains the fixture. Later reentry must fence through a corroborated
server stop and a new epoch socket before observing; control-pipe EOF alone is
only cooperative defense and is not a late-commit fence.

**B5 — fixed gate.** `maintenance_fixture.py` contains the literal revised-plan
settings, exact HBA and three fixed peer mappings. No TCP; one private short
Unix socket; default `max_connections`/`max_locks_per_transaction` are checked
against `boot_val` and recorded without capacity reduction. Fixed config/HBA/
ident/empty auto.conf bytes, `pg_file_settings`, `pg_settings` values/sources/
sourcefile/pending restart, both role sessions under the exact visibility
projection above, empty `pg_db_role_setting` and empty `pg_parameter_acl` are checked. The executor is nonsuperuser DB owner; the observer has only default
SELECT on created tables and USAGE on created schemas, with no role membership.
The administrator connects only to the fixed control DB. Role/owner/settings
and privilege-denied controls, HBA rejection, and owned-postmaster no-TCP lsof
inspection passed in the parent’s fifth gate; this builder ran no DB actions.

**B6 — exact execution subject.** This exercises installed Drizzle **0.45.2**,
postgres-js **3.4.4** and the selected journal, **not `dist/migration.mjs`**.
The parent independently compared the pinned maintained client: `run-migrations.ts` SHA-256
`943a8f21f2f79c05597b1672f1e434292fcc0e0b765935e7fefa9d81734f731c`,
local receipt `/tmp/hostler-oct4-next/writer-maintained-client-comparison.json`.
Maintained execution uses `postgres(dbUrl, {max: 1})`, `drizzle(sql)`,
`migrate({migrationsFolder})` and `sql.end()`. The fixture retains `max: 1`,
default `prepare` and the actual default schema/table
`drizzle.__drizzle_migrations`, but uses its owned endpoint/user (fixture socket,
port 5432, `hostler_fixture`, `hostler_migrator`), `connect_timeout: 3`,
no-op `onnotice`, a query-boundary logger and end timeout 5 seconds.
The exact maintained entrypoint was **not invoked**. The initial implementation
review did not include `run-migrations.ts`; the documentation-delta packet includes
its exact pinned source and the parent comparison.
The caller supplies only HOME and LC_ALL. After the exact Darwin-only startup
normalization above, the child requires precisely those planned inputs and no
ambient NODE_OPTIONS, PG*, USER or DATABASE_URL.
The inherited socket hands off only fixture-created provisioning and snapshots.
`createRequire` is anchored at the existing primary checkout's
`/Users/masonjames/Projects/dokploy/apps/dokploy/package.json`, after exact worktree/
primary package and lockfile agreement. The different dependency location is
explicit. Node version/realpath, library realpaths/versions, all package byte
hashes before dispatch, executed CJS hashes and lock integrity expectations are
recorded. Actual dependency inventories and executed cache hashes evidence only
this internal installed-library invocation, not a final dist or migration artifact.
These hashes **do not prove registry integrity**. No library bytes are
copied into the source tree or installed.

The journal selects exactly 196 files; all 197 SQL files are snapshotted/hashed.
`writer_fixture/maintained-source.json` pins the reviewed source bytes, including
journal-unselected `0130_abandoned_dagger.sql`; the gate records its hash and the
selected same-index counterpart `0130_perpetual_screwball.sql`. Source-read hash
verification confirms that `0130_abandoned_dagger.sql` and selected
`0158_amused_synch.sql` have **exactly the same bytes**, SHA-256
`1c942d12065d7acb6a59573548124dadd09de15847c7ed8165b51b13925f358b`.
Only the 0130 path is unselected: its content is executed at 0158. Both clients
consume snapshot bytes. No glob execution.

**B7 — deferred faults.** Increment 2 must supply deterministic transaction-lock,
real protocol lost-COMMIT-ack, and post-commit/pre-record hard-kill tests, with
server-fenced reentry. No fake callback or environment fault switch claims these
are covered here. Increment 3 still owns normal-to-maintenance/reconnect and
synthetic upgrade-prefix qualification. The small two-file case tests upgrade
SQL/data semantics inside a fresh all-pending transaction, not an existing-state
upgrade. Fresh success cannot qualify maintained upgrade boundaries.

**B8 — nonauthority.** New result structures have no migration/runtime/exclusion
authority fields. A successful synthetic gate grants no installation, runtime,
publication or production authority. Review, source, build, installation,
runtime and natural soak remain distinct. October 9 still needs the separate
agent tree's auth/export/build and contents/naming/rights evidence; this packet
does not turn the current NONBUILDABLE inspection export into an artifact.

Server-fenced crash/reentry testing remains a deferred increment, not implemented
here. The parent’s passing gates and conditional source-review acceptance do not
supply separate build, installation, runtime or natural-soak evidence.
