import { X509Certificate } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as bcrypt from "bcrypt";
import { quote } from "shell-quote";
import { parse } from "yaml";
import { paths } from "../constants";
import { db } from "../db";
import { findApplicationById } from "../services/application";
import type { Security } from "../services/security";
import {
	getDockerResourceType,
	readPorts,
	reconnectServicesToTraefik,
} from "../services/settings";
import {
	getWebServerSettings,
	setWebServerProvider,
	type WebServerProvider,
} from "../services/web-server-settings";
import { renderCaddyfile } from "../utils/caddy/caddyfile";
import {
	certificateBundle,
	SWITCH_MARKER,
	switchToCaddyScript,
	switchToTraefikScript,
} from "../utils/caddy/cutover";
import {
	applyCaddy,
	CADDY_CONTAINER,
	CADDY_IMAGE,
	caddyError,
	caddySwitch,
	caddyUnsupported,
	findServerDomains,
	loadCaddyState,
	withCaddyQueue,
} from "../utils/caddy/sync";
import { createDomainLabels } from "../utils/docker/domain";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
	sleep,
	writeFileRemote,
} from "../utils/process/execAsync";
import { createServiceConfig } from "../utils/traefik/application";
import { createRouterConfig, manageDomain } from "../utils/traefik/domain";
import type { FileConfig, HttpRouter } from "../utils/traefik/file-types";
import { authDomainConfigName } from "../utils/traefik/forward-auth";
import {
	getDefaultMiddlewares,
	getDefaultServerTraefikConfig,
	getDefaultTraefikConfig,
	initializeStandaloneTraefik,
	TRAEFIK_HTTP3_PORT,
	TRAEFIK_PORT,
	TRAEFIK_SSL_PORT,
} from "./traefik-setup";

const TRAEFIK_CONTAINER = "dokploy-traefik";

export interface WebServerSwitchCheck {
	// The Caddyfile the switch would start Caddy with. Empty toward Traefik.
	caddyfile: string;
	// The switch is refused while there is one.
	blockers: string[];
	// What Traefik does today that will stop: each has to be accepted.
	acknowledge: string[];
	warnings: string[];
}

type ServerId = string | null | undefined;
type ServerDomain = Awaited<ReturnType<typeof findServerDomains>>[number];

const run = (serverId: ServerId, command: string) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

const write = async (serverId: ServerId, file: string, content: string) => {
	if (serverId) await writeFileRemote(serverId, file, content);
	else writeFileSync(file, content);
};

// What the command printed is Caddy's or Docker's own account of the failure.
// A switch script prints the container's last log lines before its own
// verdict: of those, only Caddy's error is worth showing.
const said = (error: unknown) => {
	const lines =
		error instanceof ExecError ? (error.stderr?.trim().split("\n") ?? []) : [];
	const [last] = lines.slice(-1);
	if (!last) return error instanceof Error ? error.message : String(error);
	const verdict = lines.find((line) => line.startsWith("Error:"));
	return verdict && verdict !== last ? `${verdict}\n${last}` : last;
};

const cutoverOptions = (serverId: ServerId) => ({
	image: CADDY_IMAGE,
	caddy: CADDY_CONTAINER,
	traefik: TRAEFIK_CONTAINER,
	network: "dokploy-network",
	publish: [
		`${TRAEFIK_PORT}:80`,
		`${TRAEFIK_SSL_PORT}:443`,
		`${TRAEFIK_HTTP3_PORT}:443/udp`,
	],
	caddyPath: paths(!!serverId).MAIN_CADDY_PATH,
	certificatesPath: paths(!!serverId).CERTIFICATES_PATH,
});

