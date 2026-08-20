import fs, { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { network, patch } from "@dokploy/server/db/schema";
import type { Compose } from "@dokploy/server/services/compose";
import type { Domain } from "@dokploy/server/services/domain";
import { resolveWebServerProvider } from "@dokploy/server/services/web-server-settings";
import { eq, inArray } from "drizzle-orm";
import { quote } from "shell-quote";
import { parse, stringify } from "yaml";
import { writeCaddyComposeRouteFragments } from "../caddy/compose";
import { assertCaddyDomainSupported } from "../caddy/domain";
import { getCaddyComposeNetworkAlias } from "../caddy/upstream-targets";
import { execAsyncRemote } from "../process/execAsync";
import { cloneBitbucketRepository } from "../providers/bitbucket";
import { cloneGitRepository } from "../providers/git";
import { cloneGiteaRepository } from "../providers/gitea";
import { cloneGithubRepository } from "../providers/github";
import { cloneGitlabRepository } from "../providers/gitlab";
import { getCreateComposeFileCommand } from "../providers/raw";
import type { WebServerProvider } from "../web-server/providers";
import { randomizeDeployableSpecificationFile } from "./collision";
import { randomizeSpecificationFile } from "./compose";
import type {
	ComposeSpecification,
	DefinitionsService,
	ListOrDict,
	PropertiesNetworks,
} from "./types";
import { encodeBase64 } from "./utils";

export const cloneCompose = async (compose: Compose) => {
	let command = "set -e;";
	const entity = {
		...compose,
		type: "compose" as const,
	};
	if (compose.sourceType === "github") {
		command += await cloneGithubRepository(entity);
	} else if (compose.sourceType === "gitlab") {
		command += await cloneGitlabRepository(entity);
	} else if (compose.sourceType === "bitbucket") {
		command += await cloneBitbucketRepository(entity);
	} else if (compose.sourceType === "git") {
		command += await cloneGitRepository(entity);
	} else if (compose.sourceType === "gitea") {
		command += await cloneGiteaRepository(entity);
	} else if (compose.sourceType === "raw") {
		command += getCreateComposeFileCommand(compose);
	}
	return command;
};

export const getComposePath = (compose: Compose) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { appName, sourceType, composePath } = compose;
	let path = "";

	if (sourceType === "raw") {
		path = "docker-compose.yml";
	} else {
		path = composePath;
	}

	return join(COMPOSE_PATH, appName, "code", path);
};

export const loadDockerCompose = async (
	compose: Compose,
): Promise<ComposeSpecification | null> => {
	const path = getComposePath(compose);

	if (existsSync(path)) {
		const yamlStr = readFileSync(path, "utf8");
		const parsedConfig = parse(yamlStr, {
			maxAliasCount: 10000,
		}) as ComposeSpecification;
		return parsedConfig;
	}
	return null;
};

export const loadDockerComposeRemote = async (
	compose: Compose,
): Promise<ComposeSpecification | null> => {
	const path = getComposePath(compose);
	try {
		if (!compose.serverId) {
			return null;
		}
		const { stdout, stderr } = await execAsyncRemote(
			compose.serverId,
			`cat ${path}`,
		);

		if (stderr) {
			return null;
		}
		if (!stdout) return null;
		const parsedConfig = parse(stdout, {
			maxAliasCount: 10000,
		}) as ComposeSpecification;
		return parsedConfig;
	} catch {
		return null;
	}
};

export const readComposeFile = async (compose: Compose) => {
	const path = getComposePath(compose);
	if (existsSync(path)) {
		const yamlStr = readFileSync(path, "utf8");
		return yamlStr;
	}
	return null;
};

export type CaddyComposeRouteTarget = {
	domain: Domain;
	finalServiceName: string;
};

const loadComposeSpecification = async (compose: Compose) => {
	if (compose.serverId) {
		return loadDockerComposeRemote(compose);
	}
	return loadDockerCompose(compose);
};

