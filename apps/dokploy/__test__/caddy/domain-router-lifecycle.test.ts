import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@dokploy/server", () => ({
	assertCaddyDomainSupported: vi.fn(),
	createComposeDomain: vi.fn(),
	createDomain: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findDomainById: vi.fn(),
	findDomainsByApplicationId: vi.fn(),
	findDomainsByComposeId: vi.fn(),
	findPreviewDeploymentById: vi.fn(),
	findServerById: vi.fn(),
	generateTraefikMeDomain: vi.fn(),
	getWebServerSettings: vi.fn(),
	manageWebServerDomain: vi.fn(),
	refreshCaddyComposeRoutes: vi.fn(),
	removeDomainById: vi.fn(),
	removeWebServerDomain: vi.fn(),
	resolveWebServerProvider: vi.fn(),
	updateDomainById: vi.fn(),
	validateDomain: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(),
}));

import {
	findApplicationById,
	findComposeById,
	findDomainById,
	findDomainsByComposeId,
	manageWebServerDomain,
	refreshCaddyComposeRoutes,
	removeDomainById,
	removeWebServerDomain,
	resolveWebServerProvider,
	updateDomainById,
} from "@dokploy/server";
import { domainRouter } from "@/server/api/routers/domain";

const application = {
	applicationId: "app-1",
	appName: "my-app",
	serverId: null,
};

const currentDomain = {
	domainId: "domain-1",
	applicationId: "app-1",
	composeId: null,
	previewDeploymentId: null,
	domainType: "application",
	host: "old.example.com",
	path: "/",
	internalPath: "/",
	stripPath: false,
	https: true,
	certificateType: "letsencrypt",
	customCertResolver: null,
	customEntrypoint: null,
	middlewares: null,
	port: 3000,
	serviceName: null,
	uniqueConfigKey: 7,
	createdAt: "",
};

const compose = {
	composeId: "compose-1",
	appName: "my-compose",
	serverId: null,
};

const currentComposeDomain = {
	...currentDomain,
	applicationId: null,
	composeId: "compose-1",
	domainType: "compose" as const,
	serviceName: "web",
};

const siblingComposeDomain = {
	...currentComposeDomain,
	domainId: "domain-2",
	host: "sibling.example.com",
	uniqueConfigKey: 8,
};

const updateInput = {
	domainId: "domain-1",
	domainType: "application" as const,
	host: "new.example.com",
	path: "/",
	internalPath: "/",
	stripPath: false,
	https: true,
	certificateType: "letsencrypt" as const,
	customCertResolver: null,
	customEntrypoint: null,
	middlewares: null,
	port: 3000,
	serviceName: null,
};

const caller = domainRouter.createCaller({
	session: {
		userId: "user-1",
		activeOrganizationId: "org-1",
	},
	user: {
		id: "user-1",
		role: "owner",
		ownerId: "user-1",
		email: "owner@example.com",
		enableEnterpriseFeatures: true,
		isValidEnterpriseLicense: true,
	},
	req: { headers: {} },
	res: {},
} as never);

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(findDomainById).mockResolvedValue(currentDomain as never);
	vi.mocked(findApplicationById).mockResolvedValue(application as never);
	vi.mocked(findComposeById).mockResolvedValue(compose as never);
	vi.mocked(findDomainsByComposeId).mockResolvedValue([
		currentComposeDomain,
		siblingComposeDomain,
	] as never);
	vi.mocked(resolveWebServerProvider).mockResolvedValue("caddy");
	vi.mocked(manageWebServerDomain).mockResolvedValue(undefined as never);
	vi.mocked(removeWebServerDomain).mockResolvedValue(undefined as never);
	vi.mocked(refreshCaddyComposeRoutes).mockResolvedValue(undefined as never);
});

test("restores the previous Caddy application route when domain update persistence fails", async () => {
	vi.mocked(updateDomainById).mockRejectedValueOnce(
		new Error("db update failed") as never,
	);

	await expect(caller.update(updateInput)).rejects.toThrow("db update failed");

	expect(manageWebServerDomain).toHaveBeenNthCalledWith(
		1,
		application,
		expect.objectContaining({
			domainId: "domain-1",
			host: "new.example.com",
		}),
	);
	expect(manageWebServerDomain).toHaveBeenNthCalledWith(
		2,
		application,
		currentDomain,
	);
});

test("restores the removed Caddy application route when domain delete persistence fails", async () => {
	vi.mocked(removeDomainById).mockRejectedValueOnce(
		new Error("db delete failed") as never,
	);

	await expect(caller.delete({ domainId: "domain-1" })).rejects.toThrow(
		"db delete failed",
	);

	expect(removeWebServerDomain).toHaveBeenCalledWith(application, 7);
	expect(manageWebServerDomain).toHaveBeenCalledWith(
		application,
		currentDomain,
	);
});

test("restores previous compose domain fields when Caddy route refresh fails after update", async () => {
	const updatedDomain = {
		...currentComposeDomain,
		host: "new.example.com",
	};
	vi.mocked(findDomainById).mockResolvedValueOnce(
		currentComposeDomain as never,
	);
	vi.mocked(updateDomainById)
		.mockResolvedValueOnce(updatedDomain as never)
		.mockResolvedValueOnce(currentComposeDomain as never);
	vi.mocked(refreshCaddyComposeRoutes)
		.mockRejectedValueOnce(new Error("caddy refresh failed") as never)
		.mockResolvedValueOnce(undefined as never);

	await expect(
		caller.update({
			...updateInput,
			domainType: "compose",
			serviceName: "web",
		}),
	).rejects.toThrow("caddy refresh failed");

	expect(updateDomainById).toHaveBeenNthCalledWith(
		1,
		"domain-1",
		expect.objectContaining({
			host: "new.example.com",
			domainType: "compose",
			serviceName: "web",
		}),
	);
	expect(updateDomainById).toHaveBeenNthCalledWith(
		2,
		"domain-1",
		expect.objectContaining({
			host: "old.example.com",
			domainType: "compose",
			serviceName: "web",
		}),
	);
	expect(refreshCaddyComposeRoutes).toHaveBeenNthCalledWith(
		2,
		compose,
		undefined,
		"caddy",
	);
});

test("restores all compose routes when compose domain delete persistence fails", async () => {
	vi.mocked(findDomainById).mockResolvedValueOnce(
		currentComposeDomain as never,
	);
	vi.mocked(removeDomainById).mockRejectedValueOnce(
		new Error("db delete failed") as never,
	);

	await expect(caller.delete({ domainId: "domain-1" })).rejects.toThrow(
		"db delete failed",
	);

	expect(refreshCaddyComposeRoutes).toHaveBeenNthCalledWith(
		1,
		compose,
		[siblingComposeDomain],
		"caddy",
	);
	expect(refreshCaddyComposeRoutes).toHaveBeenNthCalledWith(
		2,
		compose,
		undefined,
		"caddy",
	);
});
