import { fs, vol } from "memfs";

vi.mock("node:fs", () => ({
	...fs,
	default: fs,
}));

import { paths } from "@dokploy/server/constants";
import type { webServerSettings } from "@dokploy/server/db/schema";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { findHandWrittenTraefikConfig } from "@dokploy/server/setup/caddy-setup";
import {
	createDefaultServerTraefikConfig,
	getDefaultTraefikConfig,
} from "@dokploy/server/setup/traefik-setup";
import { updateServerTraefik } from "@dokploy/server/utils/traefik/web-server";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@dokploy/server/services/web-server-settings", async (original) => ({
	...(await original<
		typeof import("@dokploy/server/services/web-server-settings")
	>()),
	getWebServerSettings: vi.fn(),
}));

type Settings = typeof webServerSettings.$inferSelect;

const file = `${paths().DYNAMIC_TRAEFIK_PATH}/dokploy.yml`;
const read = () => fs.readFileSync(file, "utf8") as string;

// The dashboard's Traefik file, as Dokploy's own writers leave it for these
// settings.
const configure = (settings: Partial<Settings>) => {
	vi.mocked(getWebServerSettings).mockResolvedValue(settings as Settings);
	if (settings.host) updateServerTraefik(settings as Settings, settings.host);
};
const found = () =>
	findHandWrittenTraefikConfig(
		null,
		[],
		new Map([
			["traefik.yml", getDefaultTraefikConfig()],
			["dynamic/dokploy.yml", read()],
		]),
		new Map(),
	);

beforeEach(() => {
	vol.reset();
	createDefaultServerTraefikConfig();
});

test("asks for nothing about the dashboard's router, with or without a domain", async () => {
	configure({});
	expect(await found()).toEqual([]);
	configure({ host: "panel.test", https: false, certificateType: "none" });
	expect(await found()).toEqual([]);
	configure({
		host: "panel.test",
		https: true,
		certificateType: "letsencrypt",
	});
	expect(await found()).toEqual([]);
});

test("finds an address restriction someone added to the dashboard's router", async () => {
	configure({
		host: "panel.test",
		https: true,
		certificateType: "letsencrypt",
	});
	fs.writeFileSync(
		file,
		read().replaceAll(
			"Host(`panel.test`)",
			"Host(`panel.test`) && ClientIP(`10.0.0.0/8`)",
		),
	);
	expect(await found()).toEqual([
		"dynamic/dokploy.yml: the router dokploy-router-app is not the one Dokploy writes for a domain. Caddy follows the database, not this file.",
		"dynamic/dokploy.yml: the router dokploy-router-app-secure is not the one Dokploy writes for a domain. Caddy follows the database, not this file.",
	]);
});