// traefik.yml and the entries of the dynamic folder, by their name inside
// Traefik's folder. Configuration files and acme.json come with their content.
const readTraefikFiles = async (serverId: ServerId) => {
	const root = paths(!!serverId).MAIN_TRAEFIK_PATH;
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			`cd ${quote([root])} || exit 0
for file in traefik.yml dynamic/*; do
	case "$file" in
		*.yml | *.yaml | dynamic/acme.json) [ -f "$file" ] && printf '%s\\t%s\\n' "$file" "$(base64 < "$file" | tr -d '\\n')" ;;
		*) [ -e "$file" ] && echo "$file" ;;
	esac
done
true`,
		);
		return new Map(
			stdout
				.split("\n")
				.filter(Boolean)
				.map((line): [string, string] => {
					const [name = "", content = ""] = line.split("\t");
					return [name, Buffer.from(content, "base64").toString()];
				}),
		);
	}
	const dynamic = join(root, "dynamic");
	const names = existsSync(dynamic) ? readdirSync(dynamic) : [];
	return new Map(
		["traefik.yml", ...names.map((name) => `dynamic/${name}`)].map(
			(name): [string, string] => {
				try {
					return /\.ya?ml$|^dynamic\/acme\.json$/.test(name)
						? [name, readFileSync(join(root, name), "utf8")]
						: [name, ""];
				} catch {
					return [name, ""];
				}
			},
		),
	);
};

// Traefik's certificate store, or an empty one when it is missing or damaged:
// the worst that follows is that Caddy requests certificates again.
const readAcme = (files: Map<string, string>) => {
	try {
		const text = files.get("dynamic/acme.json") || "{}";
		const certificates = Object.values(
			JSON.parse(text) as Record<
				string,
				{ Certificates?: { certificate: string }[] } | null
			>,
		).flatMap((resolver) => resolver?.Certificates ?? []);
		return { text, certificates };
	} catch {
		return { text: "{}", certificates: [] };
	}
};

