import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CADDY_IMAGE, type CaddyRoute, renderCaddyfile } from "@dokploy/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const route = (host: string, https: boolean): CaddyRoute => ({
	host,
	https,
	path: null,
	stripPrefix: null,
	addPrefix: null,
	uniqueConfigKey: 1,
	upstreams: ["app:3000"],
	users: [],
	redirects: [],
});
const routes = [route("secure.test", true), route("plain.test", false)];
const sites = (caddyfile: string) =>
	[...caddyfile.matchAll(/^(https?:\/\/\S* \{)\n([\s\S]*?)\n\}$/gm)].map(
		([, address = "", body = ""]) => [address, ...body.split("\n")],
	);

describe("the request log in the Caddyfile", () => {
	test("is absent unless a file is given", () => {
		const { caddyfile } = renderCaddyfile({ certificates: [], routes });

		expect(caddyfile).not.toContain("log");
	});

	test("is one logger with the redaction, and every site writes to it", () => {
		const { caddyfile } = renderCaddyfile({
			certificates: [],
			routes,
			requestLog: "/etc/caddy/access.log",
		});

		expect(caddyfile).toContain(
			[
				"\tlog dokploy_requests {",
				"\t\toutput file `/etc/caddy/access.log`",
				"\t\tformat filter {",
				"\t\t\trequest>headers>X-Api-Key delete",
				"\t\t\trequest>uri multi_regexp {",
				"\t\t\t\tregexp `^(/api/deploy/(compose/)?)[^/?]+` `${1}[REDACTED]`",
				"\t\t\t\tregexp `\\?.*$` ``",
				"\t\t\t}",
				"\t\t\twrap json",
				"\t\t}",
				"\t\tinclude http.log.access",
				"\t}",
				"\timport global/*.caddy",
			].join("\n"),
		);
		expect(sites(caddyfile).map(([address]) => address)).toEqual([
			"https://secure.test {",
			"http://plain.test {",
			"http:// {",
		]);
		for (const lines of sites(caddyfile)) expect(lines).toContain("\tlog");
	});
});

const hasDocker = () => {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

describe.skipIf(!hasDocker())("the request log in real Caddy", () => {
	let folder = "";
	let container = "";
	const docker = (...args: string[]) =>
		execFileSync("docker", args, { encoding: "utf8", timeout: 120000 });

	beforeAll(() => {
		folder = mkdtempSync(join(tmpdir(), "dokploy-caddy-log-"));
		writeFileSync(
			join(folder, "Caddyfile"),
			renderCaddyfile({
				certificates: [],
				routes: [],
				requestLog: "/etc/caddy/access.log",
			}).caddyfile,
		);
		container = docker(
			"run",
			"-d",
			"-v",
			`${folder}:/etc/caddy`,
			CADDY_IMAGE,
			"caddy",
			"run",
			"--config",
			"/etc/caddy/Caddyfile",
		).trim();
	}, 180000);

	afterAll(() => {
		if (container) docker("rm", "-f", container);
		if (folder) rmSync(folder, { recursive: true, force: true });
	});

	test("keeps tokens, query strings and API keys out of the file", async () => {
		const ask = (path: string) =>
			docker(
				"exec",
				container,
				"wget",
				"-q",
				"-O",
				"/dev/null",
				"--header",
				"X-Api-Key: s3cret-key",
				`http://127.0.0.1${path}`,
			);
		await expect
			.poll(
				() => {
					try {
						ask("/api/deploy/t0ken-one?next=s3cret-query");
					} catch {
						// Every host answers 404 here. Only the log matters.
					}
					try {
						ask("/api/deploy/compose/t0ken-two");
					} catch {}
					return docker("exec", container, "cat", "/etc/caddy/access.log");
				},
				{ timeout: 30000, interval: 500 },
			)
			.toContain("/api/deploy/compose/[REDACTED]");

		const log = docker("exec", container, "cat", "/etc/caddy/access.log");
		expect(log).toContain('"uri":"/api/deploy/[REDACTED]"');
		expect(log).not.toMatch(/t0ken|s3cret/);
		expect(docker("logs", container)).not.toMatch(/t0ken|s3cret/);
	}, 60000);
});
