# NONBUILDABLE / nonrunnable — preparatory state observation seam

Platform-infra #788, October 4, 2026 (America/New_York). Builder: this actual
Codex CLI GPT-6 Astra medium invocation. Accountable: Mason. Coordinator owns
integration and independent reruns. The source PR retains revision-bound
tool-disabled Opus 5.5 review and coordinator verification receipts.
Base HEAD and locally recorded `origin/mj/prod-caddy` both:
`8c1111253a76b321895dcf13124d42dfe5d862f7`. Coordinator supplied the October 4 live
priority refresh; no network refresh was performed by this builder.

Only `community/` source/tests/docs are owned by this slice. No package script is
needed. The pinned export remains at `b2c1a6b2016edae023f0cb2a19afdbda355e6d52`,
with empty overlays, unchanged exporter and unchanged supplied-state classifier.
This new module is not part of that export. Incorporation requires a later exact
reviewed export revision; these preparatory files do not make any build viable.

## Launch map and separation

Inspected before edits, without importing application modules:

| Maintained entry or dependency | Ordering / effect |
| --- | --- |
| `apps/dokploy/package.json` `start` | `node -r dotenv/config dist/migration.mjs && node -r dotenv/config dist/server.mjs`; migration is first. |
| `apps/dokploy/migration.ts` → `server/db/run-migrations.ts` | Creates PostgreSQL client, invokes Drizzle migrator, closes client; failure exits 1. |
| `apps/dokploy/server/server.ts` imports | Loads the server barrel and WebSocket handlers before its body; not an inert boundary. |
| `packages/server/src/index.ts`, `src/db/index.ts`; app DB index | Barrel reaches auth/services/setup; DB module constructs/caches client and Drizzle objects at evaluation. |
| Server body | dotenv, production directory/config initialization, Next creation/preparation, HTTP and WebSocket setup, listener. Then Caddy sync, middleware/network initialization, cron/schedules/backups/notifications, enterprise backup jobs and deployment worker. |
| `apps/dokploy/server/queues/queueSetup.ts` | Queue creation/cache happens at module evaluation; worker starts after server listening. |
| Separate `community/observe_entry.py` | Imports only stdlib, observation and pure policy. `run(session, target, purpose)` observes, cleans up, always returns exit 1 and false authority flags. CLI has no connector and refuses unconfigured. No maintained launch dispatch exists. |

A guard inside `server.ts` would be too late. This slice does **not** claim to guard
the maintained full build. Its separate community entry cannot reach migration,
configuration writes, initialization, Next/HTTP, WebSockets, Caddy or workers.
No subprocess, application import, callback for startup or runtime handoff is
provided. Import-time filesystem bytecode caching can be disabled with the test
commands below; imports themselves initiate no application work.

## Observation and trust contract

`state_observation.py` defines an injected `QuerySession` interface, executable
fixed PostgreSQL SQL, strict result validation and unconditional rollback/close.
There is no PostgreSQL package, connection factory, credential/environment reader,
DSN option, or real database execution in this packet. `SyntheticSession` exists
only in tests and is a protocol driver, **not a SQL engine**.

The trusted caller must independently bind `Target.installation_id` to cluster
system identifier, database OID/name/owner, observer role and numeric server
address/port using its reviewed provisioning inventory. Do not construct this
binding from the observation being checked, an arbitrary claimant, a database
marker, `complete`, or an unverified DSN. The installation ID is an external
association: an empty database contains no application identity to authenticate.
The inventory address must use PostgreSQL `host(inet_server_addr())` canonical
text (IPv4 or IPv6, without a mask); peer authentication remains separate.
SQL compares the associated database identity; it cannot authenticate that
external association. A future connector must authenticate the intended server
and use a fresh exclusively owned idle session. Clones can share system IDs and
names/OIDs; endpoint numbers alone are not cryptographic peer authentication.
Unix sockets (NULL address/port), transaction-pooling/rebinding, unknown identity,
missing trusted inventory or unverified peer are not qualified by this contract.
No marker creates trust and no operational identity was established here.

The fixed sequence is `BEGIN ... REPEATABLE READ READ ONLY`, transaction-local
`search_path = pg_catalog`, one fully fetched `SELECT`, `ROLLBACK`, close/discard.
The SELECT includes identity, transaction mode, search path and snapshot, catalog
permissions, public-schema presence/access and object counts together. Catalog row
counts use the transaction snapshot; identity/privilege functions and prepared
transaction metadata may use system caches or shared state outside that snapshot.
This does not establish one atomic prestate for future admission. No application
table/row/view/function is evaluated, and no schema name or target string is interpolated. Commands require an empty result; the
observation requires exactly one tuple and the exact ordered column list with
native bool/int/text values. Missing/extra/duplicate columns, absent/extra rows,
NULLs, coercions, negative/bool counts, bad transaction modes and malformed
snapshots refuse. Driver fetch/transport/permission errors must raise; truncation
must never become an empty tuple. Error messages are not echoed.

