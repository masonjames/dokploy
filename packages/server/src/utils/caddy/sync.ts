import { IS_CLOUD } from "@dokploy/server/constants";
import type { Domain } from "@dokploy/server/services/domain";
import type { Redirect } from "@dokploy/server/services/redirect";
import { getWebServerProvider } from "@dokploy/server/services/web-server-settings";
import type { CaddyState } from "./caddyfile";

export const CADDY_CONTAINER = "dokploy-caddy";
// The stock image, pinned: the renderer is tested against this version.
export const CADDY_IMAGE = "caddy:2.11.4";

interface CaddySyncState {
	tail: Map<string, Promise<unknown>>;
	waiting: Map<string, Promise<void>>;
	forced: Set<string>;
	// The Caddyfile each server's Caddy last accepted.
	applied: Map<string, string>;
}

// The custom server and Next.js each load their own copy of this module, so
// the state is shared through globalThis, like the deployment queue's.
const globalForCaddy = globalThis as unknown as {
	__dokployCaddySync?: CaddySyncState;
};

globalForCaddy.__dokployCaddySync ??= {
	tail: new Map(),
	waiting: new Map(),
	forced: new Set(),
	applied: new Map(),
};

const state = globalForCaddy.__dokployCaddySync;

const queueKey = (serverId?: string | null) => serverId ?? "dokploy";

/**
 * Runs tasks for one server one at a time. The provider switch goes through
 * here too, so a sync can never interleave with it.
 */
export const withCaddyQueue = <T>(
	serverId: string | null | undefined,
	task: () => Promise<T>,
) => {
	const key = queueKey(serverId);
	const run = (state.tail.get(key) ?? Promise.resolve()).then(task);
	const tail = run
		.catch(() => {})
		.finally(() => {
			if (state.tail.get(key) === tail) state.tail.delete(key);
		});
	state.tail.set(key, tail);
	return run;
};

/**
 * Brings a server's Caddy in line with the database. Every caller gets an
 * apply that starts after its own call, and callers that arrive together
 * share one. Does nothing for a server on Traefik. Rejects with Caddy's own
 * message when it refuses the configuration; Caddy then keeps serving the
 * previous one.
 */
export const syncCaddy = async (serverId?: string | null, force = false) => {
	if (IS_CLOUD || (await getWebServerProvider(serverId)) !== "caddy") return;
	const key = queueKey(serverId);
	if (force) state.forced.add(key);
	let waiting = state.waiting.get(key);
	if (!waiting) {
		waiting = withCaddyQueue(serverId, () => {
			state.waiting.delete(key);
			return applyCaddy(serverId, state.forced.delete(key));
		});
		state.waiting.set(key, waiting);
	}
	return waiting;
};

/**
 * For deploys, deletions and bulk operations, which must not fail or wait
 * because of the proxy. Never throws and never rejects.
 */
export const syncCaddyInBackground = (serverId?: string | null) =>
	void syncCaddy(serverId).catch((error) =>
		console.error("Caddy sync failed:", error),
	);

export const loadCaddyState = async (
	_serverId?: string | null,
): Promise<CaddyState> => {
	throw new Error("not implemented");
};

export const applyCaddy = async (
	_serverId?: string | null,
	_force = false,
): Promise<void> => {
	throw new Error("not implemented");
};

/**
 * What a domain uses that only Traefik can provide, phrased to be followed by
 * "is not available with Caddy".
 */
export const caddyUnsupported = (
	domain: Partial<
		Pick<
			Domain,
			| "forwardAuthEnabled"
			| "middlewares"
			| "customEntrypoint"
			| "certificateType"
		>
	>,
) => {
	if (domain.forwardAuthEnabled) return "Forward auth";
	if (domain.middlewares?.length) return "A custom middleware";
	if (domain.customEntrypoint) return "A custom entrypoint";
	if (domain.certificateType === "custom") {
		return "A custom certificate resolver";
	}
	return null;
};

/**
 * Refuses a domain setting Caddy cannot honour on a server that runs Caddy,
 * instead of saving it and serving the domain without it.
 */
export const assertCaddySupports = async (
	serverId: string | null | undefined,
	domain: Parameters<typeof caddyUnsupported>[0],
) => {
	const reason = caddyUnsupported(domain);
	if (reason && (await getWebServerProvider(serverId)) === "caddy") {
		throw new Error(`${reason} is not available with Caddy`);
	}
};

/**
 * Has the running Caddy compile a redirect before it is saved. One pattern Go
 * cannot compile would otherwise make Caddy reject every later change on the
 * server. Does nothing for a server on Traefik.
 */
export const assertCaddyAcceptsRedirect = async (
	_serverId: string | null | undefined,
	_redirect: Pick<Redirect, "regex" | "replacement" | "permanent">,
): Promise<void> => {
	throw new Error("not implemented");
};