const finalizeComposeSpecification = (
	compose: Compose,
	composeSpec: ComposeSpecification,
) => {
	let result = composeSpec;

	if (compose.isolatedDeployment) {
		result = randomizeDeployableSpecificationFile(
			result,
			compose.isolatedDeploymentsVolume,
			compose.suffix || compose.appName,
		);
	} else if (compose.randomize) {
		result = randomizeSpecificationFile(result, compose.suffix);
	}

	return result;
};

const resolveFinalServiceName = (
	compose: Compose,
	composeSpec: ComposeSpecification,
	serviceName: string,
) => {
	if (composeSpec.services?.[serviceName]) {
		return serviceName;
	}

	const suffix = compose.randomize
		? compose.suffix
		: compose.isolatedDeployment
			? compose.suffix || compose.appName
			: null;
	if (suffix) {
		const suffixedServiceName = `${serviceName}-${suffix}`;
		if (composeSpec.services?.[suffixedServiceName]) {
			return suffixedServiceName;
		}
	}

	return serviceName;
};

const addDomainToComposeForCaddyWithRoutes = async (
	compose: Compose,
	domains: Domain[],
): Promise<{
	composeSpec: ComposeSpecification | null;
	caddyRouteTargets: CaddyComposeRouteTarget[];
}> => {
	const result = await loadComposeSpecification(compose);
	if (!result) {
		return { composeSpec: null, caddyRouteTargets: [] };
	}

	for (const domain of domains) {
		assertCaddyDomainSupported(domain);
	}

	const finalizedCompose = finalizeComposeSpecification(compose, result);
	const caddyRouteTargets: CaddyComposeRouteTarget[] = [];

	for (const domain of domains) {
		const { serviceName } = domain;
		if (!serviceName) {
			throw new Error(`Domain "${domain.host}" is missing a service name`);
		}

		const finalServiceName = resolveFinalServiceName(
			compose,
			finalizedCompose,
			serviceName,
		);
		if (!finalizedCompose.services?.[finalServiceName]) {
			throw new Error(
				`Domain "${domain.host}" is attached to service "${serviceName}" which does not exist in the compose`,
			);
		}

		const service = finalizedCompose.services[finalServiceName];
		if (compose.composeType === "docker-compose") {
			if (service.labels) {
				service.labels = removeDokployGeneratedTraefikLabels(service.labels, {
					appName: compose.appName,
					domains,
				});
			}
		} else if (service.deploy?.labels) {
			service.deploy.labels = removeDokployGeneratedTraefikLabels(
				service.deploy.labels,
				{
					appName: compose.appName,
					domains,
				},
			);
		}

		if (!compose.isolatedDeployment) {
			service.networks = addDokployNetworkToService(service.networks, {
				aliases:
					compose.composeType === "docker-compose"
						? [getCaddyComposeNetworkAlias(compose.appName, finalServiceName)]
						: undefined,
			});
		}

		caddyRouteTargets.push({ domain, finalServiceName });
	}

	if (!compose.isolatedDeployment) {
		finalizedCompose.networks = addDokployNetworkToRoot(
			finalizedCompose.networks,
		);
	}

	return { composeSpec: finalizedCompose, caddyRouteTargets };
};

export const getCaddyComposeRouteTargetsForWebServer = async (
	compose: Compose,
	domains: Domain[],
	provider?: WebServerProvider,
) => {
	const resolvedProvider =
		provider ?? (await resolveWebServerProvider(compose.serverId));
	if (resolvedProvider !== "caddy") {
		return null;
	}

	return (await addDomainToComposeForCaddyWithRoutes(compose, domains))
		.caddyRouteTargets;
};

export const writeCaddyComposeRoutesForTargets = async (
	compose: Compose,
	caddyRouteTargets: CaddyComposeRouteTarget[],
	options: {
		organizationId?: string | null;
	} = {},
) => {
	await writeCaddyComposeRouteFragments(compose, caddyRouteTargets, options);
};

