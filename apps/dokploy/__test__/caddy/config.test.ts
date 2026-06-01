import { fs, vol } from "memfs";

vi.mock("node:fs", () => ({
	...fs,
	default: fs,
}));

const execAsyncMock = vi.hoisted(() => vi.fn());
const execAsyncRemoteMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: execAsyncMock,
	execAsyncRemote: execAsyncRemoteMock,
}));

import {
	type ApplicationNested,
	type CaddyRouteFragment,
	type CaddyRouteIntent,
	compileAndWriteCaddyConfig,
	compileCaddyConfig,
	type Domain,
	getCaddyMigrationArtifactPaths,
	manageCaddyDomain,
	paths,
	readCaddyRouteFragments,
	validateCaddyConfigFileWithImage,
	writeCaddyRouteFragment,
} from "@dokploy/server";
import { beforeEach, expect, test, vi } from "vitest";

const route = (
	overrides: Partial<CaddyRouteIntent> = {},
): CaddyRouteIntent => ({
	id: "app-route",
	source: "dokploy-application",
	hosts: ["example.com"],
	https: false,
	upstreams: ["http://app:3000"],
	...overrides,
});

const getServers = (config: ReturnType<typeof compileCaddyConfig>) => {
	const apps = config.apps as Record<string, any>;
	return apps.http.servers as Record<string, any>;
};

beforeEach(() => {
	vol.reset();
	execAsyncMock.mockReset();
	execAsyncRemoteMock.mockReset();
	execAsyncMock.mockResolvedValue({ stdout: "dokploy-caddy\n", stderr: "" });
	execAsyncRemoteMock.mockResolvedValue({
		stdout: "dokploy-caddy\n",
		stderr: "",
	});
});

test("compiles explicit http and https servers with managed HTTPS redirect", () => {
	const config = compileCaddyConfig({
		letsEncryptEmail: "ops@example.com",
		routes: [route({ https: true })],
	});

	const servers = getServers(config);
	expect(servers.http.listen).toEqual([":80"]);
	expect(servers.https.listen).toEqual([":443"]);
	expect(servers.http.routes[0].handle[0].handler).toBe("static_response");
	expect(servers.http.routes[0].handle[0].headers.Location).toEqual([
		"https://{http.request.host}{http.request.uri}",
	]);
	expect(servers.https.routes[0].handle.at(-1)).toMatchObject({
		handler: "reverse_proxy",
		upstreams: [{ dial: "app:3000" }],
	});
	expect((config.apps as any).tls.automation.policies[0].issuers[0].email).toBe(
		"ops@example.com",
	);
});

test("sorts routes by priority before path specificity and stable id", () => {
	const config = compileCaddyConfig({
		routes: [
			route({ id: "low-specific", priority: 1, pathPrefix: "/very/specific" }),
			route({ id: "high-priority", priority: 10, pathPrefix: "/api" }),
			route({ id: "same-priority-longer", priority: 1, pathPrefix: "/longer" }),
			route({
				id: "same-tiebreak-b",
				priority: 1,
				pathPrefix: "/same",
				upstreams: ["http://b:3000"],
			}),
			route({
				id: "same-tiebreak-a",
				priority: 1,
				pathPrefix: "/same",
				upstreams: ["http://a:3000"],
			}),
		],
	});

	const [first, second, third, fourth, fifth] = getServers(config).http.routes;
	expect(first.match[0].path).toEqual(["/api*"]);
	expect(second.match[0].path).toEqual(["/very/specific*"]);
	expect(third.match[0].path).toEqual(["/longer*"]);
	expect(fourth.handle.at(-1).upstreams).toEqual([{ dial: "a:3000" }]);
	expect(fifth.handle.at(-1).upstreams).toEqual([{ dial: "b:3000" }]);
});

test("orders migrated manual and Traefik routes before DB fallbacks for identical catch-all matches", () => {
	const config = compileCaddyConfig({
		routes: [
			route({
				id: "db-compose-fallback",
				source: "dokploy-compose",
				https: true,
				upstreams: ["http://cms:3000"],
			}),
			route({
				id: "manual-waf",
				source: "manual",
				https: true,
				upstreams: ["http://waf:8080"],
			}),
			route({
				id: "dynamic-blog",
				source: "traefik-dynamic-file",
				https: true,
				upstreams: ["http://blog:8080"],
			}),
			route({
				id: "label-cms",
				source: "traefik-compose-label",
				https: true,
				upstreams: ["http://cms:80"],
			}),
		],
	});

	const upstreamOrder = getServers(config).https.routes.map(
		(compiledRoute: any) => compiledRoute.handle.at(-1).upstreams[0].dial,
	);
	expect(upstreamOrder).toEqual([
		"waf:8080",
		"cms:80",
		"blog:8080",
		"cms:3000",
	]);
});

test("renders transforms, headers, and HTTPS upstream transport", () => {
	const config = compileCaddyConfig({
		routes: [
			route({
				upstreams: ["https://upstream.example.com:443"],
				transforms: {
					stripPrefix: "/public",
					addPrefix: "/internal",
					responseHeaders: {
						"Cache-Control": "no-store",
					},
				},
			}),
		],
	});

	const handlers = getServers(config).http.routes[0].handle;
	expect(handlers[0]).toMatchObject({
		handler: "headers",
		response: { set: { "Cache-Control": ["no-store"] } },
	});
	expect(handlers[1]).toMatchObject({
		handler: "rewrite",
		strip_path_prefix: "/public",
	});
	expect(handlers[2]).toMatchObject({
		handler: "rewrite",
		uri: "/internal{http.request.uri.path}",
	});
	expect(handlers[3]).toMatchObject({
		handler: "reverse_proxy",
		upstreams: [{ dial: "upstream.example.com:443" }],
		transport: { protocol: "http", tls: {} },
	});
});

