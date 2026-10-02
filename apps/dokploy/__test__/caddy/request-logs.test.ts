import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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
				"\t\t\trequest>headers delete",
				"\t\t\tresp_headers delete",
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
		for (const lines of sites(caddyfile)) {
			expect(lines.slice(1, 3)).toEqual([
				"\tlog",
				"\tlog_append user_agent {header.User-Agent}",
			]);
		}
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
	let port = 0;
	const docker = (...args: string[]) =>
		execFileSync("docker", args, { encoding: "utf8", timeout: 120000 });
	const send = (host: string, path: string, headers = {}) =>
		new Promise<number | undefined>((resolve) => {
			request(
				{ port, path, headers: { Host: host, ...headers } },
				(response) => {
					response.resume();
					response.on("end", () => resolve(response.statusCode));
				},
			)
				.on("error", () => resolve(undefined))
				.end();
		});
	const log = () => {
		try {
			return docker("exec", container, "cat", "/etc/caddy/access.log");
		} catch {
			return "";
		}
	};

	beforeAll(async () => {
		folder = mkdtempSync(join(tmpdir(), "dokploy-caddy-log-"));
		writeFileSync(
			join(folder, "Caddyfile"),
			renderCaddyfile({
				certificates: [],
				// Self-signed, so nothing is asked of a certificate authority.
				routes: [{ ...route("secure.test", true), selfSigned: true }],
				requestLog: "/etc/caddy/access.log",
			}).caddyfile,
		);
		container = docker(
			"run",
			"-d",
			"-p",
			"127.0.0.1::80",
			"-v",
			`${folder}:/etc/caddy`,
			CADDY_IMAGE,
			"caddy",
			"run",
			"--config",
			"/etc/caddy/Caddyfile",
		).trim();
		port = Number(docker("port", container, "80/tcp").trim().split(":").pop());
		for (let tries = 0; tries < 120; tries++) {
			if ((await send("nobody.test", "/")) === 404) return;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error("Caddy did not start");
	}, 180000);

	afterAll(() => {
		if (container) docker("rm", "-f", container);
		if (folder) rmSync(folder, { recursive: true, force: true });
	});

	test("keeps tokens, query strings and every header out of the file", async () => {
		expect(
			await send("nobody.test", "/api/deploy/t0ken-one?next=s3cret-query", {
				"User-Agent": "lab-agent",
				"X-Api-Key": "s3cret-key",
				"Private-Token": "s3cret-private",
				Referer: "https://other.test/reset?token=s3cret-referer",
			}),
		).toBe(404);
		// Caddy's own redirect to HTTPS repeats the path and the query in Location.
		expect(
			await send(
				"secure.test",
				"/api/deploy/compose/t0ken-two?code=s3cret-code",
			),
		).toBe(308);
		await expect
			.poll(() => log().trim().split("\n").length, { timeout: 30000 })
			.toBeGreaterThanOrEqual(3);

		expect(log()).toContain('"uri":"/api/deploy/[REDACTED]"');
		expect(log()).toContain('"uri":"/api/deploy/compose/[REDACTED]"');
		expect(log()).toContain('"user_agent":"lab-agent"');
		expect(log()).not.toMatch(/t0ken|s3cret|headers/);
		expect(docker("logs", container)).not.toMatch(/t0ken|s3cret/);
	}, 60000);
});
