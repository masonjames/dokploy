import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execAsync } = vi.hoisted(() => ({ execAsync: vi.fn() }));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync,
	execAsyncRemote: vi.fn(),
}));

import {
	cleanupAll,
	cleanupContainers,
	cleanupSystem,
} from "@dokploy/server/utils/docker/utils";

let binDir: string;

const stoppedProxies = [
	"proxy1 dokploy-traefik exited",
	"proxy2 dokploy-caddy created",
	"proxy3 dokploy-caddy-previous dead",
	"proxy4 dokploy-traefik-previous exited",
];

// Execute the generated shell against a Docker fixture; no daemon is contacted.
const runWithFakeDocker = (
	script: string,
	containers = [
		...stoppedProxies,
		"unrelated exited-app exited",
		"similar dokploy-traefik-app created",
		"active running-app running",
	],
	removalError = "",
) => {
	const log = path.join(binDir, "calls.log");
	writeFileSync(log, "");
	writeFileSync(path.join(binDir, "containers"), `${containers.join("\n")}\n`);
	writeFileSync(path.join(binDir, "removal-error"), removalError);
	writeFileSync(
		path.join(binDir, "docker"),
		`#!/bin/sh
if [ "$1 $2" = "container ls" ]; then
    while read -r id names state; do
        [ -n "$id" ] || continue
        case "$*" in
            *status=exited*)
                case "$state" in exited|created|dead) ;; *) continue ;; esac ;;
        esac
        case "$*" in
            *'{{.State}}'*) printf '%s %s %s\n' "$id" "$names" "$state" ;;
            *) printf '%s %s\n' "$id" "$names" ;;
        esac
    done < "${binDir}/containers"
    exit 0
fi
if [ "$1 $2" = "container inspect" ]; then
    echo false
    exit 0
fi
[ "$1" = node ] && exit 0
echo "$*" >> "${log}"
if [ "$1 $2 $3" = "container rm middle" ] && [ -s "${binDir}/removal-error" ]; then
    cat "${binDir}/removal-error" >&2
    exit 1
fi
exit 0
`,
	);
	writeFileSync(path.join(binDir, "ps"), "#!/bin/sh\n");
	chmodSync(path.join(binDir, "docker"), 0o755);
	chmodSync(path.join(binDir, "ps"), 0o755);
	const result = spawnSync("sh", ["-c", script], {
		env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
		encoding: "utf8",
	});
	expect(result.error).toBeUndefined();
	return {
		status: result.status,
		stderr: result.stderr,
		calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
	};
};

const commandOf = async (fn: () => Promise<unknown>) => {
	execAsync.mockClear();
	await fn();
	return execAsync.mock.calls.map(([command]) => command as string);
};

describe("docker cleanup preserves proxies and reports failures", () => {
	beforeEach(() => {
		binDir = mkdtempSync(path.join(tmpdir(), "fake-docker-"));
	});

	afterEach(() => {
		rmSync(binDir, { recursive: true, force: true });
	});

	it.each([
		["cleanupContainers", cleanupContainers],
		["cleanupSystem", cleanupSystem],
		["cleanupAll", cleanupAll],
	] as const)(
		"%s preserves proxies while removing unrelated stopped containers",
		async (_, fn) => {
			const scripts = await commandOf(() => fn());
			const calls = scripts.flatMap((script) => {
				const result = runWithFakeDocker(script);
				expect(result.status).toBe(0);
				return result.calls;
			});
			expect(calls).toContain("container rm unrelated");
			expect(calls).toContain("container rm similar");
			expect(calls.filter((call) => call.startsWith("container rm"))).toSatisfy(
				(removals: string[]) =>
					removals.every((call) =>
						["container rm unrelated", "container rm similar"].includes(call),
					),
			);
			expect(
				calls.some((call) =>
					/volume|system prune|container prune|rm --force|rm -v/.test(call),
				),
			).toBe(false);
			if (fn !== cleanupContainers) {
				expect(calls).toContain("image prune --all --force");
				expect(calls).not.toContain("network prune --force");
				expect(calls).toContain("builder prune --all --force");
			}
		},
	);

	it.each([
		["cleanupContainers", cleanupContainers],
		["cleanupSystem", cleanupSystem],
	] as const)("%s continues after a real removal failure", async (_, fn) => {
		const [script] = await commandOf(() => fn());
		const result = runWithFakeDocker(
			script!,
			["first app-one exited", "middle app-two dead", "last app-three created"],
			"Error response from daemon: removal of container middle failed: busy",
		);
		expect(
			result.calls.filter((call) => call.startsWith("container rm")),
		).toEqual([
			"container rm first",
			"container rm middle",
			"container rm last",
		]);
		if (fn === cleanupSystem) {
			expect(result.calls.slice(-3)).toEqual([
				"image prune --all --force",
				"network prune --force",
				"builder prune --all --force",
			]);
		}
		expect(result.stderr).toContain("removal of container middle failed: busy");
		expect(result.status).toBe(1);
	});

	it.each([
		["cleanupContainers", cleanupContainers],
		["cleanupSystem", cleanupSystem],
	] as const)("%s tolerates an already removed container", async (_, fn) => {
		const [script] = await commandOf(() => fn());
		const result = runWithFakeDocker(
			script!,
			["middle vanished-app exited", "last app-three exited"],
			"Error response from daemon: No such container: middle",
		);
		expect(result.status).toBe(0);
		expect(result.calls).toContain("container rm last");
		if (fn === cleanupSystem) {
			expect(result.calls).toContain("builder prune --all --force");
		}
	});

	it.each([
		"dokploy-traefik",
		"dokploy-traefik-previous",
		"dokploy-caddy",
		"dokploy-caddy-previous",
	])("preserves %s among multiple names", async (name) => {
		const [script] = await commandOf(() => cleanupSystem());
		const result = runWithFakeDocker(script!, [
			`proxy alias/one,${name},alias/two exited`,
			"unrelated exited-app exited",
		]);
		expect(result.status).toBe(0);
		expect(result.calls).not.toContain("container rm proxy");
		expect(result.calls).toContain("container rm unrelated");
		expect(result.calls).not.toContain("network prune --force");
	});

	it.each(["exited", "created", "dead", "paused", "restarting"])(
		"skips network prune with a %s proxy",
		async (state) => {
			const [script] = await commandOf(() => cleanupSystem());
			const result = runWithFakeDocker(script!, [
				`proxy dokploy-caddy ${state}`,
			]);
			expect(result.status).toBe(0);
			expect(result.calls).not.toContain("network prune --force");
			expect(result.calls).toContain("image prune --all --force");
			expect(result.calls).toContain("builder prune --all --force");
		},
	);

	it.each([
		["no proxy", ["unrelated exited-app exited"]],
		["a running proxy", ["proxy dokploy-caddy running"]],
		["no containers", []],
	])("prunes networks with %s", async (_, containers) => {
		const [script] = await commandOf(() => cleanupSystem());
		const result = runWithFakeDocker(script!, containers);
		expect(result.status).toBe(0);
		expect(result.calls).toContain("network prune --force");
		expect(result.calls).not.toContain("container rm proxy");
	});
});