// The labels of every running container and Swarm service, by its name.
const readLabels = async (serverId: ServerId) => {
	const { stdout } = await run(
		serverId,
		`containers=$(docker ps -q)
[ -z "$containers" ] || docker inspect -f '{{.Name}} {{json .Config.Labels}}' $containers 2>/dev/null || true
if [ "$(docker info -f '{{.Swarm.ControlAvailable}}')" = true ]; then
	services=$(docker service ls -q)
	[ -z "$services" ] || docker service inspect -f '{{.Spec.Name}} {{json .Spec.Labels}}' $services 2>/dev/null || true
fi`,
	);
	return new Map(
		stdout
			.split("\n")
			.filter(Boolean)
			.map((line): [string, Record<string, string>] => {
				const space = line.indexOf(" ");
				return [
					line.slice(0, space).replace(/^\//, ""),
					(JSON.parse(line.slice(space + 1)) as Record<string, string>) ?? {},
				];
			}),
	);
};

// Dokploy's writers leave undefined values and the order of keys to the YAML
// library.
const same = (a: unknown, b: unknown) =>
	isDeepStrictEqual(
		JSON.parse(JSON.stringify(a ?? null)),
		JSON.parse(JSON.stringify(b ?? null)),
	);

// bcrypt salts every hash, so a user is compared by the password it accepts.
const sameUsers = async (
	definition: unknown,
	rows: Pick<Security, "username" | "password">[],
) => {
	const users = (definition as { basicAuth?: { users?: unknown } } | null)
		?.basicAuth?.users;
	if (
		!Array.isArray(users) ||
		users.length !== rows.length ||
		Object.keys(definition as object).length !== 1
	) {
		return false;
	}
	const accepted = await Promise.all(
		rows.map(async ({ username, password }) => {
			const hash = users
				.map(String)
				.find((user) => user.startsWith(`${username}:`))
				?.slice(username.length + 1);
			return !!hash && bcrypt.compare(password, hash).catch(() => false);
		}),
	);
	return accepted.every(Boolean);
};

/**
 * Lists what Traefik does on a server that does not come from the database,
 * and that Caddy will therefore not do: a hand-added IP allow-list must not
 * silently stop applying. Traefik's files and labels are compared with what
 * Dokploy's own writers produce for the same rows, so a change made by hand
 * under a name Dokploy uses is found too.
 */
export const findHandWrittenTraefikConfig = async (
	serverId: ServerId,
	domains: ServerDomain[],
	files: Map<string, string>,
	labels: Map<string, Record<string, string>>,
) => {
	const applications = (
		await db.query.applications.findMany({
			columns: { appName: true, serverId: true },
			with: { previewDeployments: { columns: { appName: true } } },
		})
	).filter(
		(application) => (application.serverId || null) === (serverId || null),
	);
	const ownFiles = new Set([
		"traefik.yml",
		"dynamic/acme.json",
		"dynamic/access.log",
		"dynamic/certificates",
		...[
			"dokploy",
			"middlewares",
			authDomainConfigName,
			...applications.flatMap((application) => [
				application.appName,
				...application.previewDeployments.map((preview) => preview.appName),
			]),
		].map((name) => `dynamic/${name}.yml`),
	]);

	// Each router with every middleware it may carry, each service, each
	// middleware and each label, as the database has them.
	const routers = new Map<string, HttpRouter>();
	const services = new Map<string, unknown>();
	const middlewares = new Map<string, unknown>(
		Object.entries(
			(parse(getDefaultMiddlewares()) as FileConfig).http?.middlewares ?? {},
		),
	);
	const users = new Map<string, Security[]>();
	const ownLabels = new Set<string>();
	for (const domain of domains) {
		if (!domain.enabled) continue;
		const key = domain.uniqueConfigKey;
		const entrypoints = domain.customEntrypoint
			? [domain.customEntrypoint]
			: ["web", ...(domain.https ? ["websecure"] : [])];
		if (domain.compose) {
			for (const entrypoint of entrypoints) {
				for (const label of createDomainLabels(
					domain.compose.appName,
					domain,
					entrypoint,
				)) {
					ownLabels.add(label);
				}
			}
			continue;
		}
		const owner = domain.application ?? domain.previewDeployment?.application;
		const appName =
			domain.previewDeployment?.appName ?? domain.application?.appName;
		if (!owner || !appName) continue;
		const redirects = domain.application?.redirects ?? [];
		if (owner.security.length) {
			users.set(`auth-${owner.appName}`, owner.security);
		}
		for (const redirect of redirects) {
			const { regex, replacement, permanent } = redirect;
			middlewares.set(`redirect-${appName}-${redirect.uniqueConfigKey}`, {
				redirectRegex: { regex, replacement, permanent },
			});
		}
		// addMiddleware puts an application's own middlewares on every router in
		// its file, the one that only redirects to HTTPS included.
		const shared = domain.application
			? [
					...(owner.security.length ? [`auth-${appName}`] : []),
					...redirects.map(
						(redirect) => `redirect-${appName}-${redirect.uniqueConfigKey}`,
					),
				]
			: [];
		for (const entrypoint of entrypoints) {
			const router = await createRouterConfig(
				{ appName, redirects, security: owner.security },
				domain,
				entrypoint,
			);
			const used = router.middlewares ?? [];
			routers.set(
				`${appName}-router-${entrypoint === "websecure" ? "websecure-" : ""}${key}`,
				{ ...router, middlewares: [...used, ...shared] },
			);
			if (used.includes(`stripprefix-${appName}-${key}`)) {
				middlewares.set(`stripprefix-${appName}-${key}`, {
					stripPrefix: { prefixes: [domain.path] },
				});
			}
			if (used.includes(`addprefix-${appName}-${key}`)) {
				middlewares.set(`addprefix-${appName}-${key}`, {
					addPrefix: { prefix: domain.internalPath },
				});
			}
		}
		services.set(
			`${appName}-service-${key}`,
			createServiceConfig(appName, domain),
		);
	}
	if (!serverId) {
		// As updateServerTraefik and createDefaultServerTraefikConfig write them.
		const settings = await getWebServerSettings();
		const dashboard = {
			rule: settings?.host
				? `Host(\`${settings.host}\`)`
				: "Host(`dokploy.docker.localhost`) && PathPrefix(`/`)",
			service: "dokploy-service-app",
		};
		routers.set("dokploy-router-app", {
			...dashboard,
			entryPoints: ["web"],
			middlewares: ["redirect-to-https"],
		});
		routers.set("dokploy-router-app-secure", {
			...dashboard,
			entryPoints: ["websecure"],
			...(settings?.certificateType === "letsencrypt" && {
				tls: { certResolver: "letsencrypt" },
			}),
		});
		services.set(dashboard.service, {
			loadBalancer: {
				servers: [{ url: `http://dokploy:${process.env.PORT || 3000}` }],
				passHostHeader: true,
			},
		});
	}

	const found: string[] = [];
	for (const [name, content] of files) {
		if (!ownFiles.has(name)) {
			found.push(`${name} was not written by Dokploy. Caddy will not read it.`);
			continue;
		}
		if (name === "traefik.yml" || !name.endsWith(".yml")) continue;
		let config: FileConfig;
		try {
			config = (parse(content) ?? {}) as FileConfig;
		} catch {
			found.push(`${name} is not plain YAML. Caddy will not apply it.`);
			continue;
		}
		for (const [router, { middlewares: used, ...written }] of Object.entries(
			config.http?.routers ?? {},
		)) {
			const { middlewares: allowed, ...expected } = routers.get(router) ?? {};
			if (!same(written, expected)) {
				found.push(
					`${name}: the router ${router} is not the one Dokploy writes for a domain. Caddy follows the database, not this file.`,
				);
				continue;
			}
			for (const middleware of used ?? []) {
				if (!allowed?.includes(middleware.replace(/@file$/, ""))) {
					found.push(
						`${name}: the router ${router} uses the middleware ${middleware}, which Caddy will not apply.`,
					);
				}
			}
		}
		for (const [service, written] of Object.entries(
			config.http?.services ?? {},
		)) {
			if (!same(written, services.get(service))) {
				found.push(
					`${name}: the service ${service} is not the one Dokploy writes for a domain. Caddy follows the database, not this file.`,
				);
			}
		}
		// A definition under any other name matters only where a router uses
		// it, which is reported above.
		for (const [middleware, written] of Object.entries(
			config.http?.middlewares ?? {},
		)) {
			const rows = users.get(middleware);
			if (
				rows
					? !(await sameUsers(written, rows))
					: middlewares.has(middleware) &&
						!same(written, middlewares.get(middleware))
			) {
				found.push(
					`${name}: the middleware ${middleware} is not the one Dokploy writes. Caddy follows the database, not this file.`,
				);
			}
		}
		for (const section of ["tcp", "udp", "tls"] as const) {
			if (config[section]) {
				found.push(
					`${name} has a ${section} section. Caddy will not apply it.`,
				);
			}
		}
	}

	for (const [name, entries] of labels) {
		// Traefik reads label names without regard to case.
		const traefik = Object.entries(entries).filter(([label]) =>
			/^traefik\./i.test(label),
		);
		// Dokploy's traefik.yml has Traefik ignore a container without this.
		if (
			!traefik.some(
				([label, value]) =>
					/^traefik\.enable$/i.test(label) && /^(1|t|true)$/i.test(value),
			)
		) {
			continue;
		}
		const foreign = traefik
			.filter(
				([label, value]) =>
					!ownLabels.has(`${label}=${value}`) &&
					!/^traefik\.(enable|docker\.network|swarm\.network)$/i.test(label),
			)
			.map(([label]) => label);
		if (foreign.length) {
			found.push(
				`${name} has Traefik labels that do not come from a domain in Dokploy: ${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ` and ${foreign.length - 3} more` : ""}. Caddy will not apply them.`,
			);
		}
	}

	// The ACME email and the access log are what Dokploy itself changes in
	// that file.
	const comparable = (yaml: string) =>
		JSON.parse(
			JSON.stringify(parse(yaml) ?? {}, (key, value: unknown) =>
				key === "email" || key === "accessLog" ? undefined : value,
			),
		) as unknown;
	const traefikYml = files.get("traefik.yml") ?? "";
	if ((parse(traefikYml) as { accessLog?: unknown } | null)?.accessLog) {
		found.push(
			"The Requests page reads Traefik's access log. With Caddy it starts empty and has to be activated again.",
		);
	}
	const defaults = serverId
		? getDefaultServerTraefikConfig()
		: getDefaultTraefikConfig();
	if (!isDeepStrictEqual(comparable(traefikYml), comparable(defaults))) {
		found.push(
			"traefik.yml differs from the one Dokploy writes today. Caddy does not read that file.",
		);
	}
	return found;
};

/**
 * The dry run of a provider switch. It changes nothing: the candidate
 * Caddyfile is written next to the live one, under another name.
 */
export const checkWebServerSwitch = async (
	target: WebServerProvider,
	serverId?: string | null,
): Promise<WebServerSwitchCheck> => {
	const files = await readTraefikFiles(serverId);
	if (target === "traefik") {
		const soon = Date.now() + 30 * 24 * 60 * 60 * 1000;
		const expiring = readAcme(files).certificates.filter(({ certificate }) => {
			try {
				const pem = Buffer.from(certificate, "base64");
				return new Date(new X509Certificate(pem).validTo).getTime() < soon;
			} catch {
				return true;
			}
		}).length;
		return {
			caddyfile: "",
			blockers: [],
			acknowledge: [],
			warnings: [
				...(expiring
					? [
							`${expiring} of the certificates Traefik holds have expired or expire within 30 days. Traefik requests those again when it starts.`,
						]
					: []),
				"A compose domain that changed while Caddy served takes effect under Traefik at that compose's next deploy.",
			],
		};
	}

	const { MAIN_CADDY_PATH, CERTIFICATES_PATH } = paths(!!serverId);
	const state = await loadCaddyState(serverId);
	const { caddyfile, refused, automatic } = renderCaddyfile(state);
	const all = await findServerDomains(serverId);
	const domains = all.filter((domain) => domain.enabled);
	const blockers = [
		...domains.flatMap((domain) => {
			const reason = caddyUnsupported(domain);
			return reason
				? [`${domain.host}: ${reason} is not available with Caddy.`]
				: [];
		}),
		...refused.map(
			(route) =>
				`${route.host}${route.path ?? ""}: one of this domain's values cannot be written for Caddy.`,
		),
	];

	// Validating compiles every redirect pattern and reads the admin's own
	// files and the uploaded certificates, as Caddy will when it starts.
	if (serverId) await run(serverId, `mkdir -p ${quote([MAIN_CADDY_PATH])}`);
	else mkdirSync(MAIN_CADDY_PATH, { recursive: true });
	const candidate = `${MAIN_CADDY_PATH}/Caddyfile.check`;
	await write(serverId, candidate, caddyfile);
	try {
		await run(
			serverId,
			`docker run --rm --network none -v ${quote([`${MAIN_CADDY_PATH}:/etc/caddy`])} -v ${quote([`${CERTIFICATES_PATH}:${CERTIFICATES_PATH}:ro`])} ${CADDY_IMAGE} caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.check
status=$?
rm -f ${quote([candidate])}
exit $status`,
		);
	} catch (error) {
		blockers.push(
			`Caddy rejects the configuration. ${said(caddyError(error))}`,
		);
	}

	const traefik = await getDockerResourceType(
		TRAEFIK_CONTAINER,
		serverId ?? undefined,
	);
	if (traefik !== "standalone") {
		blockers.push(
			traefik === "service"
				? "Traefik runs as a Swarm service on this server. Run the server setup again to convert it to a container, then switch."
				: "The Traefik container was not found on this server.",
		);
	}

	const labels = await readLabels(serverId);
	const acknowledge = await findHandWrittenTraefikConfig(
		serverId,
		all,
		files,
		labels,
	);
	// readPorts throws for a container that is not there, which is reported
	// as a blocker above.
	const ports =
		traefik === "standalone"
			? await readPorts(TRAEFIK_CONTAINER, serverId ?? undefined)
			: [];
	const extraPorts = ports
		.map((port) => `${port.publishedPort}/${port.protocol}`)
		.filter(
			(port) =>
				![
					`${TRAEFIK_PORT}/tcp`,
					`${TRAEFIK_SSL_PORT}/tcp`,
					`${TRAEFIK_HTTP3_PORT}/udp`,
				].includes(port),
		);
	if (extraPorts.length) {
		acknowledge.push(
			`Traefik also publishes ${extraPorts.join(", ")}. Caddy will not.`,
		);
	}

	const warnings: string[] = [];
	const carried = new Set(
		certificateBundle(readAcme(files).text)
			.split("\n")
			.map((line) => line.split(" ")[0]?.split("/").pop()),
	);
	const waiting = automatic.filter((host) => !carried.has(host));
	if (waiting.length) {
		warnings.push(
			`Traefik holds no certificate that Caddy can take over for ${waiting.join(", ")}. Caddy asks Let's Encrypt for one when it starts, and these do not answer over HTTPS until it has one. Traefik answers with a self-signed certificate in that case. For a domain Let's Encrypt cannot validate, choose the certificate provider None, which keeps that behaviour.`,
		);
	}
	const upstreams = [
		...new Set(state.routes.flatMap((route) => route.upstreams)),
	];
	if (upstreams.length) {
		// Inside Traefik's network namespace, so it sees every network the proxy
		// is attached to. Nothing is probed while Traefik is not running.
		const probe = upstreams
			.map((upstream) => {
				const [host = "", port = ""] = upstream.split(":");
				return `nc -z -w 2 ${quote([host, port])} || echo ${quote([upstream])}`;
			})
			.join("; ");
		const { stdout: silent } = await run(
			serverId,
			`docker run --rm --network container:${TRAEFIK_CONTAINER} ${CADDY_IMAGE} sh -c ${quote([probe])} 2>/dev/null; true`,
		);
		for (const upstream of silent.split("\n").filter(Boolean)) {
			warnings.push(
				`${upstream} does not answer. Its application may be stopped.`,
			);
		}
	}
	const labelled = new Set(
		[...labels.values()].flatMap((entries) => Object.keys(entries)),
	);
	for (const domain of domains) {
		if (
			domain.compose &&
			!domain.customEntrypoint &&
			!labelled.has(
				`traefik.http.routers.${domain.compose.appName}-${domain.uniqueConfigKey}-web.rule`,
			)
		) {
			warnings.push(
				`${domain.host} has no running container, so it gets its route at that compose's next deploy.`,
			);
		}
	}
	return { caddyfile, blockers, acknowledge, warnings };
};

// Which proxy serves, according to Docker. By its status, because Docker also
// calls a container running while it keeps restarting it.
const servingProvider = async (
	serverId: ServerId,
): Promise<WebServerProvider | undefined> => {
	const marker = `${paths(!!serverId).MAIN_CADDY_PATH}/${SWITCH_MARKER}`;
	// A dropped connection does not stop the script on the server, so its
	// marker is waited for, as long as a slow image pull can take.
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const { stdout } = await run(
				serverId,
				`[ -e ${quote([marker])} ] && echo ${SWITCH_MARKER}
docker inspect -f '{{.Name}} {{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' ${CADDY_CONTAINER} ${TRAEFIK_CONTAINER} 2>/dev/null
docker info >/dev/null`,
			);
			// A marker that outlives the wait was left by a script that was
			// killed, and Docker's answer stands.
			if (!stdout.includes(SWITCH_MARKER) || attempt === 59) {
				if (stdout.includes(`/${CADDY_CONTAINER} running always`)) return "caddy";
				if (stdout.includes(`/${TRAEFIK_CONTAINER} running`)) return "traefik";
				return undefined;
			}
		} catch {}
		await sleep(5000);
	}
};

