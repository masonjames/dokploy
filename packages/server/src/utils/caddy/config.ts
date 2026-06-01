import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { paths } from "@dokploy/server/constants";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { quote } from "shell-quote";
import type {
	CaddyCompileOptions,
	CaddyFragmentStoreOptions,
	CaddyHeaderMap,
	CaddyJsonObject,
	CaddyRouteFragment,
	CaddyRouteIntent,
} from "./types";

const CADDY_FRAGMENT_VERSION = 1;
const CADDY_VERSION = process.env.CADDY_VERSION || "2.11.3";

const assertSafeFragmentId = (id: string) => {
	if (
		!/^[a-zA-Z0-9_.-]+$/.test(id) ||
		id === "." ||
		id === ".." ||
		id.split(".").some((segment) => segment === "")
	) {
		throw new Error(
			`Invalid Caddy fragment id "${id}". Use letters, numbers, dash, underscore, or dot only; dot path segments are not allowed.`,
		);
	}
};

const assertPathWithinBase = (basePath: string, targetPath: string) => {
	const resolvedBase = path.resolve(basePath);
	const resolvedTarget = path.resolve(targetPath);
	if (
		resolvedTarget !== resolvedBase &&
		!resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)
	) {
		throw new Error(`Resolved path "${targetPath}" escapes "${basePath}"`);
	}
};

export const getCaddyFragmentFilePath = (
	fragmentId: string,
	isServer = false,
) => {
	assertSafeFragmentId(fragmentId);
	const fragmentsPath = paths(isServer).CADDY_FRAGMENTS_PATH;
	const filePath = path.join(fragmentsPath, `${fragmentId}.json`);
	assertPathWithinBase(fragmentsPath, filePath);
	return filePath;
};

export const getCaddyActiveConfigPath = (isServer = false) => {
	return paths(isServer).CADDY_CONFIG_PATH;
};

export const validateCaddyRouteIntent = (route: CaddyRouteIntent) => {
	if (!route.id) {
		throw new Error("Caddy route intent requires an id");
	}
	if (!route.hosts.length) {
		throw new Error(`Caddy route "${route.id}" requires at least one host`);
	}
	if (
		!route.upstreams.length &&
		!route.redirectScheme &&
		!route.staticResponse
	) {
		throw new Error(`Caddy route "${route.id}" requires at least one upstream`);
	}
	if (route.staticResponse) {
		const statusCode = route.staticResponse.statusCode;
		if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
			throw new Error(
				`Caddy route "${route.id}" has invalid static response status code`,
			);
		}
	}
	for (const upstream of route.upstreams) {
		if (!upstream.trim()) {
			throw new Error(`Caddy route "${route.id}" has an empty upstream`);
		}
		try {
			parseCaddyUpstream(upstream);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "invalid upstream format";
			throw new Error(
				`Caddy route "${route.id}" has invalid upstream "${upstream}": ${message}`,
			);
		}
	}
};

export const validateCaddyRouteFragment = (fragment: CaddyRouteFragment) => {
	assertSafeFragmentId(fragment.id);
	if (fragment.version !== CADDY_FRAGMENT_VERSION) {
		throw new Error(
			`Unsupported Caddy fragment version for "${fragment.id}": ${fragment.version}`,
		);
	}
	for (const route of fragment.routes) {
		validateCaddyRouteIntent(route);
	}
};

const normalizePathPrefix = (prefix?: string | null) => {
	if (!prefix || prefix === "/") {
		return undefined;
	}
	return prefix.startsWith("/") ? prefix : `/${prefix}`;
};

const normalizeExactPath = (exactPath?: string | null) => {
	if (!exactPath) {
		return undefined;
	}
	return exactPath.startsWith("/") ? exactPath : `/${exactPath}`;
};

const getPathSpecificity = (route: CaddyRouteIntent) => {
	return (route.pathExact ?? route.pathPrefix ?? "").length;
};

const routeSourcePrecedence: Record<CaddyRouteIntent["source"], number> = {
	manual: 0,
	"traefik-dynamic-file": 0,
	"traefik-compose-label": 0,
	"dokploy-application": 1,
	"dokploy-compose": 1,
	"dokploy-dashboard": 1,
};

