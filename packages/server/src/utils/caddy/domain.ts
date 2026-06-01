import type { Domain } from "@dokploy/server/services/domain";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import type { ApplicationNested } from "../builders";
import {
	compileWriteAndReloadCaddyConfigSafely,
	readCaddyRouteFragments,
	removeCaddyRouteFragment,
	restoreCaddyRouteFragments,
	writeCaddyRouteFragment,
} from "./config";
import type { CaddyRouteFragment, CaddyRouteIntent } from "./types";
import { DOKPLOY_CADDY_NETWORK } from "./upstream-targets";

const CADDY_FRAGMENT_VERSION = 1;

const toPunycode = (host: string): string => {
	try {
		return new URL(`http://${host}`).hostname;
	} catch {
		return host;
	}
};

export const getCaddyApplicationFragmentId = (
	appName: string,
	uniqueConfigKey: number,
) => `application.${appName}.${uniqueConfigKey}`;

const createCaddyRouteId = (appName: string, uniqueConfigKey: number) =>
	`${appName}-route-${uniqueConfigKey}`;

export const getUnsupportedCaddyDomainFieldMessages = (domain: Domain) => {
	const messages: string[] = [];
	if (domain.customEntrypoint) {
		messages.push("custom entrypoints are not supported by Caddy routes");
	}
	if (domain.customCertResolver) {
		messages.push("custom certificate resolvers are Traefik-specific");
	}
	if (domain.certificateType === "custom") {
		messages.push("custom certificates are not translated to Caddy yet");
	}
	if (domain.middlewares?.length) {
		messages.push("Traefik middlewares are not translated to Caddy yet");
	}
	return messages;
};

export const assertCaddyDomainSupported = (domain: Domain) => {
	const messages = getUnsupportedCaddyDomainFieldMessages(domain);
	if (messages.length) {
		throw new Error(
			`Domain "${domain.host}" uses unsupported Caddy fields: ${messages.join("; ")}`,
		);
	}
};

export const createCaddyApplicationRouteIntent = (
	app: ApplicationNested,
	domain: Domain,
): CaddyRouteIntent => {
	assertCaddyDomainSupported(domain);
	const publicPath = domain.path && domain.path !== "/" ? domain.path : null;
	const internalPath =
		domain.internalPath &&
		domain.internalPath !== "/" &&
		domain.internalPath !== domain.path
			? domain.internalPath
			: null;

	return {
		id: createCaddyRouteId(app.appName, domain.uniqueConfigKey),
		source: "dokploy-application",
		hosts: [toPunycode(domain.host)],
		pathPrefix: publicPath,
		https: domain.https && !domain.customEntrypoint,
		upstreams: [`http://${app.appName}:${domain.port || 80}`],
		upstreamNetwork: DOKPLOY_CADDY_NETWORK,
		transforms: {
			stripPrefix: domain.stripPath ? publicPath : null,
			addPrefix: internalPath,
		},
	};
};

export const createCaddyApplicationRouteFragment = (
	app: ApplicationNested,
	domain: Domain,
): CaddyRouteFragment => ({
	version: CADDY_FRAGMENT_VERSION,
	id: getCaddyApplicationFragmentId(app.appName, domain.uniqueConfigKey),
	source: "dokploy-application",
	description: `Dokploy application route for ${app.appName}:${domain.uniqueConfigKey}`,
	routes: [createCaddyApplicationRouteIntent(app, domain)],
});

const getLocalLetsEncryptEmail = async (serverId?: string | null) => {
	if (serverId) return null;
	const settings = await getWebServerSettings();
	return settings?.letsEncryptEmail;
};

export const manageCaddyDomain = async (
	app: ApplicationNested,
	domain: Domain,
) => {
	const serverId = app.serverId || undefined;
	const options = { serverId };
	const previousFragments = await readCaddyRouteFragments(options);
	try {
		await writeCaddyRouteFragment(
			createCaddyApplicationRouteFragment(app, domain),
			options,
		);
		await compileWriteAndReloadCaddyConfigSafely({
			serverId,
			letsEncryptEmail: await getLocalLetsEncryptEmail(serverId),
		});
	} catch (error) {
		await restoreCaddyRouteFragments(previousFragments, options);
		throw error;
	}
};

export const removeCaddyDomain = async (
	app: ApplicationNested,
	uniqueConfigKey: number,
) => {
	const serverId = app.serverId || undefined;
	const options = { serverId };
	const previousFragments = await readCaddyRouteFragments(options);
	try {
		await removeCaddyRouteFragment(
			getCaddyApplicationFragmentId(app.appName, uniqueConfigKey),
			options,
		);
		await compileWriteAndReloadCaddyConfigSafely({
			serverId,
			letsEncryptEmail: await getLocalLetsEncryptEmail(serverId),
		});
	} catch (error) {
		await restoreCaddyRouteFragments(previousFragments, options);
		throw error;
	}
};
