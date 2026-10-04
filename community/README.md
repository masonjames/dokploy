# NONBUILDABLE / nonrunnable community source foundation

Pinned maintained base: `b2c1a6b2016edae023f0cb2a19afdbda355e6d52`.
This is source inspection tooling and a pure supplied-state refusal policy.
It grants no build, migration, runtime, publication or production authority.
Separate source closure, compiler/build/content evidence and runtime qualification
remain mandatory. Existing restricted imports intentionally remain unresolved.
No maintained entrypoint, schema or data is changed.

`state_policy.py` is **only initial-install supplied-state classification**. It
refuses every existing database, including imported databases, and must never be
wired as a universal startup guard: that would refuse the first restart after a
successful install. Later compatible restart/upgrade admission needs its own bound
community-install identity plus schema/state policy and crash, restart and
partial-migration tests. An installation marker alone never grants authority.
There is no production connector or runtime admission here; the classifier's
refusal behavior is unchanged. The separate [preparatory observation packet](observation-packet.md)
adds fixed PostgreSQL catalog SQL, an injected query interface, a synthetic driver
and an always-refusing community entry. It is not included in the pinned export
and supplies no viable-build evidence.

`restricted-inventory.json` records the exact 29 restricted paths and identities,
reconciled with the retained checksum inventory and import probe. SHA-256 values
come from that evidence; Git blob identities come from the pinned tree. The exporter
checks the exact path/blob set without reading proprietary bodies. It does not
rehash those bodies or claim the retained SHA-256 evidence is independently renewed.

`export-contract.json` binds the full committed input tree, base, inventory bytes,
ordered overlay list and the exact pinned fixture omission. Hashes use SHA-256; overlay identity is the UTF-8 encoding
of Python `json.dumps(value, sort_keys=True, indent=2)` followed by one newline.
Version 1 accepts **only `[]`**. Every nonempty overlay, replacement, patch or extra
input is refused, even with a matching hash. This deliberately narrow contract
prevents introducing restricted paths or content through patches; patch application
requires a separately reviewed version. An edited contract is a new review input,
not a new authorization. Preserve the reviewed file hashes outside the checkout.

The exporter reads exact blobs at an explicit full commit ID and requires source
HEAD to match. After this tooling eventually merges, use the reviewed tool from
that revision against a **separate source checkout whose HEAD is still this pinned
maintained base**; the merged tooling checkout will have a different HEAD. Dirty tracked files, staged changes, deletions, ignored files and
untracked files are ignored through the committed snapshot; no recursive working
copy reads occur. The tree identity binds every tracked path/mode/blob. Restricted
inventory drift and renamed exact excluded blobs refuse. This is not a general
plagiarism, partial-copy, secret or dependency-license scanner.

Paths use a restricted ASCII relative form for this POSIX inspection export;
Windows device-name portability is not qualified. Every tree entry is checked before
output: all symlinks and gitlinks refuse, including in excluded directories, except
one required, identity-pinned omission: `apps/dokploy/__test__/drop/zips/payload/link`,
mode `120000`, kind `blob`, Git blob `3594e94c04db171e2767224db355f514b13715c5`.
This tracked test fixture is never read, followed or materialized. Its path, mode,
kind, blob and reason are pinned in code and the reviewed contract and recorded in
every receipt. Missing or changed identity refuses; this is not general symlink
support. Its blob also cannot be reused as an allowed regular input. Case
collisions and path escapes refuse. Exclusions cover every `proprietary` component,
Git/agent metadata, dependencies, `dist`, `.next`, `.worktrees`, `community`, and
`.env*` components. Nested repositories represented as gitlinks refuse. Paths that
remain can still contain unresolved restricted imports; absence is not source closure.

A fresh destination outside all checkouts is required, with an existing parent
and no symlink ancestors or traversal. Use canonical filesystem paths (macOS
`/private/tmp`, rather than the `/tmp` symlink). Validation and all blob reads
precede destination creation. Use a private, caller-controlled destination parent;
concurrent adversarial filesystem changes are outside this local tool's contract.
A write failure can leave a partial directory (even before the notice is written);
discard it and choose a fresh destination. There is no overwrite/resume behavior.

The output has `NONBUILDABLE.txt`, a deterministic `receipt.json`, and exact allowed
blobs under `source/`. File hashes, original Git modes, exclusions and contract
identities are in the receipt. Source files are written with mode 0644, without
executable bits; original contents, including package scripts, are unchanged.
No archive, executable entrypoint or runtime integration is produced. Determinism
covers bytes, relative names and source file modes, not filesystem timestamps.
The receipt's self-reported `exporter_sha256` identifies `export_source.py` bytes alongside
the base, tree, contract and inventory identities; it contains no local tool path.

License/attribution texts outside excluded paths are retained as exact tracked
blobs, including the upstream license split and DSAL notice. They are not rewritten
or relabeled. Copyright remains with its stated holders; third-party terms still
apply. This inventory is not legal or dependency license clearance.

Source-only verification requires Python 3.9+ and existing Git; no dependencies.
API/grammar audit only: `Path.is_relative_to` requires 3.9; the other used standard-library APIs
and syntax are available by 3.9. Tests were run with **Python 3.14.8**. This API
inspection is not a tested interpreter-version matrix; no interpreters were installed.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s community -p 'test_*.py' -v
```

Tests create and commit only synthetic temporary Git fixtures. They exercise valid
and deterministic exports, dirty/staged/untracked/ignored exclusion, source and
identity drift, excluded-content reintroduction, unsafe paths, symlinks/gitlinks,
patch refusal and unknown/incompatible supplied state. No real source export,
application execution, database access or graph investigation is part of this gate.
The exporter CLI takes source, fresh destination and required `--base`; it uses the
adjacent reviewed contract/inventory. No release, build, install or deploy command
is provided.

The authorized local pinned-base export is source-only evidence, not a distribution
artifact. It omits 36 paths: 29 restricted paths, the pinned test fixture, and these
six agent-configuration/environment-template paths:

- `.claude/settings.json`
- `.claude/skills/fix-issue/SKILL.md`
- `.claude/skills/frontend-design/SKILL.md`
- `apps/api/.env.example`
- `apps/dokploy/.env.example`
- `apps/dokploy/.env.production.example`

It retains root notices and license texts (including DSAL license text), and copies no inventoried
DSAL implementation blob as an allowed input. License-text retention does not permit
DSAL implementation copying. All output remains **NONBUILDABLE / nonrunnable**:
unresolved restricted imports and the empty-overlay limitation remain, with no
source-closure, compiled-content or runtime proof. Do not use this inspection export
as a build or runtime candidate. A subsequent reviewed source slice must establish
closure and required build inputs, including a synthetic build environment.

Verify the exporter hash independently against reviewed tooling. The exporter
trusts the local Git object store; the coordinator additionally recomputed each
output's Git blob ID and SHA-256 against the pinned tree. That source check is
not loaded-code attestation or qualification of a later build.
