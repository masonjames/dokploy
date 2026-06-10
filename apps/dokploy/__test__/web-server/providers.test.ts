import { expect, test, vi } from "vitest";

vi.mock("@dokploy/server/constants", () => ({
	paths: vi.fn((isServer = false) => {
		const base = isServer ? "/etc/dokploy" : "/local/etc/dokploy";
		return {
			MAIN_TRAEFIK_PATH: `${base}/traefik`,
			DYNAMIC_TRAEFIK_PATH: `${base}/traefik/dynamic`,
			CERTIFICATES_PATH: `${base}/traefik/dynamic/certificates`,
		};
	}),
}));

import { getWebServerPaths } from "@dokploy/server/utils/web-server/paths";
import {
	DEFAULT_WEB_SERVER_PROVIDER,
	getWebServerResourceName,
	isWebServerProvider,
	normalizeWebServerProvider,
	WEB_SERVER_PROVIDERS,
} from "@dokploy/server/utils/web-server/providers";

test("traefik is the only registered provider and the default", () => {
	expect(WEB_SERVER_PROVIDERS).toEqual(["traefik"]);
	expect(DEFAULT_WEB_SERVER_PROVIDER).toBe("traefik");
});

test("recognizes registered providers", () => {
	expect(isWebServerProvider("traefik")).toBe(true);
	expect(isWebServerProvider("caddy")).toBe(false);
	expect(isWebServerProvider(undefined)).toBe(false);
	expect(isWebServerProvider(42)).toBe(false);
});

test("normalizes unknown values to the default provider", () => {
	expect(normalizeWebServerProvider("traefik")).toBe("traefik");
	expect(normalizeWebServerProvider("nginx")).toBe("traefik");
	expect(normalizeWebServerProvider(null)).toBe("traefik");
});

test("maps the provider to its docker resource name", () => {
	expect(getWebServerResourceName("traefik")).toBe("dokploy-traefik");
});

test("exposes the Traefik filesystem layout for the local host", () => {
	expect(getWebServerPaths("traefik")).toEqual({
		provider: "traefik",
		basePath: "/local/etc/dokploy/traefik",
		activeConfigPath: "/local/etc/dokploy/traefik/traefik.yml",
		fragmentsPath: "/local/etc/dokploy/traefik/dynamic",
		certificatesPath: "/local/etc/dokploy/traefik/dynamic/certificates",
	});
});

test("exposes the Traefik filesystem layout for remote servers", () => {
	expect(getWebServerPaths("traefik", true)).toEqual({
		provider: "traefik",
		basePath: "/etc/dokploy/traefik",
		activeConfigPath: "/etc/dokploy/traefik/traefik.yml",
		fragmentsPath: "/etc/dokploy/traefik/dynamic",
		certificatesPath: "/etc/dokploy/traefik/dynamic/certificates",
	});
});
