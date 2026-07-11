import { beforeEach, expect, test, vi } from "vitest";

const updateMock = vi.hoisted(() => vi.fn());
const setMock = vi.hoisted(() => vi.fn());
const whereMock = vi.hoisted(() => vi.fn());
const returningMock = vi.hoisted(() => vi.fn());
const findFirstMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server/db", () => ({
	db: {
		update: updateMock,
		query: {
			applications: { findFirst: findFirstMock },
		},
	},
}));

import { prepareImmutableApplicationImage } from "@dokploy/server/services/application-image";

const digestImage = `ghcr.io/example/app@sha256:${"a".repeat(64)}`;

beforeEach(() => {
	vi.clearAllMocks();
	updateMock.mockReturnValue({ set: setMock });
	setMock.mockReturnValue({ where: whereMock });
	whereMock.mockReturnValue({ returning: returningMock });
});

test("atomically changes only dockerImage and returns sanitized provider metadata", async () => {
	returningMock.mockResolvedValue([
		{
			applicationId: "app-1",
			dockerImage: digestImage,
			sourceType: "docker",
			registryUrl: "ghcr.io",
			usernameConfigured: true,
			passwordConfigured: true,
		},
	]);

	const result = await prepareImmutableApplicationImage({
		applicationId: "app-1",
		expectedCurrentImage: "ghcr.io/example/app:sha-old",
		candidateImage: digestImage,
	});

	expect(setMock).toHaveBeenCalledWith({ dockerImage: digestImage });
	expect(result).toEqual({
		applicationId: "app-1",
		previous: {
			dockerImage: "ghcr.io/example/app:sha-old",
			sourceType: "docker",
			registryUrl: "ghcr.io",
			usernameConfigured: true,
			passwordConfigured: true,
		},
		current: {
			dockerImage: digestImage,
			sourceType: "docker",
			registryUrl: "ghcr.io",
			usernameConfigured: true,
			passwordConfigured: true,
		},
	});
});

test("rejects stale expected image state without a fallback write", async () => {
	returningMock.mockResolvedValue([]);
	findFirstMock.mockResolvedValue({
		applicationId: "app-1",
		dockerImage: "ghcr.io/example/app:sha-newer",
		sourceType: "docker",
	});

	await expect(
		prepareImmutableApplicationImage({
			applicationId: "app-1",
			expectedCurrentImage: "ghcr.io/example/app:sha-old",
			candidateImage: digestImage,
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });

	expect(updateMock).toHaveBeenCalledOnce();
});

test("rejects a mutable candidate before touching the database", async () => {
	await expect(
		prepareImmutableApplicationImage({
			applicationId: "app-1",
			expectedCurrentImage: "ghcr.io/example/app:sha-old",
			candidateImage: "ghcr.io/example/app:sha-new",
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });

	expect(updateMock).not.toHaveBeenCalled();
});