export const sortCaddyRouteIntents = (routes: CaddyRouteIntent[]) => {
	return [...routes].sort((a, b) => {
		const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
		if (priorityDiff !== 0) return priorityDiff;

		const specificityDiff = getPathSpecificity(b) - getPathSpecificity(a);
		if (specificityDiff !== 0) return specificityDiff;

		const sourcePrecedenceDiff =
			routeSourcePrecedence[a.source] - routeSourcePrecedence[b.source];
		if (sourcePrecedenceDiff !== 0) return sourcePrecedenceDiff;

		const sourceDiff = a.source.localeCompare(b.source);
		if (sourceDiff !== 0) return sourceDiff;

		return a.id.localeCompare(b.id);
	});
};

const createRouteMatcher = (route: CaddyRouteIntent) => {
	const matcher: CaddyJsonObject = {
		host: route.hosts,
	};
	const exactPath = normalizeExactPath(route.pathExact);
	const pathPrefix = normalizePathPrefix(route.pathPrefix);

	if (exactPath) {
		matcher.path = [exactPath];
	} else if (pathPrefix) {
		matcher.path = [`${pathPrefix}*`];
	}
	if (route.allowedRemoteIps?.length) {
		matcher.remote_ip = {
			ranges: route.allowedRemoteIps,
		};
	}

	return [matcher];
};

const createRouteMatcherWithoutRemoteIp = (route: CaddyRouteIntent) => {
	const { allowedRemoteIps: _allowedRemoteIps, ...unrestrictedRoute } = route;
	return createRouteMatcher(unrestrictedRoute);
};

const normalizeHeaderValues = (headers: CaddyHeaderMap) => {
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [
			name,
			Array.isArray(value) ? value : [value],
		]),
	);
};

const createHeaderHandler = (route: CaddyRouteIntent) => {
	const requestHeaders = route.transforms?.requestHeaders;
	const responseHeaders = route.transforms?.responseHeaders;
	const hasRequestHeaders =
		requestHeaders && Object.keys(requestHeaders).length > 0;
	const hasResponseHeaders =
		responseHeaders && Object.keys(responseHeaders).length > 0;
	if (!hasRequestHeaders && !hasResponseHeaders) {
		return undefined;
	}

	return {
		handler: "headers",
		...(hasRequestHeaders && {
			request: {
				set: normalizeHeaderValues(requestHeaders ?? {}),
			},
		}),
		...(hasResponseHeaders && {
			response: {
				set: normalizeHeaderValues(responseHeaders ?? {}),
			},
		}),
	};
};

const createRewriteHandlers = (route: CaddyRouteIntent) => {
	const handlers: CaddyJsonObject[] = [];
	const stripPrefix = normalizePathPrefix(route.transforms?.stripPrefix);
	const addPrefix = normalizePathPrefix(route.transforms?.addPrefix);

	if (stripPrefix) {
		handlers.push({
			handler: "rewrite",
			strip_path_prefix: stripPrefix,
		});
	}

	if (addPrefix) {
		handlers.push({
			handler: "rewrite",
			uri: `${addPrefix}{http.request.uri.path}`,
		});
	}

	return handlers;
};

const createBasicAuthHandler = (route: CaddyRouteIntent) => {
	if (!route.basicAuth?.length) {
		return undefined;
	}

	return {
		handler: "authentication",
		providers: {
			http_basic: {
				accounts: route.basicAuth.map((account) => ({
					username: account.username,
					password: account.hash,
				})),
			},
		},
	};
};

const httpUrlPrefixRegex = /^https?:\/\//i;