export const addDomainToComposeForWebServer = async (
	compose: Compose,
	domains: Domain[],
	provider?: WebServerProvider,
) => {
	const resolvedProvider =
		provider ?? (await resolveWebServerProvider(compose.serverId));
	if (resolvedProvider === "caddy") {
		return (await addDomainToComposeForCaddyWithRoutes(compose, domains))
			.composeSpec;
	}

	return addDomainToCompose(compose, domains);
};

export const writeDomainsToCompose = async (
	compose: Compose,
	domains: Domain[],
) => {
	try {
		const provider = await resolveWebServerProvider(compose.serverId);
		const composeConverted =
			provider === "caddy"
				? (await addDomainToComposeForCaddyWithRoutes(compose, domains))
						.composeSpec
				: await addDomainToCompose(compose, domains);
		const path = getComposePath(compose);

		if (!composeConverted) {
			return `
echo "❌ Error: Compose file not found";
exit 1;
			`;
		}

		const composeString = stringify(composeConverted, { lineWidth: 1000 });
		const encodedContent = encodeBase64(composeString);
		return `echo "${encodedContent}" | base64 -d > "${path}";`;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : String(error ?? "");
		// The error message embeds user-controlled fields (e.g. serviceName) and is
		// executed as part of the compose build shell script, so it must be escaped.
		return `echo ${quote([`❌ Has occurred an error: ${message}`])};
exit 1;
		`;
	}
};
export const applyComposeFilePatch = async (
	compose: Compose,
): Promise<ComposeSpecification | null> => {
	if (compose.sourceType === "raw") {
		return null;
	}

	const composePatches = await db.query.patch.findMany({
		where: eq(patch.composeId, compose.composeId),
	});

	const composeFilePatch = composePatches.find(
		(p) =>
			p.enabled &&
			p.type !== "delete" &&
			join(p.filePath) === join(compose.composePath),
	);

	if (!composeFilePatch?.content) {
		return null;
	}

	try {
		const parsed = parse(composeFilePatch.content, {
			maxAliasCount: 10000,
		}) as ComposeSpecification;
		return parsed ?? null;
	} catch {
		return null;
	}
};

const removeDomainLabels = (
	labels: DefinitionsService["labels"],
	appName: string,
	uniqueConfigKey: number,
) => {
	const prefixes = [
		`traefik.http.routers.${appName}-${uniqueConfigKey}-`,
		`traefik.http.services.${appName}-${uniqueConfigKey}-`,
		`traefik.http.middlewares.stripprefix-${appName}-${uniqueConfigKey}.`,
		`traefik.http.middlewares.addprefix-${appName}-${uniqueConfigKey}.`,
	];
	const belongsToDomain = (label: string) =>
		prefixes.some((prefix) => label.startsWith(prefix));

	if (Array.isArray(labels)) {
		return labels.filter((label) => !belongsToDomain(label));
	}
	if (labels) {
		return Object.fromEntries(
			Object.entries(labels).filter(([label]) => !belongsToDomain(label)),
		);
	}

	return labels;
};

