import { paths } from "@dokploy/server/constants";
import type { WebServerProvider } from "./providers";

export type WebServerPaths = {
	provider: WebServerProvider;
	/** Root directory owned by the active web server. */
	basePath: string;
	/** Main (static) configuration file of the web server. */
	activeConfigPath: string;
	/** Directory containing the per-app generated route fragments. */
	fragmentsPath: string;
	/** Directory containing user-provided certificates. */
	certificatesPath: string;
};

/**
 * Filesystem layout of the active web server. Centralizes the Traefik
 * directory knowledge that is currently spread across call sites.
 */
export const getWebServerPaths = (
	provider: WebServerProvider,
	isServer = false,
): WebServerPaths => {
	const resolvedPaths = paths(isServer);

	return {
		provider,
		basePath: resolvedPaths.MAIN_TRAEFIK_PATH,
		activeConfigPath: `${resolvedPaths.MAIN_TRAEFIK_PATH}/traefik.yml`,
		fragmentsPath: resolvedPaths.DYNAMIC_TRAEFIK_PATH,
		certificatesPath: resolvedPaths.CERTIFICATES_PATH,
	};
};