const stripUrlPath = (value: string) => value.split(/[/?#]/, 1)[0] ?? "";

const getAuthorityPort = (authority: string) => {
	const withoutCredentials = authority.includes("@")
		? authority.slice(authority.lastIndexOf("@") + 1)
		: authority;

	if (withoutCredentials.startsWith("[")) {
		const closingBracketIndex = withoutCredentials.indexOf("]");
		if (closingBracketIndex === -1) {
			return { host: withoutCredentials, port: "" };
		}
		const host = withoutCredentials.slice(0, closingBracketIndex + 1);
		const remainder = withoutCredentials.slice(closingBracketIndex + 1);
		return {
			host,
			port: remainder.startsWith(":") ? remainder.slice(1) : "",
		};
	}

	const separatorIndex = withoutCredentials.lastIndexOf(":");
	if (separatorIndex === -1) {
		return { host: withoutCredentials, port: "" };
	}

	return {
		host: withoutCredentials.slice(0, separatorIndex),
		port: withoutCredentials.slice(separatorIndex + 1),
	};
};

const validateExplicitPort = (port: string) => {
	if (!port) {
		throw new Error("upstream must include an explicit port");
	}
	if (!/^\d+$/.test(port)) {
		throw new Error(`upstream port "${port}" must be numeric`);
	}
	const portNumber = Number(port);
	if (portNumber < 1 || portNumber > 65535) {
		throw new Error(`upstream port "${port}" must be between 1 and 65535`);
	}
	return port;
};

export const parseCaddyUpstream = (upstream: string) => {
	const trimmed = upstream.trim();
	if (httpUrlPrefixRegex.test(trimmed)) {
		const authority = stripUrlPath(trimmed.replace(httpUrlPrefixRegex, ""));
		const { port } = getAuthorityPort(authority);
		const explicitPort = validateExplicitPort(port);
		const url = new URL(trimmed);
		const scheme = url.protocol.replace(":", "");
		if (scheme !== "http" && scheme !== "https") {
			throw new Error(`unsupported upstream scheme "${scheme}"`);
		}
		return {
			dial: `${url.hostname}:${explicitPort}`,
			scheme,
		};
	}

	const { host, port } = getAuthorityPort(trimmed);
	const explicitPort = validateExplicitPort(port);
	if (!host) {
		throw new Error("upstream must include a host");
	}
	if (trimmed.includes("/") || trimmed.includes("?") || trimmed.includes("#")) {
		throw new Error("raw upstream dials must be host:port only");
	}
	return {
		dial: `${host}:${explicitPort}`,
		scheme: "http",
	};
};

const createReverseProxyHandler = (route: CaddyRouteIntent) => {
	const parsedUpstreams = route.upstreams.map(parseCaddyUpstream);
	const usesTlsTransport = parsedUpstreams.some(
		(upstream) => upstream.scheme === "https",
	);

	return {
		handler: "reverse_proxy",
		upstreams: parsedUpstreams.map((upstream) => ({ dial: upstream.dial })),
		...(usesTlsTransport && {
			transport: {
				protocol: "http",
				tls: {},
			},
		}),
	};
};

const createProxyRoute = (route: CaddyRouteIntent) => {
	const handlers = [
		createHeaderHandler(route),
		createBasicAuthHandler(route),
		...createRewriteHandlers(route),
		createReverseProxyHandler(route),
	].filter(Boolean) as CaddyJsonObject[];

	return {
		match: createRouteMatcher(route),
		handle: handlers,
		terminal: true,
	};
};

const createStaticResponseRoute = (route: CaddyRouteIntent) => {
	const response = route.staticResponse;
	const handlers = [
		createHeaderHandler(route),
		{
			handler: "static_response",
			status_code: response?.statusCode ?? 404,
			...(response?.body && { body: response.body }),
			...(response?.headers && {
				headers: normalizeHeaderValues(response.headers),
			}),
		},
	].filter(Boolean) as CaddyJsonObject[];

	return {
		match: createRouteMatcher(route),
		handle: handlers,
		terminal: true,
	};
};

const createForbiddenRoute = (route: CaddyRouteIntent) => {
	return {
		match: createRouteMatcherWithoutRemoteIp(route),
		handle: [
			{
				handler: "static_response",
				status_code: 403,
			},
		],
		terminal: true,
	};
};

const createRedirectLocation = (route: CaddyRouteIntent) => {
	const scheme = route.redirectScheme?.scheme || "https";
	const port = route.redirectScheme?.port
		? `:${route.redirectScheme.port}`
		: "";
	return `${scheme}://{http.request.host}${port}{http.request.uri}`;
};

const createRedirectRoute = (route: CaddyRouteIntent) => {
	return {
		match: createRouteMatcher(route),
		handle: [
			{
				handler: "static_response",
				status_code: route.redirectScheme?.permanent === false ? 302 : 308,
				headers: {
					Location: [createRedirectLocation(route)],
				},
			},
		],
		terminal: true,
	};
};

const createHttpsRedirectRoute = (route: CaddyRouteIntent) => {
	return createRedirectRoute({
		...route,
		allowedRemoteIps: null,
		redirectScheme: { scheme: "https", permanent: true },
	});
};

export const flattenCaddyFragments = (fragments: CaddyRouteFragment[] = []) => {
	for (const fragment of fragments) {
		validateCaddyRouteFragment(fragment);
	}
	return fragments.flatMap((fragment) => fragment.routes);
};

export const compileCaddyConfig = ({
	fragments = [],
	routes = [],
	letsEncryptEmail,
}: CaddyCompileOptions = {}) => {
	const allRoutes = sortCaddyRouteIntents([
		...flattenCaddyFragments(fragments),
		...routes,
	]);
	for (const route of allRoutes) {
		validateCaddyRouteIntent(route);
	}

	const httpRoutes = allRoutes.map((route) => {
		if (route.redirectScheme) {
			return createRedirectRoute(route);
		}
		if (route.staticResponse && !route.https) {
			return createStaticResponseRoute(route);
		}
		return route.https
			? createHttpsRedirectRoute(route)
			: createProxyRoute(route);
	});
	const httpsRoutes = allRoutes
		.filter((route) => route.https && !route.redirectScheme)
		.flatMap((route) => {
			const proxyRoute = route.staticResponse
				? createStaticResponseRoute(route)
				: createProxyRoute(route);
			return route.allowedRemoteIps?.length
				? [proxyRoute, createForbiddenRoute(route)]
				: [proxyRoute];
		});

	return {
		admin: {
			listen: "localhost:2019",
		},
		apps: {
			...(letsEncryptEmail && {
				tls: {
					automation: {
						policies: [
							{
								issuers: [
									{
										module: "acme",
										email: letsEncryptEmail,
									},
								],
							},
						],
					},
				},
			}),
			http: {
				servers: {
					http: {
						listen: [":80"],
						routes: httpRoutes,
					},
					https: {
						listen: [":443"],
						routes: httpsRoutes,
					},
				},
			},
		},
	};
};

const encodeBase64 = (content: string) =>
	Buffer.from(content, "utf8").toString("base64");

const remoteWriteFileAtomic = async (
	serverId: string,
	filePath: string,
	content: string,
) => {
	const tempPath = `${filePath}.tmp-${Date.now()}`;
	const command = [
		`mkdir -p ${quote([path.posix.dirname(filePath)])}`,
		`printf %s ${quote([encodeBase64(content)])} | base64 -d > ${quote([tempPath])}`,
		`mv ${quote([tempPath])} ${quote([filePath])}`,
	].join(" && ");
	await execAsyncRemote(serverId, command);
};

export const writeCaddyConfigContent = async (
	content: string,
	options: CaddyFragmentStoreOptions = {},
) => {
	const filePath = getCaddyActiveConfigPath(!!options.serverId);
	if (options.serverId) {
		await remoteWriteFileAtomic(options.serverId, filePath, content);
		return;
	}
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.tmp-${Date.now()}`;
	writeFileSync(tempPath, content, "utf8");
	renameSync(tempPath, filePath);
};

export const writeCaddyConfigFile = async (
	config: CaddyJsonObject,
	options: CaddyFragmentStoreOptions = {},
) => {
	await writeCaddyConfigContent(
		`${JSON.stringify(config, null, 2)}\n`,
		options,
	);
};

export const writeCaddyRouteFragment = async (
	fragment: CaddyRouteFragment,
	options: CaddyFragmentStoreOptions = {},
) => {
	validateCaddyRouteFragment(fragment);
	const filePath = getCaddyFragmentFilePath(fragment.id, !!options.serverId);
	const content = `${JSON.stringify(fragment, null, 2)}\n`;
	if (options.serverId) {
		await remoteWriteFileAtomic(options.serverId, filePath, content);
		return;
	}
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf8");
};

export const removeCaddyRouteFragment = async (
	fragmentId: string,
	options: CaddyFragmentStoreOptions = {},
) => {
	const filePath = getCaddyFragmentFilePath(fragmentId, !!options.serverId);
	if (options.serverId) {
		await execAsyncRemote(options.serverId, `rm -f ${quote([filePath])}`);
		return;
	}
	rmSync(filePath, { force: true });
};

export const restoreCaddyRouteFragments = async (
	fragments: CaddyRouteFragment[],
	options: CaddyFragmentStoreOptions = {},
) => {
	const fragmentsPath = paths(!!options.serverId).CADDY_FRAGMENTS_PATH;
	if (options.serverId) {
		await execAsyncRemote(
			options.serverId,
			`rm -rf ${quote([fragmentsPath])} && mkdir -p ${quote([fragmentsPath])}`,
		);
	} else {
		rmSync(fragmentsPath, { recursive: true, force: true });
		mkdirSync(fragmentsPath, { recursive: true });
	}

	for (const fragment of fragments) {
		await writeCaddyRouteFragment(fragment, options);
	}
};

const parseFragmentContent = (fileName: string, content: string) => {
	try {
		const parsed = JSON.parse(content) as CaddyRouteFragment;
		validateCaddyRouteFragment(parsed);
		return parsed;
	} catch (error) {
		throw new Error(
			`Invalid Caddy fragment ${fileName}: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
};

export const readCaddyRouteFragments = async (
	options: CaddyFragmentStoreOptions = {},
) => {
	const fragmentsPath = paths(!!options.serverId).CADDY_FRAGMENTS_PATH;
	if (options.serverId) {
		const command = `if [ -d ${quote([fragmentsPath])} ]; then find ${quote([fragmentsPath])} -maxdepth 1 -type f -name '*.json' | sort | while IFS= read -r file; do printf '%s\n' "---DOKPLOY-CADDY-FILE:$file"; cat "$file"; printf '\n'; done; fi`;
		const { stdout } = await execAsyncRemote(options.serverId, command);
		const fragments: CaddyRouteFragment[] = [];
		for (const block of stdout.split("---DOKPLOY-CADDY-FILE:")) {
			if (!block.trim()) continue;
			const newlineIndex = block.indexOf("\n");
			if (newlineIndex === -1) continue;
			const fileName = block.slice(0, newlineIndex).trim();
			const content = block.slice(newlineIndex + 1).trim();
			fragments.push(parseFragmentContent(fileName, content));
		}
		return fragments;
	}

	if (!existsSync(fragmentsPath)) {
		return [];
	}

	return readdirSync(fragmentsPath)
		.filter((fileName) => fileName.endsWith(".json"))
		.sort()
		.map((fileName) => {
			const filePath = path.join(fragmentsPath, fileName);
			return parseFragmentContent(fileName, readFileSync(filePath, "utf8"));
		});
};

export const compileAndWriteCaddyConfig = async (
	options: CaddyFragmentStoreOptions & {
		letsEncryptEmail?: string | null;
	} = {},
) => {
	const fragments = await readCaddyRouteFragments(options);
	const config = compileCaddyConfig({
		fragments,
		letsEncryptEmail: options.letsEncryptEmail,
	});
	await writeCaddyConfigFile(config, options);
	return config;
};

export const readCaddyConfigFile = async (
	options: CaddyFragmentStoreOptions = {},
) => {
	const filePath = getCaddyActiveConfigPath(!!options.serverId);
	if (options.serverId) {
		const { stdout } = await execAsyncRemote(
			options.serverId,
			`cat ${quote([filePath])}`,
		);
		return stdout;
	}
	return readFileSync(filePath, "utf8");
};

export const readCaddyConfigFileIfExists = async (
	options: CaddyFragmentStoreOptions = {},
) => {
	const filePath = getCaddyActiveConfigPath(!!options.serverId);
	if (options.serverId) {
		const { stdout } = await execAsyncRemote(
			options.serverId,
			`if [ -f ${quote([filePath])} ]; then cat ${quote([filePath])}; fi`,
		);
		return stdout || null;
	}
	if (!existsSync(filePath)) {
		return null;
	}
	return readFileSync(filePath, "utf8");
};

export const writeAndReloadCaddyConfigSafely = async (
	config: CaddyJsonObject,
	options: CaddyFragmentStoreOptions = {},
) => {
	const previousConfig = await readCaddyConfigFileIfExists(options);
	await writeCaddyConfigFile(config, options);
	try {
		await reloadCaddyAfterValidation(options.serverId);
	} catch (error) {
		if (previousConfig) {
			await writeCaddyConfigContent(previousConfig, options);
		} else {
			await writeCaddyConfigFile(compileCaddyConfig(), options);
		}
		throw error;
	}
};

export const compileWriteAndReloadCaddyConfigSafely = async (
	options: CaddyFragmentStoreOptions & {
		letsEncryptEmail?: string | null;
	} = {},
) => {
	const fragments = await readCaddyRouteFragments(options);
	const config = compileCaddyConfig({
		fragments,
		letsEncryptEmail: options.letsEncryptEmail,
	});
	await writeAndReloadCaddyConfigSafely(config, options);
	return config;
};

export const ensureDefaultCaddyConfig = async (
	options: CaddyFragmentStoreOptions & {
		letsEncryptEmail?: string | null;
	} = {},
) => {
	const caddyPaths = paths(!!options.serverId);
	if (options.serverId) {
		await execAsyncRemote(
			options.serverId,
			`mkdir -p ${quote([
				caddyPaths.MAIN_CADDY_PATH,
				caddyPaths.CADDY_FRAGMENTS_PATH,
				caddyPaths.CADDY_DATA_PATH,
				caddyPaths.CADDY_CONFIG_DIR_PATH,
			])}`,
		);
		await compileAndWriteCaddyConfig(options);
		return;
	}

	mkdirSync(caddyPaths.MAIN_CADDY_PATH, { recursive: true });
	mkdirSync(caddyPaths.CADDY_FRAGMENTS_PATH, { recursive: true });
	mkdirSync(caddyPaths.CADDY_DATA_PATH, { recursive: true });
	mkdirSync(caddyPaths.CADDY_CONFIG_DIR_PATH, { recursive: true });
	await compileAndWriteCaddyConfig(options);
};

const getCaddyExecTargetCommand = `
if docker service inspect dokploy-caddy >/dev/null 2>&1; then
	docker ps --filter "label=com.docker.swarm.service.name=dokploy-caddy" --format '{{.ID}}' | head -n 1
else
	echo dokploy-caddy
fi`;

const execInCaddy = async (serverId: string | undefined, command: string) => {
	const { stdout } = serverId
		? await execAsyncRemote(serverId, getCaddyExecTargetCommand)
		: await execAsync(getCaddyExecTargetCommand);
	const target = stdout.trim();
	if (!target) {
		throw new Error("Caddy resource is not running");
	}
	const dockerExecCommand = `docker exec ${quote([target])} ${command}`;
	if (serverId) {
		return execAsyncRemote(serverId, dockerExecCommand);
	}
	return execAsync(dockerExecCommand);
};

export const validateCaddyConfigWithContainer = async (serverId?: string) => {
	return execInCaddy(serverId, "caddy validate --config /etc/caddy/caddy.json");
};

export const validateCaddyConfigFileWithImage = async (
	configPath: string,
	serverId?: string,
) => {
	const imageName = `caddy:${CADDY_VERSION}`;
	const validationRoot = path.posix.join(
		path.posix.dirname(configPath),
		".validate-runtime",
	);
	const validationDataPath = path.posix.join(validationRoot, "data");
	const validationConfigPath = path.posix.join(validationRoot, "config");
	const mkdirCommand = `mkdir -p ${quote([
		validationDataPath,
		validationConfigPath,
	])}`;
	const cleanupCommand = `rm -rf ${quote([validationRoot])}`;
	const validateCommand = `docker run --rm --network none ${[
		"-v",
		`${configPath}:/etc/caddy/caddy.json:ro`,
		"-v",
		`${validationDataPath}:/data`,
		"-v",
		`${validationConfigPath}:/config`,
		imageName,
		"caddy",
		"validate",
		"--config",
		"/etc/caddy/caddy.json",
	]
		.map((part) => quote([part]))
		.join(" ")}`;
	if (serverId) {
		await execAsyncRemote(serverId, mkdirCommand);
		try {
			return await execAsyncRemote(serverId, validateCommand);
		} finally {
			await execAsyncRemote(serverId, cleanupCommand).catch(() => undefined);
		}
	}
	await execAsync(mkdirCommand);
	try {
		return await execAsync(validateCommand);
	} finally {
		await execAsync(cleanupCommand).catch(() => undefined);
	}
};

export const reloadCaddyWithContainer = async (serverId?: string) => {
	const { stdout } = serverId
		? await execAsyncRemote(serverId, getCaddyExecTargetCommand)
		: await execAsync(getCaddyExecTargetCommand);
	const target = stdout.trim();
	if (!target) {
		throw new Error("Caddy resource is not running");
	}
	const dockerExecCommand = `docker exec -w /etc/caddy ${quote([
		target,
	])} caddy reload --config /etc/caddy/caddy.json`;
	if (serverId) {
		return execAsyncRemote(serverId, dockerExecCommand);
	}
	return execAsync(dockerExecCommand);
};

export const reloadCaddyAfterValidation = async (serverId?: string) => {
	await validateCaddyConfigWithContainer(serverId);
	return reloadCaddyWithContainer(serverId);
};