export const addDomainToCompose = async (
	compose: Compose,
	domains: Domain[],
) => {
	const { appName } = compose;

	let result: ComposeSpecification | null;

	if (compose.sourceType === "raw") {
		result = parse(compose.composeFile, {
			maxAliasCount: 10000,
		}) as ComposeSpecification;
	} else if (compose.serverId) {
		result = await loadDockerComposeRemote(compose);
	} else {
		result = await loadDockerCompose(compose);
	}

	if (!result) {
		return null;
	}

	result = (await applyComposeFilePatch(compose)) ?? result;

	if (compose.isolatedDeployment) {
		const randomized = randomizeDeployableSpecificationFile(
			result,
			compose.isolatedDeploymentsVolume,
			compose.suffix || compose.appName,
		);
		result = randomized;
	} else if (compose.randomize) {
		const randomized = randomizeSpecificationFile(result, compose.suffix);
		result = randomized;
	}

	for (const domain of domains) {
		for (const service of Object.values(result.services ?? {})) {
			if (compose.composeType === "docker-compose") {
				service.labels = removeDomainLabels(
					service.labels,
					appName,
					domain.uniqueConfigKey,
				);
			} else if (service.deploy) {
				service.deploy.labels = removeDomainLabels(
					service.deploy.labels,
					appName,
					domain.uniqueConfigKey,
				);
			}
		}
	}

	for (const domain of domains.filter((d) => d.enabled)) {
		const { serviceName, https } = domain;
		if (!serviceName) {
			throw new Error(`Domain "${domain.host}" is missing a service name`);
		}
		if (!result?.services?.[serviceName]) {
			throw new Error(
				`Domain "${domain.host}" is attached to service "${serviceName}" which does not exist in the compose`,
			);
		}

		const httpLabels = createDomainLabels(
			appName,
			domain,
			domain.customEntrypoint || "web",
		);
		if (!domain.customEntrypoint && https) {
			const httpsLabels = createDomainLabels(appName, domain, "websecure");
			httpLabels.push(...httpsLabels);
		}

		let labels: DefinitionsService["labels"] = [];
		if (compose.composeType === "docker-compose") {
			if (!result.services[serviceName].labels) {
				result.services[serviceName].labels = [];
			}

			labels = result.services[serviceName].labels;
		} else {
			// Stack Case
			if (!result.services[serviceName].deploy) {
				result.services[serviceName].deploy = {};
			}
			if (!result.services[serviceName].deploy.labels) {
				result.services[serviceName].deploy.labels = [];
			}

			labels = result.services[serviceName].deploy.labels;
		}

		const networkLabel =
			compose.composeType === "docker-compose"
				? "traefik.docker.network"
				: "traefik.swarm.network";
		const networkName = compose.isolatedDeployment
			? compose.suffix || compose.appName
			: "dokploy-network";

		if (Array.isArray(labels)) {
			if (!labels.includes("traefik.enable=true")) {
				labels.unshift("traefik.enable=true");
			}
			labels.unshift(...httpLabels);
			const networkLabelEntry = `${networkLabel}=${networkName}`;
			if (!labels.includes(networkLabelEntry)) {
				labels.unshift(networkLabelEntry);
			}
		} else if (labels) {
			labels["traefik.enable"] = "true";
			labels[networkLabel] = networkName;
			for (const label of httpLabels) {
				const separatorIndex = label.indexOf("=");
				labels[label.slice(0, separatorIndex)] = label.slice(
					separatorIndex + 1,
				);
			}
		}

		if (!compose.isolatedDeployment) {
			// Add the dokploy-network to the service
			result.services[serviceName].networks = addDokployNetworkToService(
				result.services[serviceName].networks,
			);
		}
	}

	const injectedNetworkNames = await applyServiceNetworks(result, compose);

	if (!compose.isolatedDeployment) {
		declareUsedNetworksInRoot(result, injectedNetworkNames);
	}

	return result;
};

export const applyServiceNetworks = async (
	result: ComposeSpecification,
	compose: Compose,
) => {
	const injectedNetworkNames = new Set<string>();
	const serviceNetworks = compose.serviceNetworks ?? [];
	if (serviceNetworks.length === 0) return injectedNetworkNames;

	const allNetworkIds = [
		...new Set(serviceNetworks.flatMap((s) => s.networkIds)),
	];
	const networks =
		allNetworkIds.length > 0
			? await db.query.network.findMany({
					where: inArray(network.networkId, allNetworkIds),
				})
			: [];

	for (const config of serviceNetworks) {
		const service = result.services?.[config.serviceName];
		if (!service) continue;

		for (const networkId of config.networkIds) {
			const match = networks.find((n) => n.networkId === networkId);
			if (!match) continue;
			service.networks = addDokployNetworkToService(
				service.networks,
				match.name,
			);
			injectedNetworkNames.add(match.name);
		}

		if (config.detachDokployNetwork) {
			removeNetworkFromService(service, "dokploy-network");
			removeNetworkFromService(service, "default");
			removeDokployNetworkLabel(service);
		}
	}

	return injectedNetworkNames;
};

