# Host build capacity admission

Dokploy can require a host-scoped capacity gate before any deployment phase
that clones source, invokes Nixpacks/BuildKit/buildpacks, runs Compose with
builds or `up`, or pulls a new local image. The gate is opt-in so upstream and
development installations do not silently acquire a Mason-specific policy.
Once `DOKPLOY_BUILD_ADMISSION_MODE=required` is set, missing configuration,
missing tools, lock loss, checksum drift, namespace ambiguity, measurement
failure, or a denied gate fails the deployment before the build callback.

The lock holder runs independently from the build commands. This is necessary
for Compose, where Dokploy clones the source, reads and transforms the Compose
file in the server process, and then invokes Docker in a second shell. One
`flock` remains held across both shells and the private temporary-directory
cleanup. A retry creates a new lock holder and executes a fresh gate; it never
reuses earlier capacity evidence.

Command payloads are never embedded in the outer `/bin/sh -c` or Python argv.
Dokploy stages each payload locally through a mode-`0600` exclusive file write,
or remotely over SSH channel stdin, beneath a unique mode-`0700` temporary
directory. The fixed wrapper opens the file without following symlinks,
validates type, owner, and mode, then executes only its file descriptor in
required mode. Private file transport remains active when admission mode is
`disabled`, protected by its unique mode-`0700` directory; disabled means no
capacity gate or host lock, not a return to payload-bearing argv.

## Required runtime configuration

The production Dokploy service needs these environment variables:

```text
DOKPLOY_BUILD_ADMISSION_MODE=required
DOKPLOY_BUILD_CAPACITY_GATE_PATH=/usr/local/bin/dokploy-host-capacity-gate
DOKPLOY_BUILD_CAPACITY_GATE_SHA256=<sha256 of the adapter in the candidate image>
DOKPLOY_BUILD_LOCK_PATH=/etc/dokploy/build-admission/build.lock
DOKPLOY_BUILD_TEMP_ROOT=/etc/dokploy/build-admission/tmp
DOKPLOY_BUILD_LOCK_WAIT_SECONDS=1800
DOKPLOY_BUILD_HOST_ROOT_MOUNT=/run/dokploy-host-root
DOKPLOY_PLATFORM_CAPACITY_GATE_PATH=/etc/dokploy/build-admission/platform-infra/ops/scripts/dokploy-build-capacity-gate.sh
DOKPLOY_PLATFORM_CAPACITY_GATE_SHA256=<sha256 of the reviewed platform gate>
DOKPLOY_PLATFORM_CAPACITY_POLICY_PATH=/etc/dokploy/build-admission/platform-infra/apps/monitoring/generated/platform-capacity-policy.json
DOKPLOY_PLATFORM_CAPACITY_POLICY_SHA256=<sha256 of the reviewed rendered policy>
DOKPLOY_BUILD_DF_ADAPTER_PATH=/usr/local/libexec/dokploy-build-admission/df
DOKPLOY_BUILD_DF_ADAPTER_SHA256=<sha256 of the df adapter in the candidate image>
```

Create the persistent lock and temporary directories as root with mode `0700`.
Install the platform gate and rendered policy at the paths above while
preserving their repository-relative layout. The adapter checks both SHA-256
digests and also verifies that the supplied policy is the exact file the
platform gate resolves relative to itself.

The adapter and its `df` shim are included in the Dokploy image at:

```text
/usr/local/bin/dokploy-host-capacity-gate
/usr/local/libexec/dokploy-build-admission/df
```

The candidate image build also runs
`verify-builder-env-transport`. It checks the installed Nixpacks and Railpack
value-less environment semantics and verifies that the installed `pack`
supports value-less `--env KEY` arguments backed by the current environment.

The final image includes `python3` for the platform policy parser,
`util-linux` for `flock`, `findmnt`, and `mountpoint`, and `procps` for the
absolute `/bin/kill` process-group control used on lock loss.

## Container mount-namespace requirement

The Docker API reports the host's `DockerRootDir`, but that absolute path is
not automatically visible inside the Dokploy container. Checking container
`/` would measure the overlay filesystem and is not valid host evidence.

For the local Dokploy host, bind-mount host `/` recursively and read-only at
`/run/dokploy-host-root`. When the Docker data root is on a distinct host
filesystem, mount that filesystem root explicitly at its matching path beneath
the host-root target too. The production service requires both of these binds:

```text
host / -> container /run/dokploy-host-root (recursive, read-only)
host /mnt/HC_Volume_104087657 -> container /run/dokploy-host-root/mnt/HC_Volume_104087657 (read-only)
```

A plain read-only root bind can leave nested mounts writable on some
engine/kernel combinations. The explicit second bind is therefore required
for `DockerRootDir=/mnt/HC_Volume_104087657/docker`; do not mount either source
writable. The adapter refuses container mode when either view is writable,
does not expose filesystem root, or does not contain the Docker API's exact
absolute `DockerRootDir`.

Before enabling required mode, compare these read-only results:

```bash
# Host
docker info --format '{{.DockerRootDir}}'
df -Pk / "$(docker info --format '{{.DockerRootDir}}')"

# Candidate container (both must report ro and FSROOT=/)
findmnt --first-only --direction backward -n -o OPTIONS,FSROOT \
  -T /run/dokploy-host-root
findmnt --first-only --direction backward -n -o OPTIONS,FSROOT \
  -T "/run/dokploy-host-root$(docker info --format '{{.DockerRootDir}}')"
df -Pk /run/dokploy-host-root \
  "/run/dokploy-host-root$(docker info --format '{{.DockerRootDir}}')"
```

The host and container-view byte and percentage evidence must agree. The
adapter then invokes the exact platform gate with only `df` path translation;
the platform policy remains authoritative for warning, critical, and reserve
values. Success requires exactly one of each marker:

```text
DOKPLOY_BUILD_ADMISSION=allowed
DOKPLOY_BUILD_GATE_NAMESPACE=host
```

An executable that exits zero without both markers is denied.

Required local mode rejects `DOKPLOY_DOCKER_HOST`, `DOKPLOY_DOCKER_PORT`,
`DOCKER_HOST`, and `DOCKER_CONTEXT`. Those variables can make the Docker CLI
and Dockerode address different daemons, which would let the gate attest one
host while the mutation reaches another. Remote Dokploy targets use their
explicit server record and SSH transport instead.

## Remote build servers

Required mode applies to SSH build servers too. The remote lock holder runs on
the remote host, uses `/` directly as the host view, and holds the remote
`flock` while Dokploy performs every clone/build shell for that deployment.
Before enabling required mode, inventory every Application `serverId` and
`buildServerId`, every Compose `serverId`, every database and monitoring
`serverId`, every Traefik and rollback target, and the local Dokploy
self-update host. For Swarm stacks, inventory every worker that can receive a
task; admission on the manager does not turn an asynchronous worker pull into
a manager-owned command.

Each referenced remote host must have, at the same configured paths:

- the SHA-pinned capacity adapter and `df` shim;
- the reviewed platform gate and rendered policy tree;
- `awk`, `bash`, `cat`, `flock`, `python3`, `rm`, `sleep`, `/bin/kill`,
  `sha256sum` (or `shasum`), `docker`, `df`, `findmnt`, `mountpoint`, and
  `readlink`;
- mode-`0700` lock and temporary directories writable by the SSH build user.

No host-root bind mount is used remotely because the command already executes
in the host mount namespace. An unprovisioned remote host fails closed before
clone. If remote builds are not currently used, record the read-only inventory
that proves that fact; do not assume an empty UI list.

## Coverage and operational boundaries

Admission covers:

- Application deploys, including Docker-source pulls;
- Application rebuilds that clone, build, pull, tag, or push an image;
- preview deploys and rebuilds;
- Compose deploys and rebuilds across their clone/materialization and Docker
  phases;
- Compose starts, because `docker compose up` can pull a missing image;
- Compose source fetches used for service discovery and isolated-deployment
  generation;
- image pulls and service mutations for PostgreSQL, MySQL, MariaDB, MongoDB,
  Redis, LibSQL, monitoring, Traefik, Caddy, forward-auth, and the Dokploy
  PostgreSQL/Redis initializers;
- Dokploy self-update and image-tag reload pre-pulls;
- rollback, application reload, and split build/deployment-host mutation entry
  points.

Service starts and positive-replica snapshot recovery are admitted because a
scale from zero can pull a missing image; scale-to-zero remains outside the
capacity gate. Caddy service convergence, live validation, upstream probes,
and post-start network attachment remain owner-monitored until completion, and
abort promptly if the holder is lost. Forward-auth creates only after Docker
proves the service is absent; an existing-service update failure is propagated
instead of being treated as a successful create fallback.

An image-only Docker-source rebuild skips admission only when no registry,
build registry, or rollback registry can add a tag/push command. The
self-update and image-tag reload paths explicitly pre-pull while admitted,
release and clean the holder, and only then dispatch the service mutation.
Other service-specific Docker API phases currently assert holder ownership
before and after the awaited mutation; required-mode rollout must validate
their exact daemon and Swarm completion semantics on every target.

Each wrapped shell also takes a shared command-ownership lock and checks a
32-hex owner token before it starts. The child runs in its own process group;
owner-token loss terminates and reaps that group. A replacement holder takes
the exclusive command lock to drain prior work before rerunning the gate, and
removes only the prior validated owner's private temporary directory.

Nixpacks, Railpack, and Paketo/Heroku `pack` child argv contain environment
variable names only; exact values are exported by the private script and read
from its process environment. Docker build args use value-less `--build-arg
KEY`. BuildKit secrets use separate mode-`0600` source files, so a secret with
the same key as a build arg cannot override or leak through that ordinary build
arg. Values stay in the private script/process environment or private files and
never appear in Docker CLI argv. Authenticated provider
clones use credential-free repository URLs plus a short-lived credential
helper and protected credential file in the same private directory. The helper
answers only for the initial URL's exact protocol and host, so a
repository-controlled cross-host submodule cannot receive the parent provider
token.

`docker stack deploy --with-registry-auth` can return before workers finish
pulling. This hook claims capacity admission only for the measured build or
manager host and for explicit pulls awaited there; it does not claim
cluster-wide admission for Docker's later asynchronous worker-node pulls.
Per-node admission and convergence proof are a separate control. The one-time
bootstrap pull in `apps/dokploy/setup.ts` is also outside runtime admission and
must run only under an independently approved bootstrap procedure.

This control never prunes images, containers, volumes, logs, networks, or
BuildKit cache. A capacity denial is an instruction to follow the separately
approved capacity/cleanup runbook, not authorization for automatic reclaim.

## Candidate and rollback checks

Before promotion:

1. Verify the adapter, platform gate, and policy hashes from the exact image and
   installed files.
2. Run focused admission tests and the Application and Compose command tests.
3. Start a no-provider fixture with a fake gate and prove deny, retry recheck,
   continuous lock ownership, and temporary cleanup.
4. From the candidate container, compare root and Docker filesystem evidence
   with the host as described above.
5. Prove a denied fixture creates no clone directory, image, or service update.

Rollback restores the prior immutable Dokploy image and prior service spec.
Removing required mode or the read-only host mount is a production service
mutation and must use the same reviewed image-only rollback path. Never weaken
or override the catalog thresholds through runtime environment variables.
