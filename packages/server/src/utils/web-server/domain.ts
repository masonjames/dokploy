import type { Domain } from "@dokploy/server/services/domain";
import { resolveWebServerProvider } from "@dokploy/server/services/web-server-settings";
import type { ApplicationNested } from "../builders";
import {
	manageCaddyDomain,
	removeCaddyAppRouteFragments,
	removeCaddyDomain,
} from "../caddy/domain";
import { removeTraefikConfig } from "../traefik/application";
import { manageDomain, removeDomain } from "../traefik/domain";

export const manageWebServerDomain = async (
	app: ApplicationNested,
	domain: Domain,
) => {
	const provider = await resolveWebServerProvider(app.serverId);

	if (provider === "caddy") {
		return manageCaddyDomain(app, domain);
	}

	return manageDomain(app, domain);
};

export const removeWebServerDomain = async (
	app: ApplicationNested,
	uniqueConfigKey: number,
) => {
	const provider = await resolveWebServerProvider(app.serverId);

	if (provider === "caddy") {
		return removeCaddyDomain(app, uniqueConfigKey);
	}

	return removeDomain(app, uniqueConfigKey);
};

// Removes all routing config for a deleted application or compose app.
// The Traefik file is removed unconditionally, as before; Caddy fragments
// only exist (and only need a reload) when Caddy is the active provider.
export const removeWebServerAppRoutes = async (
	appName: string,
	serverId?: string | null,
) => {
	await removeTraefikConfig(appName, serverId);
	if ((await resolveWebServerProvider(serverId)) === "caddy") {
		await removeCaddyAppRouteFragments(appName, serverId);
	}
};