export const declareUsedNetworksInRoot = (
	result: ComposeSpecification,
	injectedNetworkNames: Set<string>,
) => {
	const isUsed = (name: string) =>
		Object.values(result.services ?? {}).some((service) => {
			const nets = service?.networks;
			if (Array.isArray(nets)) return nets.includes(name);
			if (nets && typeof nets === "object") return name in nets;
			return false;
		});

	if (isUsed("dokploy-network")) {
		result.networks = addDokployNetworkToRoot(result.networks);
	}
	for (const name of injectedNetworkNames) {
		if (isUsed(name)) {
			result.networks = addDokployNetworkToRoot(result.networks, name);
		}
	}
};

export const writeComposeFile = async (
	compose: Compose,
	composeSpec: ComposeSpecification,
) => {
	const path = getComposePath(compose);

	try {
		const composeFile = stringify(composeSpec, {
			lineWidth: 1000,
		});
		fs.writeFileSync(path, composeFile, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const createDomainLabels = (
	appName: string,
	domain: Domain,
	entrypoint: string,
) => {
	const {
		host,
		port,
		customEntrypoint,
		https,
		uniqueConfigKey,
		certificateType,
		path,
		customCertResolver,
		stripPath,
		internalPath,
	} = domain;
	const routerName = `${appName}-${uniqueConfigKey}-${entrypoint}`;
	const labels = [
		`traefik.http.routers.${routerName}.rule=Host(\`${host}\`)${path && path !== "/" ? ` && PathPrefix(\`${path}\`)` : ""}`,
		`traefik.http.routers.${routerName}.entrypoints=${entrypoint}`,
		`traefik.http.services.${routerName}.loadbalancer.server.port=${port}`,
		`traefik.http.routers.${routerName}.service=${routerName}`,
	];

	// Collect middlewares for this router
	const middlewares: string[] = [];
	const isRedirectRouter = entrypoint === "web" && https && !customEntrypoint;

	// Web router with HTTPS only needs redirect — all other middlewares
	// run on the websecure router where the request actually lands.
	if (isRedirectRouter) {
		middlewares.push("redirect-to-https@file");
	}

	// Add stripPath middleware if needed
	if (stripPath && path && path !== "/") {
		const middlewareName = `stripprefix-${appName}-${uniqueConfigKey}`;
		// Define middleware on web (or custom) entrypoint so Traefik registers it
		if (entrypoint === "web" || customEntrypoint) {
			labels.push(
				`traefik.http.middlewares.${middlewareName}.stripprefix.prefixes=${path}`,
			);
		}
		if (!isRedirectRouter) {
			middlewares.push(middlewareName);
		}
	}

	// Add internalPath middleware if needed
	if (internalPath && internalPath !== "/" && internalPath.startsWith("/")) {
		const middlewareName = `addprefix-${appName}-${uniqueConfigKey}`;
		// Define middleware on web (or custom) entrypoint so Traefik registers it
		if (entrypoint === "web" || customEntrypoint) {
			labels.push(
				`traefik.http.middlewares.${middlewareName}.addprefix.prefix=${internalPath}`,
			);
		}
		if (!isRedirectRouter) {
			middlewares.push(middlewareName);
		}
	}

	// Add custom middlewares (skip for redirect-only router)
	if (!isRedirectRouter && domain.middlewares?.length) {
		middlewares.push(...domain.middlewares);
	}

	// Apply middlewares to router if any exist
	if (middlewares.length > 0) {
		labels.push(
			`traefik.http.routers.${routerName}.middlewares=${middlewares.join(",")}`,
		);
	}

	// Add TLS configuration for websecure
	if (entrypoint === "websecure" || (customEntrypoint && https)) {
		if (certificateType === "letsencrypt") {
			labels.push(
				`traefik.http.routers.${routerName}.tls.certresolver=letsencrypt`,
			);
		} else if (certificateType === "custom" && customCertResolver) {
			labels.push(
				`traefik.http.routers.${routerName}.tls.certresolver=${customCertResolver}`,
			);
		} else if (certificateType === "none" && https) {
			// No cert resolver, but HTTPS is enabled (default/custom certificate):
			// explicitly enable TLS so Traefik serves the router over HTTPS.
			labels.push(`traefik.http.routers.${routerName}.tls=true`);
		}
	}

	return labels;
};

export type DokployTraefikLabelClassifierContext = {
	appName?: string;
	domains?: Pick<Domain, "uniqueConfigKey" | "customEntrypoint" | "https">[];
	includeGenericLabels?: boolean;
};

const getLabelKey = (label: string) => label.split("=")[0] ?? label;

const getLabelValue = (label: string) => {
	const separatorIndex = label.indexOf("=");
	return separatorIndex === -1 ? undefined : label.slice(separatorIndex + 1);
};

const getDomainEntrypoints = (
	domain: Pick<Domain, "customEntrypoint" | "https">,
) => {
	if (domain.customEntrypoint) {
		return [domain.customEntrypoint];
	}
	return domain.https ? ["web", "websecure"] : ["web"];
};

const isGenericDokployTraefikLabel = (label: string) => {
	const key = getLabelKey(label);
	const value = getLabelValue(label);

	if (key === "traefik.enable") {
		return value === undefined || value === "true";
	}

	if (key === "traefik.docker.network" || key === "traefik.swarm.network") {
		return value === undefined || value === "dokploy-network";
	}

	return false;
};

const isDomainSpecificDokployTraefikLabel = (
	label: string,
	context: DokployTraefikLabelClassifierContext = {},
) => {
	const key = getLabelKey(label);
	const { appName, domains } = context;

	if (appName && domains) {
		for (const domain of domains) {
			for (const entrypoint of getDomainEntrypoints(domain)) {
				const routerName = `${appName}-${domain.uniqueConfigKey}-${entrypoint}`;
				if (
					key.startsWith(`traefik.http.routers.${routerName}.`) ||
					key.startsWith(`traefik.http.services.${routerName}.`)
				) {
					return true;
				}
			}

			if (
				key.startsWith(
					`traefik.http.middlewares.stripprefix-${appName}-${domain.uniqueConfigKey}.`,
				) ||
				key.startsWith(
					`traefik.http.middlewares.addprefix-${appName}-${domain.uniqueConfigKey}.`,
				)
			) {
				return true;
			}
		}

		return false;
	}

	if (appName) {
		const appRouterPattern = new RegExp(
			`^traefik\\.http\\.(routers|services)\\.${appName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}.+-(web|websecure)\\.`,
		);
		if (appRouterPattern.test(key)) {
			return true;
		}
	}

	return (
		/^traefik\.http\.(routers|services)\.[^.]+-\d+-[^.]+\./.test(key) ||
		/^traefik\.http\.middlewares\.(stripprefix|addprefix)-.+-\d+\./.test(key)
	);
};

export const isDokployGeneratedTraefikLabel = (
	label: string,
	context: DokployTraefikLabelClassifierContext = {},
) => {
	return (
		isDomainSpecificDokployTraefikLabel(label, context) ||
		(context.includeGenericLabels !== false &&
			isGenericDokployTraefikLabel(label))
	);
};

const stringifyLabelObjectEntry = (
	key: string,
	value: string | number | boolean | null,
) => (value === null ? key : `${key}=${value}`);

export const removeDokployGeneratedTraefikLabels = (
	labels: ListOrDict | undefined,
	context: DokployTraefikLabelClassifierContext = {},
): ListOrDict | undefined => {
	if (!labels) {
		return labels;
	}

	if (Array.isArray(labels)) {
		const removedSpecificLabel = labels.some((label) =>
			isDomainSpecificDokployTraefikLabel(label, context),
		);
		return labels.filter((label) => {
			if (isDomainSpecificDokployTraefikLabel(label, context)) {
				return false;
			}
			if (removedSpecificLabel && isGenericDokployTraefikLabel(label)) {
				return false;
			}
			return true;
		});
	}

	const entries = Object.entries(labels);
	const removedSpecificLabel = entries.some(([key, value]) =>
		isDomainSpecificDokployTraefikLabel(
			stringifyLabelObjectEntry(key, value),
			context,
		),
	);

	return Object.fromEntries(
		entries.filter(([key, value]) => {
			const label = stringifyLabelObjectEntry(key, value);
			if (isDomainSpecificDokployTraefikLabel(label, context)) {
				return false;
			}
			if (removedSpecificLabel && isGenericDokployTraefikLabel(label)) {
				return false;
			}
			return true;
		}),
	);
};

export const addDokployNetworkToService = (
	networkService: DefinitionsService["networks"],
	networkNameOrOptions:
		| string
		| { aliases?: string[]; networkName?: string } = {},
) => {
	let networks = networkService;
	const options =
		typeof networkNameOrOptions === "string" ? {} : networkNameOrOptions;
	const networkName =
		typeof networkNameOrOptions === "string"
			? networkNameOrOptions
			: (networkNameOrOptions.networkName ?? "dokploy-network");
	const network = networkName;
	const defaultNetwork = "default";
	if (!networks) {
		networks = [];
	}

	if (Array.isArray(networks)) {
		if (!networks.includes(network)) {
			networks.push(network);
		}
		if (!networks.includes(defaultNetwork)) {
			networks.push(defaultNetwork);
		}
		if (options.aliases?.length) {
			const nextNetworks: Record<string, { aliases?: string[] }> = {};
			for (const item of networks) {
				nextNetworks[item] = {};
			}
			nextNetworks[network] = {
				...nextNetworks[network],
				aliases: [...new Set(options.aliases)],
			};
			networks = nextNetworks;
		}
	} else if (networks && typeof networks === "object") {
		if (!(network in networks)) {
			networks[network] = {};
		}
		if (!(defaultNetwork in networks)) {
			networks[defaultNetwork] = {};
		}
		if (options.aliases?.length) {
			const current = networks[network];
			const currentAliases =
				current && typeof current === "object" && "aliases" in current
					? ((current.aliases as string[] | undefined) ?? [])
					: [];
			networks[network] = {
				...(current && typeof current === "object" ? current : {}),
				aliases: [...new Set([...currentAliases, ...options.aliases])],
			};
		}
	}

	return networks;
};

export const removeNetworkFromService = (
	service: DefinitionsService,
	networkName: string,
) => {
	const networks = service.networks;
	if (Array.isArray(networks)) {
		service.networks = networks.filter((n) => n !== networkName);
	} else if (networks && typeof networks === "object") {
		delete networks[networkName];
	}
};

const removeDokployNetworkLabel = (service: DefinitionsService) => {
	const stripped = (labels: DefinitionsService["labels"]) => {
		if (Array.isArray(labels)) {
			return labels.filter(
				(l) =>
					l !== "traefik.docker.network=dokploy-network" &&
					l !== "traefik.swarm.network=dokploy-network",
			);
		}
		return labels;
	};
	if (service.labels) service.labels = stripped(service.labels);
	if (service.deploy?.labels)
		service.deploy.labels = stripped(service.deploy.labels);
};

export const addDokployNetworkToRoot = (
	networkRoot: PropertiesNetworks | undefined,
	networkName = "dokploy-network",
) => {
	let networks = networkRoot;
	const network = networkName;

	if (!networks) {
		networks = {};
	}

	if (networks[network] || !networks[network]) {
		networks[network] = {
			external: true,
		};
	}

	return networks;
};
