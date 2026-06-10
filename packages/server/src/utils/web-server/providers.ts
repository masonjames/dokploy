/**
 * Provider-neutral web-server abstraction.
 *
 * Traefik is currently the only implementation. Every call site that needs
 * to know which edge proxy is active should go through this module (and
 * `resolveWebServerProvider` in `services/web-server-settings`) instead of
 * hardcoding Traefik, so additional providers can be added behind this seam
 * without touching call sites again.
 */
export const WEB_SERVER_PROVIDERS = ["traefik"] as const;

export type WebServerProvider = (typeof WEB_SERVER_PROVIDERS)[number];

export const DEFAULT_WEB_SERVER_PROVIDER: WebServerProvider = "traefik";

export const isWebServerProvider = (
	provider: unknown,
): provider is WebServerProvider =>
	typeof provider === "string" &&
	WEB_SERVER_PROVIDERS.includes(provider as WebServerProvider);

export const normalizeWebServerProvider = (
	provider: unknown,
): WebServerProvider =>
	isWebServerProvider(provider) ? provider : DEFAULT_WEB_SERVER_PROVIDER;

/** Docker container / swarm service name of the edge proxy per provider. */
const WEB_SERVER_RESOURCE_NAMES: Record<WebServerProvider, string> = {
	traefik: "dokploy-traefik",
};

export const getWebServerResourceName = (provider: WebServerProvider) =>
	WEB_SERVER_RESOURCE_NAMES[provider];
