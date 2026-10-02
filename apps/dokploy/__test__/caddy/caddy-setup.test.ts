import { execFileSync } from "node:child_process";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { setWebServerProvider } from "@dokploy/server/services/web-server-settings";
import {
	checkWebServerSwitch,
	switchWebServer,
} from "@dokploy/server/setup/caddy-setup";
import {
	getDefaultMiddlewares,
	getDefaultServerTraefikConfig,
	initializeStandaloneTraefik,
} from "@dokploy/server/setup/traefik-setup";
import {
	certificateBundle,
	switchToCaddyScript,
	switchToTraefikScript,
} from "@dokploy/server/utils/caddy/cutover";
import {
	caddyFilePath,
	saveCaddyFile,
} from "@dokploy/server/utils/caddy/files";
import { caddySwitch } from "@dokploy/server/utils/caddy/sync";
import { createDomainLabels } from "@dokploy/server/utils/docker/domain";
import {
	ExecError,
	execAsyncRemote,
	writeFileRemote,
} from "@dokploy/server/utils/process/execAsync";
import { manageDomain } from "@dokploy/server/utils/traefik/domain";
import { createRedirectMiddleware } from "@dokploy/server/utils/traefik/redirect";
import { createSecurityMiddleware } from "@dokploy/server/utils/traefik/security";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