const switchToCaddy = async (serverId: ServerId) => {
	const { MAIN_CADDY_PATH } = paths(!!serverId);
	const { caddyfile } = renderCaddyfile(await loadCaddyState(serverId));
	const bundle = certificateBundle(
		readAcme(await readTraefikFiles(serverId)).text,
	);
	// The bundle holds private keys. The script unpacks and deletes it.
	const prepare = `umask 077 && mkdir -p ${quote([`${MAIN_CADDY_PATH}/data`])} && : > ${quote([`${MAIN_CADDY_PATH}/data/certificates.import`])}`;
	await run(serverId, prepare);
	await write(serverId, `${MAIN_CADDY_PATH}/data/certificates.import`, bundle);
	await write(serverId, `${MAIN_CADDY_PATH}/Caddyfile`, caddyfile);
	// Before the script, so that every state other than the intended one is
	// loud: a sync against a Caddy that is not running fails with an error. The
	// other order could leave Caddy serving while the column says Traefik.
	await setWebServerProvider("caddy", serverId);
	await run(serverId, switchToCaddyScript(cutoverOptions(serverId)));
};

// The column stays on Caddy until Docker confirms Traefik: if this is cut
// short, a later change then fails with an error instead of being skipped
// for a Caddy that still serves.
const switchToTraefik = async (serverId: ServerId) => {
	const { stdout } = await run(
		serverId,
		switchToTraefikScript(cutoverOptions(serverId)),
	);
	const recreated = stdout.split("\n").includes("missing");
	if (recreated) {
		await initializeStandaloneTraefik({ serverId: serverId ?? undefined });
	}
	await reconnectServicesToTraefik(serverId ?? undefined);
	return recreated;
};

