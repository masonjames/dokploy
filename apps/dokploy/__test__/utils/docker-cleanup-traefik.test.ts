import { execFileSync } from "node:child_process";
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

// Execute the generated shell against a Docker fixture; no daemon is contacted.
const runWithFakeDocker = (script: string) => {
	const log = path.join(binDir, "calls.log");
	writeFileSync(log, "");
	writeFileSync(
		path.join(binDir, "docker"),
		`#!/bin/sh
if [ "$1 $2" = "container ls" ]; then
    printf '%s\n' 'proxy1 dokploy-traefik' 'proxy2 dokploy-caddy' 'proxy3 dokploy-caddy-previous' 'proxy4 dokploy-traefik-previous' 'unrelated exited-app' 'similar dokploy-traefik-app'
    exit 0
fi
if [ "$1 $2" = "container inspect" ]; then
    echo false
    exit 0
fi
[ "$1" = node ] && exit 0
echo "$*" >> "${log}"
`,
	);
	writeFileSync(path.join(binDir, "ps"), "#!/bin/sh\n");
	chmodSync(path.join(binDir, "docker"), 0o755);
	chmodSync(path.join(binDir, "ps"), 0o755);
	execFileSync("sh", ["-c", script], {
		env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
	});
	return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
};

const commandOf = async (fn: () => Promise<unknown>) => {
	execAsync.mockClear();
	await fn();
	return execAsync.mock.calls.map(([command]) => command as string);
};

describe("docker cleanup keeps a stopped dokploy-traefik", () => {
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
			const calls = scripts.flatMap((script) => runWithFakeDocker(script));
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
				expect(calls).toContain("network prune --force");
				expect(calls).toContain("builder prune --all --force");
			}
		},
	);
});