test("rejects proxy upstreams without explicit valid ports", () => {
	for (const upstream of [
		"http://admin",
		"https://external.example.com",
		"http://app:0",
		"http://app:65536",
		"http://app:abc",
		"app",
		"app:0",
	]) {
		expect(() =>
			compileCaddyConfig({
				routes: [route({ upstreams: [upstream] })],
			}),
		).toThrow(`invalid upstream "${upstream}"`);
	}
});

test("allows redirect-only routes without upstreams", () => {
	const config = compileCaddyConfig({
		routes: [
			route({
				upstreams: [],
				redirectScheme: { scheme: "https", permanent: true },
			}),
		],
	});

	expect(getServers(config).http.routes[0].handle[0]).toMatchObject({
		handler: "static_response",
		status_code: 308,
	});
});

test("allows static response routes without upstreams", () => {
	const config = compileCaddyConfig({
		routes: [
			route({
				source: "manual",
				https: true,
				upstreams: [],
				staticResponse: {
					statusCode: 404,
					headers: {
						"Cache-Control": "no-store",
					},
				},
			}),
		],
	});

	const servers = getServers(config);
	expect(servers.http.routes[0].handle[0]).toMatchObject({
		handler: "static_response",
		status_code: 308,
	});
	expect(servers.https.routes[0].handle).toEqual([
		{
			handler: "static_response",
			status_code: 404,
			headers: {
				"Cache-Control": ["no-store"],
			},
		},
	]);
});

test("stores fragments and compiles them into the active config", async () => {
	const fragment: CaddyRouteFragment = {
		version: 1,
		id: "app.example",
		source: "dokploy-application",
		routes: [route({ id: "stored", pathPrefix: "/stored" })],
	};

	await writeCaddyRouteFragment(fragment);
	const fragments = await readCaddyRouteFragments();
	const config = await compileAndWriteCaddyConfig();

	expect(fragments).toEqual([fragment]);
	expect(getServers(config).http.routes[0].match[0].path).toEqual(["/stored*"]);
});

test("rejects invalid fragment ids before touching the store", async () => {
	for (const id of ["../bad", "..", ".", "bad..segment"]) {
		await expect(
			writeCaddyRouteFragment({
				version: 1,
				id,
				source: "manual",
				routes: [route()],
			}),
		).rejects.toThrow("Invalid Caddy fragment id");
	}
	expect(vol.existsSync(paths().CADDY_FRAGMENTS_PATH)).toBe(false);
});

test("rejects unsafe Caddy migration ids", () => {
	for (const id of ["..", ".", "bad..segment"]) {
		expect(() => getCaddyMigrationArtifactPaths(id)).toThrow(
			"Invalid Caddy migration id",
		);
	}
});

test("validates a config file with the Caddy binary in an isolated runtime container", async () => {
	await validateCaddyConfigFileWithImage(
		"/etc/dokploy/caddy/migrations/test/caddy.json",
	);

	const validateCommand = execAsyncMock.mock.calls
		.map(([command]) => command as string)
		.find((command) => command.includes("docker run"));
	expect(validateCommand).toContain("docker run --rm --network none");
	expect(validateCommand).toContain("caddy\\:2.11.3");
	expect(validateCommand).toContain(
		"/etc/dokploy/caddy/migrations/test/caddy.json\\:/etc/caddy/caddy.json\\:ro",
	);
	expect(validateCommand).toContain(
		"/etc/dokploy/caddy/migrations/test/.validate-runtime/config\\:/config",
	);
	expect(validateCommand).toContain(" caddy validate --config");
	expect(validateCommand).not.toContain("caddy\\:2.11.3 validate --config");
});

test("restores previous fragments when Caddy domain reload fails", async () => {
	const existingFragment: CaddyRouteFragment = {
		version: 1,
		id: "app.existing",
		source: "dokploy-application",
		routes: [route({ id: "existing", hosts: ["old.example.com"] })],
	};
	await writeCaddyRouteFragment(existingFragment);
	execAsyncMock.mockImplementation(async (command: string) => {
		if (command.includes("caddy validate")) {
			throw new Error("validation failed");
		}
		return { stdout: "dokploy-caddy\n", stderr: "" };
	});

	await expect(
		manageCaddyDomain(
			{ appName: "my-app", serverId: null } as ApplicationNested,
			{
				domainId: "domain-1",
				applicationId: "app-1",
				composeId: null,
				previewDeploymentId: null,
				domainType: "application",
				host: "example.com",
				path: "/",
				internalPath: "/",
				stripPath: false,
				https: false,
				certificateType: "none",
				customCertResolver: null,
				customEntrypoint: null,
				middlewares: null,
				port: 3000,
				serviceName: null,
				uniqueConfigKey: 7,
				createdAt: "",
			} as Domain,
		),
	).rejects.toThrow("validation failed");

	expect(await readCaddyRouteFragments()).toEqual([existingFragment]);
});