The SQL reads `pg_catalog` directly, **not** privilege-filtered
`information_schema.tables`, search-path visibility, row counts or estimates.
It checks full-table SELECT and non-RLS status for every queried catalog, CONNECT
and schema USAGE. Revoked access or incomplete catalog access refuses. Calling
`pg_control_system()` also requires permission; denial refuses. Some catalogs
(notably `pg_subscription`) have restricted access: a normal application role can
therefore always refuse on stock grants even on an empty database. This slice grants no privileges and
must not be used as a reason to grant an application role superuser. A later
connector/permission design and supported PostgreSQL version must be reviewed.

Any relation kind anywhere outside built-in namespaces refuses, including hidden
or RLS-protected tables, empty tables, sequences, indexes, views, foreign tables,
partitions and migration journals. Extra schemas (including temporary schemas),
user types/enums, routines, extensions other than stock `plpgsql`, large objects,
event triggers, foreign servers, publications or subscriptions also refuse. Default ACL entries, database-specific
or cluster-wide role settings, and prepared transactions for the target DB refuse.
Those counts do not expose ACL/config values or prepared transaction identifiers.
The fixed PostgreSQL normal-object OID boundary (16384) additionally detects
user-created relations/types/routines placed inside built-in namespaces. Built-in
namespaces are exact names, never a permissive `pg_%` filter. The contract assumes
an authentic, untampered PostgreSQL catalog/stock built-ins and a faithful driver;
it cannot prove absence against a malicious server, forged driver response or
catalog administrator. A non-stock template may conservatively refuse. Shared
subscription metadata and cluster-wide role settings can also conservatively
refuse because of another DB/role. This is not an exhaustive inventory of all
PostgreSQL state: public-schema/database ownership and ACLs, casts/operators,
operator classes, collations/conversions, text-search objects, languages/access
methods/transforms, foreign-data wrappers without servers, security labels and
logical replication slots remain unqualified. Completing the relevant catalog and
permission inventory is an explicit connector/admission prerequisite; a candidate
means only that the enumerated application structures were absent.

All protected nonrestricted schemas inspected remain unchanged: `account.ts`
includes organization/default role, custom-role definitions, member scopes and
invitation roles; `sso.ts`, `scim.ts`, `forward-auth.ts`, `domain.ts`,
`web-server-settings.ts`, `server.ts`, `git-provider.ts` and `user.ts` retain their
state. Existing tables refuse without interpreting roles, permission JSON or
license state. Thus there is no compatibility claim, permissive license shim,
SSO downgrade, protected-domain regeneration or provider/server-scope widening.
No proprietary implementation body was read or copied.

Only structurally absent application state allows deriving the foundation's zero
counts. Any existing or partially migrated state returns refusal without inventing
per-feature counts. Even a marker-only database refuses. Explicit restart/upgrade
purposes refuse before observation. An emptied/reset database cannot reveal its
history; the candidate is a point-in-time classification, not proof of first use.
Uncommitted work already in progress can be invisible, and concurrent writers can
change state after the snapshot. The prepared-transaction count is an observation,
not exclusion of a new prepared transaction. Repeatable read is not a
startup lease or exclusion lock. No candidate is reusable migration authority.

Cleanup is attempted after all outcomes, including failed BEGIN and cancellation.
Rollback failure still attempts close; close failure also refuses. Ordinary query
errors return sanitized unknown refusal; cleanup errors override any candidate.
Cancellation propagates only after cleanup attempts. A failed physical close cannot
be proven successful by this interface: discard that handle and investigate; no
retry or pool reuse is implemented. Restart/upgrade and real startup remain
inadmissible on **all** paths.

## Synthetic evidence and limits