// Traefik's files were written all along, but its writers swallow errors, so
// every application and preview domain is written once more.
const rewriteTraefikFiles = async (serverId: ServerId) => {
	for (const domain of await findServerDomains(serverId)) {
		const applicationId =
			domain.applicationId ?? domain.previewDeployment?.applicationId;
		if (!applicationId) continue;
		try {
			const application = await findApplicationById(applicationId);
			if (domain.previewDeployment) {
				application.appName = domain.previewDeployment.appName;
			}
			await manageDomain(application, domain);
		} catch (error) {
			console.error(`Traefik config for ${domain.host}:`, error);
		}
	}
};

/**
 * Refuses while the dry run has blockers or unaccepted items, then switches
 * in the background: on the Dokploy host the dashboard is reached through the
 * proxy being replaced, so the request cannot wait for the outcome. It is
 * recorded for `caddySwitch` to return.
 */
export const switchWebServer = async (
	target: WebServerProvider,
	serverId: string | null | undefined,
	acknowledged: boolean,
) => {
	if (caddySwitch(serverId)?.status === "running") {
		throw new Error("A switch is already running on this server.");
	}
	// Before the first await, so that a second request is refused above.
	caddySwitch(serverId, { target, status: "running", message: "" });
	try {
		const check = await checkWebServerSwitch(target, serverId);
		if (check.blockers.length) throw new Error(check.blockers.join("\n"));
		if (check.acknowledge.length && !acknowledged) {
			throw new Error(
				"Some of Traefik's configuration will stop applying. Accept that before switching.",
			);
		}
	} catch (error) {
		caddySwitch(serverId, { target, status: "failed", message: said(error) });
		throw error;
	}

	// In the queue, so that no sync and no second switch can interleave.
	void withCaddyQueue(serverId, async () => {
		let failure = "";
		let recreated = false;
		try {
			if (target === "caddy") await switchToCaddy(serverId);
			else recreated = await switchToTraefik(serverId);
		} catch (error) {
			failure = said(error);
		}
		// Whatever the script reported, the column follows what Docker says.
		let serving = await servingProvider(serverId);
		if (target === "traefik" && serving !== "traefik") {
			// As the script's own restore does: a Traefik that is not serving must
			// not come back with the Docker daemon either.
			await run(
				serverId,
				`docker stop ${TRAEFIK_CONTAINER} >/dev/null 2>&1
docker update --restart no ${TRAEFIK_CONTAINER} >/dev/null 2>&1
docker update --restart always ${CADDY_CONTAINER} && docker start ${CADDY_CONTAINER}`,
			).catch(() => {});
			serving = await servingProvider(serverId);
		}
		// With neither confirmed the column stays on Caddy, the value that makes
		// every later change fail with an error instead of going stale quietly.
		await setWebServerProvider(serving ?? "caddy", serverId);
		if (serving === "caddy") await applyCaddy(serverId, true);
		else if (serving === "traefik") await rewriteTraefikFiles(serverId);

		const names = { caddy: "Caddy", traefik: "Traefik" };
		if (serving !== target) {
			throw new Error(
				[
					failure,
					serving
						? `${names[serving]} is serving.`
						: "Docker did not confirm that either proxy is serving. Check the server.",
				]
					.filter(Boolean)
					.join("\n"),
			);
		}
		return recreated
			? "Traefik is serving. Its container had been removed, so it was created again with the default ports and environment."
			: `${names[serving]} is serving.`;
	}).then(
		(message) => caddySwitch(serverId, { target, status: "done", message }),
		(error) =>
			caddySwitch(serverId, { target, status: "failed", message: said(error) }),
	);
};
