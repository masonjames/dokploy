import { beforeEach, expect, test, vi } from "vitest";

const txInsertMock = vi.hoisted(() => vi.fn());
const transactionMock = vi.hoisted(() => vi.fn());
const dbDeleteMock = vi.hoisted(() => vi.fn());
const domainsFindFirstMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server/db", () => ({
	db: {
		transaction: transactionMock,
		query: {
			domains: {
				findFirst: domainsFindFirstMock,
			},
		},
		delete: dbDeleteMock,
	},
}));

vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: vi.fn(),
}));

vi.mock("@dokploy/server/utils/web-server/domain", () => ({
	manageWebServerDomain: vi.fn(),
}));

import { findApplicationById } from "@dokploy/server/services/application";
import { createDomain } from "@dokploy/server/services/domain";
import { manageWebServerDomain } from "@dokploy/server/utils/web-server/domain";

const domain = {
	domainId: "domain-1",
	applicationId: "app-1",
	composeId: null,
	previewDeploymentId: null,
	host: "example.com",
	uniqueConfigKey: 7,
};

const application = {
	applicationId: "app-1",
	appName: "my-app",
	serverId: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	txInsertMock.mockReturnValue({
		values: vi.fn().mockReturnValue({
			returning: vi.fn().mockResolvedValue([domain]),
		}),
	});
	transactionMock.mockImplementation(async (callback) => {
		const tx = { insert: txInsertMock };
		return callback(tx);
	});
	domainsFindFirstMock.mockResolvedValue(domain);
	dbDeleteMock.mockReturnValue({
		where: vi.fn().mockReturnValue({
			returning: vi.fn().mockResolvedValue([domain]),
		}),
	});
	vi.mocked(findApplicationById).mockResolvedValue(application as never);
});

test("creates application domains through the active web server provider", async () => {
	vi.mocked(manageWebServerDomain).mockResolvedValue(undefined as never);

	const created = await createDomain({
		host: " example.com ",
		applicationId: "app-1",
		domainType: "application",
	} as never);

	expect(created).toBe(domain);
	expect(txInsertMock).toHaveBeenCalled();
	expect(manageWebServerDomain).toHaveBeenCalledWith(application, domain);
});

test("removes the domain row again when the route cannot be created", async () => {
	vi.mocked(manageWebServerDomain).mockRejectedValueOnce(
		new Error("route write failed") as never,
	);

	await expect(
		createDomain({
			host: "example.com",
			applicationId: "app-1",
			domainType: "application",
		} as never),
	).rejects.toThrow("route write failed");

	expect(manageWebServerDomain).toHaveBeenCalledWith(application, domain);
	expect(dbDeleteMock).toHaveBeenCalled();
});

test("does not touch the web server for compose domains", async () => {
	const composeDomain = {
		...domain,
		applicationId: null,
		composeId: "compose-1",
	};
	txInsertMock.mockReturnValueOnce({
		values: vi.fn().mockReturnValue({
			returning: vi.fn().mockResolvedValue([composeDomain]),
		}),
	});

	const created = await createDomain({
		host: "example.com",
		composeId: "compose-1",
		domainType: "compose",
	} as never);

	expect(created).toBe(composeDomain);
	expect(manageWebServerDomain).not.toHaveBeenCalled();
	expect(findApplicationById).not.toHaveBeenCalled();
});