Commands (no installation, network, database or application runtime):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s community -p 'test_observation.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s community -p 'test_foundation.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-mason-release.py
PYTHONDONTWRITEBYTECODE=1 python3 community/observe_entry.py
git diff --check
```

The foundation tests create/commit only synthetic temporary Git fixtures; the
release test reads source contracts and migration snapshots, performs assertions
and prints a result. Both were inspected before execution. The separate entry
must print `REFUSE_UNCONFIGURED` and exit **1**, never a success/startup signal.

Tests cover positive empty observation, each identity component, absent binding,
permission/query failures, result shape/type attacks, partial schema/migration and
a nonzero relation-count refusal, marker/restart/upgrade refusal, snapshot/mode checks,
rollback/close failures and cancellation. They instrument process launch, sockets,
selected filesystem writes and thread start, exercise empty and refusal paths, and restrict
the source dependency closure to inert modules. These are Python seam checks;
no TypeScript runtime was imported, and they do not qualify a production guard.
The former table-name-labelled subtests were collapsed to one count test: they
did not execute those tables or PostgreSQL hidden-row semantics. Tripwires are
selected instrumentation, not a host sandbox; import closure is checked separately.

Failure/recovery evidence: the first focused run failed because an import-reload
instrumentation test replaced a dataclass type while a test helper retained its
old default instance. The import check now executes source in an isolated namespace,
leaving the shared module's types intact. Production type validation was retained.
Synthetic query failure → closed session → fresh partial-state refusal → fresh
empty candidate is covered; every stage still exits 1. No database repair occurred.

Builder results: focused observation gate **15/15 passed**; existing
foundation gate **23/23 passed**; `scripts/test-mason-release.py` printed
`Mason Dokploy immutable release contracts passed` (exit 0); standalone entry
printed `REFUSE_UNCONFIGURED`, NONBUILDABLE status and both false authority flags
(exit 1, expected); `git diff --check` passed. New files were also checked with
`git diff --no-index --check /dev/null <path>` because ordinary diff excludes
untracked additions. SQL semantics and permissions have **not** been exercised on PostgreSQL. No compiler, bundle,
container, auth HTTP/tRPC/UI, installation or viable artifact evidence is claimed.

Coordinator integration checks: strict native column names, empty command-result
tuples and initial-purpose types were tightened after adversarial equality-object
probes. The added regression and full discovery gate pass **39 tests** (16 observation,
23 foundation); release contracts pass. A separate coordinator probe varied every
observation field across five malformed values (125 cases), plus four invalid
snapshot shapes; no malformed candidate or runtime authorization remains in those
cases. These are independent synthetic checks, not PostgreSQL execution.

PostgreSQL semantics were checked against the primary documentation for
[transaction modes](https://www.postgresql.org/docs/18/sql-set-transaction.html),
[catalog relations](https://www.postgresql.org/docs/18/catalog-pg-class.html), and
[identity/snapshot functions](https://www.postgresql.org/docs/18/functions-info.html).
The review repairs also reference [address formatting](https://www.postgresql.org/docs/18/functions-net.html),
[default privileges](https://www.postgresql.org/docs/18/catalog-pg-default-acl.html),
[database/role settings](https://www.postgresql.org/docs/18/catalog-pg-db-role-setting.html)
and [prepared transactions](https://www.postgresql.org/docs/18/view-pg-prepared-xacts.html).
That source comparison does not replace the pending SQL execution tests.


Independent Opus 5.5 review identified the address text-cast mismatch before merge.
The coordinator used PostgreSQL's `host()` representation, qualified built-in casts
and aggregates, verified the returned search path, and replaced the deprecated
snapshot function. It also added default-ACL, database/role-setting and prepared-
transaction refusal counts. The synthetic driver's violation flag now makes an
unexpected/duplicate query fail the test even when observation catches its error.
After these repairs, the full gate passes **40 tests** (17 observation, 23 foundation),
release contracts pass, and the separate probe refuses 145 malformed-field cases
plus four invalid snapshots. SQL semantics remain unexecuted. The PR binds the
initial and corrective-delta review packets to their exact file identities.

## Ready next packet / unresolved gates

Source acceptance requires coordinator review and gate reruns plus independent
tool-disabled Opus 5.5 review of the exact packet. Retain actual revision/hash
coverage on the source PR. The builder did not commit, push or open a PR
(foundation fixtures create only temporary synthetic commits).

The next source prerequisite is a reviewed authenticating observation connector
and external installation-binding contract, with supported PostgreSQL version,
least-privilege catalog visibility, real disposable synthetic-DB semantic tests,
and bounded timeout/cancellation/physical-close behavior. No PostgreSQL execution
is included in this slice; no connection command is supplied here. Any package
acquisition or infrastructure operation retains its applicable approval boundary.
Then define distinct initial-migration and compatible restart/upgrade admission
with bound state/schema identity, writer exclusion/reobservation, marker semantics
and crash/recovery tests **before any runtime handoff**. A marker alone is insufficient.
Keep the explicit community launch separate and the maintained full build intact.

Auth/permission/API/UI import closure, bundler/emitted-content and rights/naming
proof, a new exact export contract, viable build and installation qualification
remain later gates. October 8 preparation and October 9 viable-route decision
remain at risk; this observation slice does not close #788 or October 23 clean
installation qualification.
