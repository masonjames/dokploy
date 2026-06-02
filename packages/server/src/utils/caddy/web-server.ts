import type { webServerSettings } from "@dokploy/server/db/schema/web-server-settings";
import { caddyTrustedProxySettingsToConfig } from "@dokploy/server/services/web-server-settings";
import {
	compileWriteAndReloadCaddyConfigSafely,
	removeCaddyRouteFragment,
	writeCaddyRouteFragment,
} from "./config";
import type { CaddyRouteFragment, CaddyRouteIntent } from "./types";
import { DOKPLOY_CADDY_NETWORK } from "./upstream-targets";

const CADDY_FRAGMENT_VERSION = 1;
const DASHBOARD_FRAGMENT_ID = "dashboard.dokploy";

const toPunycode = (host: string): string => {
	try {
		return new URL(`http://${host}`).hostname;
	} catch {
		return host;
	}
};

export const createCaddyDashboardRouteIntent = (
	settings: typeof webServerSettings.$inferSelect,
	host: string,
): CaddyRouteIntent => ({
	id: "dokploy-dashboard",
	source: "dokploy-dashboard",
	hosts: [toPunycode(host)],
	pathPrefix: "/",
	https: !!settings.https,
	upstreams: [`http://dokploy:${process.env.PORT || 3000}`],
	upstreamNetwork: DOKPLOY_CADDY_NETWORK,
});

export const createCaddyDashboardRouteFragment = (
	settings: typeof webServerSettings.$inferSelect,
	host: string,
): CaddyRouteFragment => ({
	version: CADDY_FRAGMENT_VERSION,
	id: DASHBOARD_FRAGMENT_ID,
	source: "dokploy-dashboard",
	description: "Dokploy dashboard route",
	routes: [createCaddyDashboardRouteIntent(settings, host)],
});

export const updateServerCaddy = async (
	settings: typeof webServerSettings.$inferSelect,
	newHost: string | null,
) => {
	if (newHost) {
		await writeCaddyRouteFragment(
			createCaddyDashboardRouteFragment(settings, newHost),
		);
	} else {
		await removeCaddyRouteFragment(DASHBOARD_FRAGMENT_ID);
	}

	await compileWriteAndReloadCaddyConfigSafely({
		letsEncryptEmail: settings.letsEncryptEmail,
		trustedProxies: caddyTrustedProxySettingsToConfig(
			settings.caddyTrustedProxyConfig,
		),
	});
};
