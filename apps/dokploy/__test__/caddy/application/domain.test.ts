import type { ApplicationNested, Domain } from "@dokploy/server";
import {
	compileCaddyConfig,
	createCaddyApplicationRouteFragment,
	getCaddyApplicationFragmentId,
} from "@dokploy/server";
import { expect, test } from "vitest";

const app = (overrides: Partial<ApplicationNested> = {}) =>
	({
		appName: "my-app",
		serverId: null,
		...overrides,
	}) as ApplicationNested;

const domain = (overrides: Partial<Domain> = {}) =>
	({
		domainId: "domain-1",
		applicationId: "app-1",
		composeId: null,
		previewDeploymentId: null,
		domainType: "application",
		host: "example.com",
		path: null,
		internalPath: "/",
		stripPath: false,
		https: false,
		certificateType: "none",
		customCertResolver: null,
		customEntrypoint: null,
		middlewares: null,
		port: null,
		serviceName: null,
		uniqueConfigKey: 7,
		createdAt: "",
		...overrides,
	}) as Domain;

const getServers = (config: ReturnType<typeof compileCaddyConfig>) => {
	const apps = config.apps as Record<string, any>;
	return apps.http.servers as Record<string, any>;
};

test("creates deterministic Caddy application fragments", () => {
	const fragment = createCaddyApplicationRouteFragment(app(), domain());

	expect(fragment.id).toBe(getCaddyApplicationFragmentId("my-app", 7));
	expect(fragment.source).toBe("dokploy-application");
	expect(fragment.routes[0]).toMatchObject({
		id: "my-app-route-7",
		hosts: ["example.com"],
		https: false,
		upstreams: ["http://my-app:80"],
	});
});

test("renders path rewrites and custom upstream port", () => {
	const fragment = createCaddyApplicationRouteFragment(
		app(),
		domain({
			path: "/public",
			stripPath: true,
			internalPath: "/internal",
			port: 3000,
		}),
	);
	const config = compileCaddyConfig({ fragments: [fragment] });
	const handlers = getServers(config).http.routes[0].handle;

	expect(getServers(config).http.routes[0].match[0]).toMatchObject({
		host: ["example.com"],
		path: ["/public*"],
	});
	expect(handlers[0]).toMatchObject({
		handler: "rewrite",
		strip_path_prefix: "/public",
	});
	expect(handlers[1]).toMatchObject({
		handler: "rewrite",
		uri: "/internal{http.request.uri.path}",
	});
	expect(handlers[2]).toMatchObject({
		handler: "reverse_proxy",
		upstreams: [{ dial: "my-app:3000" }],
	});
});

test("HTTPS application routes redirect HTTP and proxy on HTTPS", () => {
	const fragment = createCaddyApplicationRouteFragment(
		app(),
		domain({ https: true, certificateType: "letsencrypt" }),
	);
	const config = compileCaddyConfig({ fragments: [fragment] });
	const servers = getServers(config);

	expect(servers.http.routes[0].handle[0]).toMatchObject({
		handler: "static_response",
		status_code: 308,
	});
	expect(servers.https.routes[0].handle.at(-1)).toMatchObject({
		handler: "reverse_proxy",
		upstreams: [{ dial: "my-app:80" }],
	});
});

test("punycodes internationalized hosts for Caddy routes", () => {
	const fragment = createCaddyApplicationRouteFragment(
		app(),
		domain({ host: "тест.рф" }),
	);

	expect(fragment.routes[0]?.hosts).toEqual(["xn--e1aybc.xn--p1ai"]);
});

test("rejects Traefik-only domain features for Caddy routes", () => {
	expect(() =>
		createCaddyApplicationRouteFragment(
			app(),
			domain({
				customEntrypoint: "admin",
				customCertResolver: "internal",
				certificateType: "custom",
				middlewares: ["auth@file"],
			}),
		),
	).toThrow("unsupported Caddy fields");
});
