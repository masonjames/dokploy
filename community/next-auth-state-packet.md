# NONBUILDABLE / nonrunnable — next auth/state-refusal packet

Base: `b2c1a6b2016edae023f0cb2a19afdbda355e6d52`. Source-only proposal for the
next bounded implementation. No live inventory or runtime admission has occurred.

Exact seam from retained source evidence: `apps/dokploy/package.json` runs migration
before `server.mjs`; `apps/dokploy/server/server.ts` performs initialization before
Next preparation, opens the listener, then launches background jobs. A future
bootstrap guard must run **before migration**, initialization/configuration writes,
Next/network/listeners, WebSockets, Caddy synchronization and workers. A guard only
inside the existing server entrypoint is too late for migration. Its imports must
also have no initialization or network effects. Unknown/query-error refusal must
exit unsuccessfully before any of those effects.

`state_policy.py` is independently authored and pure. It accepts a supplied map,
never queries a database and cannot admit migration/startup. Counts must be explicit
nonnegative integers, not booleans, strings or omitted values. `complete` must be
true. The next adapter must establish completeness from a consistent read-only
observation of the intended database; a caller's assertion here is not proof.

This classifier is **only initial-install supplied-state classification**. It must
never be wired as a universal startup guard: it refuses every existing database,
so it would refuse the first restart after a successful install. Imported/existing
database refusal remains unchanged. Later compatible restart/upgrade admission
needs its own bound community-install identity plus schema/state policy and crash,
restart and partial-migration tests. An installation marker alone never grants
authority. No runtime adapter or classifier behavior change is included here.

- A new empty database needs independently established identity and absence of
  application tables and rows, plus known zero incompatible features. Only that
  complete supplied state is `NEW_EMPTY_CANDIDATE`; authority flags remain false.
- Missing, unknown, partial, query-failed or malformed observations refuse. Absence
  of schema is not automatically empty: wrong database, access denial or interrupted
  migration must not be converted to zeros. Existing empty schemas are existing state.
- Custom roles, incompatible membership/default/invitation roles, enforced SSO,
  provisioned SSO/SCIM and protected forward-auth state refuse individually. Protected
  forward-auth includes configured servers/middleware and enabled domain protection;
  never regenerate protected domains as unprotected.
- Existing databases refuse even when all supplied unsupported-feature counts are
  zero. Fresh-install-only is the initial policy. Claimed new databases with any
  application table or row refuse as partial/nonempty. No records, assignments,
  tokens, roles, schemas or migrations may be deleted, reset or downgraded.

The adapter must determine built-in versus incompatible roles from reviewed semantics,
including invitation/default/member paths, and detect unsupported persisted records
rather than relying on license availability. Keep schemas for account, SSO, SCIM,
forward-auth, domain and web-server-settings intact. Preserve enforced-SSO denial.
Saved server/provider scopes must not widen on license absence; provider listing/use,
editing and secret access have distinct rules. Existing-state scope compatibility
requires its own evidence and is not granted by this classifier.

Next gate: implement and review the pre-migration bootstrap plus complete read-only
state collection in a separately authorized source slice; prove refusal before every
side effect with synthetic instrumentation. Then close auth HTTP, tRPC/OpenAPI,
permission and UI consumers, including unsupported operation refusal and license-cron
removal. Compiler, bundler/emitted-content, native auth/resource-scope regressions and
runtime qualification remain separate gates. This Python policy is a reference for
that seam, not a duplicate production adapter or proof of runtime admission.
