import type { Domain } from "@dokploy/server/services/domain";
import { resolveWebServerProvider } from "@dokploy/server/services/web-server-settings";
import type { ApplicationNested } from "../builders";
import { manageDomain, removeDomain } from "../traefik/domain";

/**
 * Create or update the edge route for an application domain using the
 * active web-server provider. Call sites must use this instead of the
 * provider-specific helpers so routing stays provider-neutral.
 */
export const manageWebServerDomain = async (
	app: ApplicationNested,
	domain: Domain,
) => {
	const provider = await resolveWebServerProvider(app.serverId);

	switch (provider) {
		case "traefik":
			return manageDomain(app, domain);
	}
};

/**
 * Remove the edge route for an application domain using the active
 * web-server provider.
 */
export const removeWebServerDomain = async (
	app: ApplicationNested,
	uniqueConfigKey: number,
) => {
	const provider = await resolveWebServerProvider(app.serverId);

	switch (provider) {
		case "traefik":
			return removeDomain(app, uniqueConfigKey);
	}
};
