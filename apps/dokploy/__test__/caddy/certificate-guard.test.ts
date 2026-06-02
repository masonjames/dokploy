import { beforeEach, expect, test, vi } from "vitest";

const certificatesFindFirstMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			certificates: {
				findFirst: certificatesFindFirstMock,
			},
		},
	},
}));

import type { Domain } from "@dokploy/server";
import { assertCaddyDomainCertificateAvailable } from "@dokploy/server/utils/caddy/domain";

const domain = (overrides: Partial<Domain> = {}) =>
	({
		domainId: "domain-1",
		applicationId: "app-1",
		composeId: null,
		previewDeploymentId: null,
		domainType: "application",
		host: "example.com",
		path: "/",
		internalPath: "/",
		stripPath: false,
		https: true,
		certificateType: "custom",
		customCertResolver: "certificate-uploaded",
		customEntrypoint: null,
		middlewares: null,
		port: 3000,
		serviceName: null,
		uniqueConfigKey: 7,
		createdAt: "",
		...overrides,
	}) as Domain;

beforeEach(() => {
	vi.clearAllMocks();
});

test("allows uploaded Caddy certificates assigned to the same server", async () => {
	certificatesFindFirstMock.mockResolvedValue({
		certificatePath: "certificate-uploaded",
		serverId: "server-1",
	});

	await expect(
		assertCaddyDomainCertificateAvailable("server-1", domain()),
	).resolves.toBeUndefined();
});

test("rejects missing or cross-server Caddy certificate paths", async () => {
	certificatesFindFirstMock.mockResolvedValueOnce(null);
	await expect(
		assertCaddyDomainCertificateAvailable(null, domain()),
	).rejects.toThrow("is not available for this server");

	certificatesFindFirstMock.mockResolvedValueOnce({
		certificatePath: "certificate-uploaded",
		serverId: "server-2",
	});
	await expect(
		assertCaddyDomainCertificateAvailable("server-1", domain()),
	).rejects.toThrow("is not available for this server");
});