vi.mock("@dokploy/server/utils/process/execAsync", async (original) => ({
	...(await original<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	sleep: vi.fn(),
}));
vi.mock("@dokploy/server/services/web-server-settings", async (original) => ({
	...(await original<
		typeof import("@dokploy/server/services/web-server-settings")
	>()),
	getWebServerSettings: vi.fn(),
	getWebServerProvider: vi.fn(async () => provider),
	setWebServerProvider: vi.fn(async (next: string) => {
		provider = next;
	}),
}));
vi.mock("@dokploy/server/setup/traefik-setup", async (original) => ({
	...(await original<typeof import("@dokploy/server/setup/traefik-setup")>()),
	initializeStandaloneTraefik: vi.fn(),
}));

const SERVER = "remote";
const root = paths(true).MAIN_CADDY_PATH;
const traefikRoot = paths(true).MAIN_TRAEFIK_PATH;
const application = {
	appName: "app",
	serverId: SERVER,
	security: [] as { username: string; password: string }[],
	redirects: [] as {
		uniqueConfigKey: number;
		regex: string;
		replacement: string;
		permanent: boolean;
	}[],
	previewDeployments: [],
};
const domain = (key: number, overrides: object = {}) => ({
	host: `host${key}.test`,
	uniqueConfigKey: key,
	applicationId: "app-id",
	application,
	compose: null as { appName: string; serverId: string } | null,
	previewDeployment: null,
	enabled: true,
	https: false,
	path: "/",
	internalPath: "/",
	stripPath: false,
	port: 80,
	customEntrypoint: null,
	middlewares: [] as string[],
	forwardAuthEnabled: false,
	certificateType: "none",
	...overrides,
});

// What the server looks like to the code under test.
let provider: string;
let rows: ReturnType<typeof domain>[];
let traefikFiles: Record<string, string>;
// Every running container with its labels.
let containers: Record<string, Record<string, string>>;
let script: () => string;
let docker: string;
let caddyAccepts: boolean;
let traefikContainer: string;
let written: Record<string, string>;
let providerWhenScriptRan: string;

beforeEach(() => {
	vi.clearAllMocks();
	(
		globalThis as unknown as {
			__dokployCaddySync: { switches: Map<string, unknown> };
		}
	).__dokployCaddySync.switches.clear();
	provider = "traefik";
	rows = [domain(1)];
	traefikFiles = {
		"traefik.yml": getDefaultServerTraefikConfig(),
		"dynamic/middlewares.yml": getDefaultMiddlewares(),
	};
	containers = {};
	application.security = [];
	application.redirects = [];
	script = () => "Caddy is serving";
	docker = "/dokploy-caddy running always\n/dokploy-traefik exited no";
	caddyAccepts = true;
	traefikContainer = "standalone";
	written = {};
	vi.mocked(db.query.domains.findMany).mockImplementation(((config: {
		with?: object;
	}) =>
		Promise.resolve(
			!config?.with
				? []
				: "previewDeployments" in config.with
					? [application]
					: rows,
		)) as never);
	const traefikFile = (file: string) =>
		file.startsWith(`${traefikRoot}/`)
			? file.slice(traefikRoot.length + 1)
			: undefined;
	vi.mocked(writeFileRemote).mockImplementation(async (_, file, content) => {
		written[file] = content;
		const name = traefikFile(file);
		if (name) traefikFiles[name] = content;
	});
	vi.mocked(execAsyncRemote).mockImplementation(async (_, command) => {
		const reply = (stdout: string) => ({ stdout, stderr: "" });
		if (command.includes("for file in traefik.yml")) {
			return reply(
				Object.entries(traefikFiles)
					.map(
						([name, content]) =>
							`${name}\t${Buffer.from(content).toString("base64")}`,
					)
					.join("\n"),
			);
		}
		if (command.includes("RESOURCE_NAME=")) return reply(traefikContainer);
		if (command.includes("{{json .Config.Labels}}")) {
			return reply(
				Object.entries(containers)
					.map(([name, labels]) => `/${name} ${JSON.stringify(labels)}`)
					.join("\n"),
			);
		}
		if (command.includes("docker ps -q")) {
			return reply(
				Object.entries(containers)
					.map(([name, labels]) => `/${name} ${Object.keys(labels).join(" ")}`)
					.join("\n"),
			);
		}
		if (command.includes(".NetworkSettings.Ports")) return reply("null");
		if (command.startsWith("caddy=")) {
			providerWhenScriptRan = provider;
			return reply(script());
		}
		if (command.includes(".HostConfig.RestartPolicy.Name"))
			return reply(docker);
		if (command.startsWith("cat ")) {
			const file = command.slice(4);
			const name = traefikFile(file);
			return reply(
				name
					? (traefikFiles[name] ?? "")
					: (written[file] ?? "previous content"),
			);
		}
		if (/caddy (validate|reload)/.test(command) && !caddyAccepts) {
			throw new ExecError("failed", {
				command,
				stderr: "log line\nError: sites/custom.caddy:1: unrecognized directive",
			});
		}
		return reply("");
	});
});

const settled = () =>
	vi.waitFor(() => {
		const outcome = caddySwitch(SERVER);
		expect(outcome?.status).not.toBe("running");
		return outcome;
	});

it("generates switch scripts that sh accepts", () => {
	const options = {
		image: "caddy:2.11.4",
		caddy: "dokploy-caddy",
		traefik: "dokploy-traefik",
		network: "dokploy-network",
		publish: ["80:80", "443:443", "443:443/udp"],
		caddyPath: "/folder with spaces/caddy",
		certificatesPath: "/certificates",
	};
	for (const text of [
		switchToCaddyScript(options),
		switchToTraefikScript(options),
	]) {
		execFileSync("sh", ["-n"], { input: text });
	}
});

describe("certificateBundle", () => {
	const issue = (names: string[], days = "30") => {
		const pem = execFileSync(
			"openssl",
			`req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days ${days} -subj /CN=${names[0]} -addext subjectAltName=${names.map((name) => `DNS:${name}`).join(",")} -keyout /dev/stdout -out /dev/stdout`.split(
				" ",
			),
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		const part = (label: string) =>
			Buffer.from(
				pem.match(
					new RegExp(
						`-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`,
					),
				)?.[0] ?? "",
			).toString("base64");
		return { certificate: part("CERTIFICATE"), key: part("PRIVATE KEY") };
	};

	it("carries valid certificates, one line per name, and leaves the rest", () => {
		const single = issue(["carry.test"]);
		const acme = {
			letsencrypt: {
				Certificates: [
					{ domain: { main: "carry.test" }, ...single },
					{
						domain: { main: "a.test", sans: ["B.test"] },
						...issue(["a.test", "B.test"]),
					},
					{ domain: { main: "*.wild.test" }, ...issue(["*.wild.test"]) },
					{
						domain: { main: "wrong-key.test" },
						...issue(["wrong-key.test"]),
						key: single.key,
					},
					// Valid for one day: carried today, left out once it has expired.
					{ domain: { main: "old.test" }, ...issue(["old.test"], "1") },
				],
			},
		};
		const names = (now?: Date) =>
			certificateBundle(JSON.stringify(acme), now)
				.split("\n")
				.map((line) => line.split(" ")[0]?.split("/").pop());
		expect(names()).toEqual(["carry.test", "a.test", "b.test", "old.test"]);
		expect(names(new Date(Date.now() + 2 * 86400000))).toEqual([
			"carry.test",
			"a.test",
			"b.test",
		]);
		expect(certificateBundle("{}")).toBe("");
	});
});

describe("the dry run", () => {
	it("blocks on every setting Caddy cannot honour and on a refused route", async () => {
		rows = [
			domain(1, { forwardAuthEnabled: true }),
			domain(2, { middlewares: ["private"] }),
			domain(3, { customEntrypoint: "other" }),
			domain(4, { certificateType: "custom" }),
			domain(5, { path: "/a`b" }),
			domain(6, { enabled: false, forwardAuthEnabled: true }),
		];
		const { blockers } = await checkWebServerSwitch("caddy", SERVER);
		expect(blockers).toEqual([
			"host1.test: Forward auth is not available with Caddy.",
			"host2.test: A custom middleware is not available with Caddy.",
			"host3.test: A custom entrypoint is not available with Caddy.",
			"host4.test: A custom certificate resolver is not available with Caddy.",
			"host5.test/a`b: one of this domain's values cannot be written for Caddy.",
		]);
	});

	it("blocks when Caddy rejects the candidate, with Caddy's own message", async () => {
		caddyAccepts = false;
		const { blockers } = await checkWebServerSwitch("caddy", SERVER);
		expect(blockers).toEqual([
			"Caddy rejects the configuration. Error: sites/custom.caddy:1: unrecognized directive",
		]);
		expect(written[`${root}/Caddyfile.check`]).toContain("host1.test");
		expect(written[`${root}/Caddyfile`]).toBeUndefined();
	});

	// A server as Dokploy's own Traefik writers leave it: two domains of one
	// application with basic auth and a redirect, and a deployed compose.
	const configure = async () => {
		application.security = [{ username: "ops", password: "secret" }];
		application.redirects = [
			{
				uniqueConfigKey: 3,
				regex: "^http://old.test/(.*)",
				replacement: "http://new.test/$1",
				permanent: true,
			},
		];
		rows = [
			domain(1, {
				https: true,
				certificateType: "letsencrypt",
				path: "/api",
				stripPath: true,
				internalPath: "/v1",
			}),
			domain(2),
			domain(4, {
				application: null,
				applicationId: null,
				compose: { appName: "shop", serverId: SERVER },
			}),
		];
		const [first, second, shop] = rows;
		// In the order an admin would: a domain, protection, another domain.
		await manageDomain(application as never, first as never);
		await createSecurityMiddleware(
			application as never,
			application.security[0] as never,
		);
		await createRedirectMiddleware(
			application as never,
			application.redirects[0] as never,
		);
		await manageDomain(application as never, second as never);
		containers = {
			"shop-web-1": Object.fromEntries(
				[
					"traefik.enable=true",
					"traefik.docker.network=dokploy-network",
					...createDomainLabels("shop", shop as never, "web"),
				].map((label) => {
					const at = label.indexOf("=");
					return [label.slice(0, at), label.slice(at + 1)];
				}),
			),
			// Not enabled, so Traefik does not read it.
			idle: { "traefik.http.routers.idle.rule": "Host(`idle.test`)" },
		};
	};
	const edit = (
		name: string,
		change: (config: {
			http: {
				routers: Record<
					string,
					{ rule: string; service: string; middlewares: string[] }
				>;
				services: Record<string, unknown>;
				middlewares: Record<string, unknown>;
			};
		}) => void,
	) => {
		const config = parse(traefikFiles[name] ?? "");
		change(config);
		traefikFiles[name] = stringify(config);
	};

	it("asks for nothing on a server only Dokploy has configured", async () => {
		await configure();
		const check = await checkWebServerSwitch("caddy", SERVER);
		expect(check.acknowledge).toEqual([]);
		expect(check.blockers).toEqual([]);
	});

	it.each<[string, () => void, string]>([
		[
			"another kind of middleware under a name Dokploy uses",
			() =>
				edit("dynamic/middlewares.yml", ({ http }) => {
					http.middlewares["auth-app"] = {
						ipAllowList: { sourceRange: ["10.0.0.0/8"] },
					};
				}),
			"dynamic/middlewares.yml: the middleware auth-app is not the one Dokploy writes. Caddy follows the database, not this file.",
		],
		[
			"a basic auth user that is not in the database",
			() =>
				edit("dynamic/middlewares.yml", ({ http }) => {
					(
						http.middlewares["auth-app"] as { basicAuth: { users: string[] } }
					).basicAuth.users.push("guest:$2b$10$abcdefghijklmnopqrstuv");
				}),
			"dynamic/middlewares.yml: the middleware auth-app is not the one Dokploy writes. Caddy follows the database, not this file.",
		],
		[
			"a password that is not the one in the database",
			() => {
				application.security = [{ username: "ops", password: "changed" }];
			},
			"dynamic/middlewares.yml: the middleware auth-app is not the one Dokploy writes. Caddy follows the database, not this file.",
		],
		[
			"a redirect that is not the one in the database",
			() =>
				edit("dynamic/middlewares.yml", ({ http }) => {
					http.middlewares["redirect-app-3"] = {
						redirectRegex: { regex: "^http://old.test/", replacement: "/" },
					};
				}),
			"dynamic/middlewares.yml: the middleware redirect-app-3 is not the one Dokploy writes. Caddy follows the database, not this file.",
		],
		[
			"a rule that restricts a router by client address",
			() =>
				edit("dynamic/app.yml", ({ http }) => {
					const router = http.routers["app-router-2"];
					if (router) router.rule += " && ClientIP(`10.0.0.0/8`)";
				}),
			"dynamic/app.yml: the router app-router-2 is not the one Dokploy writes for a domain. Caddy follows the database, not this file.",
		],
		[
			"a router Dokploy has no domain for",
			() =>
				edit("dynamic/app.yml", ({ http }) => {
					http.routers.mine = {
						rule: "Host(`mine.test`)",
						service: "app-service-2",
						middlewares: [],
					};
				}),
			"dynamic/app.yml: the router mine is not the one Dokploy writes for a domain. Caddy follows the database, not this file.",
		],
		[
			"a middleware of its own on a router",
			() => {
				edit("dynamic/middlewares.yml", ({ http }) => {
					http.middlewares["office-only"] = {
						ipAllowList: { sourceRange: ["10.0.0.0/8"] },
					};
				});
				edit("dynamic/app.yml", ({ http }) => {
					http.routers["app-router-2"]?.middlewares.push("office-only");
				});
			},
			"dynamic/app.yml: the router app-router-2 uses the middleware office-only, which Caddy will not apply.",
		],
		[
			"a service that points somewhere else",
			() =>
				edit("dynamic/app.yml", ({ http }) => {
					http.services["app-service-2"] = {
						loadBalancer: { servers: [{ url: "http://elsewhere:80" }] },
					};
				}),
			"dynamic/app.yml: the service app-service-2 is not the one Dokploy writes for a domain. Caddy follows the database, not this file.",
		],
		[
			"a middleware attached to a compose router by label",
			() => {
				const labels = containers["shop-web-1"];
				if (labels) {
					labels["traefik.http.routers.shop-4-web.middlewares"] = "office-only";
				}
			},
			"shop-web-1 has Traefik labels that do not come from a domain in Dokploy: traefik.http.routers.shop-4-web.middlewares. Caddy will not apply them.",
		],
		[
			"a compose rule that is not the domain's",
			() => {
				const labels = containers["shop-web-1"];
				if (labels) {
					labels["traefik.http.routers.shop-4-web.rule"] = "Host(`other.test`)";
				}
			},
			"shop-web-1 has Traefik labels that do not come from a domain in Dokploy: traefik.http.routers.shop-4-web.rule. Caddy will not apply them.",
		],
		[
			"a container routed by labels of its own",
			() => {
				containers.blog = {
					"Traefik.Enable": "True",
					"traefik.http.routers.blog.rule": "Host(`blog.test`)",
				};
			},
			"blog has Traefik labels that do not come from a domain in Dokploy: traefik.http.routers.blog.rule. Caddy will not apply them.",
		],
	])("finds %s", async (_, change, expected) => {
		await configure();
		change();
		const { acknowledge } = await checkWebServerSwitch("caddy", SERVER);
		expect(acknowledge).toEqual([expected]);
	});

	it("lists files, sections and static configuration Dokploy did not write", async () => {
		traefikFiles["dynamic/app.yml"] = "tcp:\n  routers: {}";
		traefikFiles["dynamic/mine.yml"] = "http: {}";
		traefikFiles["traefik.yml"] += "\nexperimental:\n  plugins: {}\n";
		const { acknowledge } = await checkWebServerSwitch("caddy", SERVER);
		expect(acknowledge).toEqual([
			"dynamic/app.yml has a tcp section. Caddy will not apply it.",
			"dynamic/mine.yml was not written by Dokploy. Caddy will not read it.",
			"traefik.yml differs from the one Dokploy writes today. Caddy does not read that file.",
		]);
	});

	it("warns about HTTPS hosts without a certificate to take over, and compose domains with nothing running", async () => {
		rows = [
			domain(1, { https: true, certificateType: "letsencrypt" }),
			domain(2, { compose: { appName: "shop", serverId: SERVER } }),
			// No certificate provider: answered with Caddy's own certificate
			// until it has another, as Traefik does with its self-signed one.
			domain(3, { https: true }),
		];
		const { warnings } = await checkWebServerSwitch("caddy", SERVER);
		expect(warnings).toEqual([
			"Traefik holds no certificate that Caddy can take over for host1.test. Caddy asks Let's Encrypt for one when it starts, and these do not answer over HTTPS until it has one. Traefik answers with a self-signed certificate in that case. For a domain Let's Encrypt cannot validate, choose the certificate provider None, which keeps that behaviour.",
			"host2.test has no running container, so it gets its route at that compose's next deploy.",
		]);
	});

	it("names the Requests page instead of calling its access log a hand edit", async () => {
		traefikFiles["traefik.yml"] +=
			"\naccessLog:\n  filePath: /etc/dokploy/traefik/dynamic/access.log\n";
		const { acknowledge } = await checkWebServerSwitch("caddy", SERVER);
		expect(acknowledge).toEqual([
			"The Requests page reads Traefik's access log. It shows nothing new while Caddy serves.",
		]);
	});

	it("reports a missing Traefik container as a blocker", async () => {
		traefikContainer = "unknown";
		const { blockers } = await checkWebServerSwitch("caddy", SERVER);
		expect(blockers).toEqual([
			"The Traefik container was not found on this server.",
		]);
	});
});

describe("the switch", () => {
	it("is refused on a blocker, and on items nobody accepted", async () => {
		traefikFiles["dynamic/mine.yml"] = "http: {}";
		await expect(switchWebServer("caddy", SERVER, false)).rejects.toThrow(
			"Accept that before switching",
		);
		rows = [domain(1, { forwardAuthEnabled: true })];
		await expect(switchWebServer("caddy", SERVER, true)).rejects.toThrow(
			"Forward auth",
		);
		expect(setWebServerProvider).not.toHaveBeenCalled();
	});

	it("records Caddy before the script runs and applies once it serves", async () => {
		await switchWebServer("caddy", SERVER, false);
		expect(await settled()).toEqual({
			target: "caddy",
			status: "done",
			message: "Caddy is serving.",
		});
		expect(providerWhenScriptRan).toBe("caddy");
		expect(provider).toBe("caddy");
		expect(written[`${root}/Caddyfile`]).toContain("host1.test");
		expect(execAsyncRemote).toHaveBeenLastCalledWith(
			SERVER,
			expect.stringContaining(
				"caddy reload --config /etc/caddy/Caddyfile --force",
			),
		);
	});

	it("follows Docker back to Traefik when the script fails, with Caddy's error and not its log", async () => {
		script = () => {
			throw new ExecError("failed", {
				command: "script",
				stderr:
					'{"level":"info","msg":"maxprocs: Leaving GOMAXPROCS=8"}\nError: adapting config using caddyfile: ambiguous site definition: https://a.test\n{"level":"info","msg":"another line"}\nCaddy did not start, so Traefik is serving again\n',
			});
		};
		docker = "/dokploy-traefik running always";
		await switchWebServer("caddy", SERVER, false);
		expect(await settled()).toEqual({
			target: "caddy",
			status: "failed",
			message:
				"Error: adapting config using caddyfile: ambiguous site definition: https://a.test\nCaddy did not start, so Traefik is serving again\nTraefik is serving.",
		});
		expect(provider).toBe("traefik");
	});

	it("waits for a script that outlived its connection", async () => {
		script = () => {
			throw new Error("SSH connection error");
		};
		const answers = [
			"switching\n/dokploy-traefik running no",
			"switching\n/dokploy-caddy running no",
			"/dokploy-caddy running always",
		];
		const dispatch = vi.mocked(execAsyncRemote).getMockImplementation();
		vi.mocked(execAsyncRemote).mockImplementation(async (id, command) =>
			command.includes(".HostConfig.RestartPolicy.Name")
				? {
						stdout: answers.shift() ?? "/dokploy-caddy running always",
						stderr: "",
					}
				: (dispatch as NonNullable<typeof dispatch>)(id, command),
		);
		await switchWebServer("caddy", SERVER, false);
		expect((await settled())?.status).toBe("done");
		expect(provider).toBe("caddy");
	});

	it("trusts Docker over a marker that a killed script left behind", async () => {
		script = () => {
			throw new Error("SSH connection error");
		};
		docker = "switching\n/dokploy-traefik running always";
		await switchWebServer("caddy", SERVER, false);
		expect(await settled()).toMatchObject({
			status: "failed",
			message: "SSH connection error\nTraefik is serving.",
		});
		expect(provider).toBe("traefik");
	});

	it("keeps the column on Caddy until Docker confirms Traefik on the way back", async () => {
		provider = "caddy";
		script = () => "Traefik is serving";
		docker = "/dokploy-traefik running always";
		await switchWebServer("traefik", SERVER, false);
		expect((await settled())?.status).toBe("done");
		expect(providerWhenScriptRan).toBe("caddy");
		expect(provider).toBe("traefik");
	});

	it("refuses a second switch while one is being checked", async () => {
		const first = switchWebServer("caddy", SERVER, false);
		await expect(switchWebServer("caddy", SERVER, false)).rejects.toThrow(
			"already running",
		);
		await first;
		await settled();
	});

	it("puts Caddy back, and Traefik out of the way, when the way back leaves neither serving", async () => {
		provider = "caddy";
		script = () => {
			throw new Error("SSH connection error");
		};
		docker = "/dokploy-traefik restarting always";
		const dispatch = vi.mocked(execAsyncRemote).getMockImplementation();
		const commands: string[] = [];
		vi.mocked(execAsyncRemote).mockImplementation(async (id, command) => {
			if (command.includes("docker start dokploy-caddy")) {
				commands.push(command);
				docker = "/dokploy-caddy running always\n/dokploy-traefik exited no";
			}
			return (dispatch as NonNullable<typeof dispatch>)(id, command);
		});
		await switchWebServer("traefik", SERVER, false);
		expect(await settled()).toMatchObject({
			status: "failed",
			message: "SSH connection error\nCaddy is serving.",
		});
		expect(commands).toEqual([
			"docker stop dokploy-traefik >/dev/null 2>&1\ndocker update --restart no dokploy-traefik >/dev/null 2>&1\ndocker update --restart always dokploy-caddy && docker start dokploy-caddy",
		]);
		expect(provider).toBe("caddy");
	});

	it("keeps the column on Caddy when Docker confirms neither proxy", async () => {
		script = () => {
			throw new Error("SSH connection error");
		};
		docker = "";
		await switchWebServer("caddy", SERVER, false);
		expect(await settled()).toMatchObject({ status: "failed" });
		expect(provider).toBe("caddy");
	});

	it("recreates a Traefik container that Docker's cleanup removed", async () => {
		provider = "caddy";
		script = () => "missing\n";
		docker = "/dokploy-traefik running always";
		await switchWebServer("traefik", SERVER, false);
		expect((await settled())?.message).toContain("created again");
		expect(initializeStandaloneTraefik).toHaveBeenCalledWith({
			serverId: SERVER,
		});
		expect(provider).toBe("traefik");
	});
});

describe("the file browser on a Caddy server", () => {
	it("opens the Caddyfile and the files in global/ and sites/, nothing else", () => {
		for (const name of [
			"Caddyfile",
			"global/custom.caddy",
			"sites/my-site.caddy",
		]) {
			expect(caddyFilePath(`${root}/${name}`, SERVER)).toBe(`${root}/${name}`);
		}
		for (const path of [
			`${root}/data/caddy/certificates/x/x.key`,
			`${root}/config/caddy/autosave.json`,
			`${root}/sites/../data/x.caddy`,
			`${root}/sites/nested/x.caddy`,
			`${root}/sites/x.txt`,
			`${root}-backup/sites/x.caddy`,
			`${root}/Caddyfile.check`,
			"sites/x.caddy",
		]) {
			expect(() => caddyFilePath(path, SERVER)).toThrow("can be opened here");
		}
		// However a path is spelled, it is the file it resolves to that counts.
		expect(caddyFilePath(`${root}/data/../sites/x.caddy`, SERVER)).toBe(
			`${root}/sites/x.caddy`,
		);
		expect(() =>
			caddyFilePath(`${traefikRoot}/../caddy/data/x.key`, SERVER),
		).toThrow("can be opened here");
	});

	it("puts the previous content back when Caddy rejects a save", async () => {
		provider = "caddy";
		const file = `${root}/sites/custom.caddy`;
		caddyAccepts = false;
		await expect(saveCaddyFile(file, "broken", SERVER)).rejects.toThrow(
			"Error: sites/custom.caddy:1: unrecognized directive",
		);
		expect(written[file]).toBe("previous content");
		caddyAccepts = true;
		await saveCaddyFile(file, "mine.test {\n}", SERVER);
		expect(written[file]).toBe("mine.test {\n}");
		await expect(
			saveCaddyFile(`${root}/Caddyfile`, "x", SERVER),
		).rejects.toThrow("regenerates");
	});
});
