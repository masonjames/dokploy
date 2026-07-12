import { beforeEach, expect, test, vi } from "vitest";

const transactionMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server/db", () => ({
	db: { transaction: transactionMock },
}));

import { custom, notifications } from "@dokploy/server/db/schema";
import { removeNotificationById } from "@dokploy/server/services/notification";

beforeEach(() => {
	vi.clearAllMocks();
});

test("deletes a custom notification and its provider record atomically", async () => {
	const deletedNotification = {
		notificationId: "notification-1",
		name: "Expired webhook",
	};
	const notificationWhere = vi.fn(() => ({
		returning: vi.fn().mockResolvedValue([deletedNotification]),
	}));
	const providerWhere = vi.fn().mockResolvedValue(undefined);
	const deleteMock = vi.fn((table) => ({
		where: table === notifications ? notificationWhere : providerWhere,
	}));
	const findFirst = vi
		.fn()
		.mockResolvedValueOnce({
			notificationId: "notification-1",
			notificationType: "custom",
			customId: "custom-1",
		})
		.mockResolvedValueOnce(undefined);

	transactionMock.mockImplementation(async (callback) =>
		callback({
			query: { notifications: { findFirst } },
			delete: deleteMock,
		}),
	);

	await expect(removeNotificationById("notification-1")).resolves.toEqual(
		deletedNotification,
	);
	expect(deleteMock).toHaveBeenNthCalledWith(1, notifications);
	expect(deleteMock).toHaveBeenNthCalledWith(2, custom);
	expect(providerWhere).toHaveBeenCalledOnce();
});

test("preserves a provider record still referenced by another notification", async () => {
	const notificationWhere = vi.fn(() => ({
		returning: vi
			.fn()
			.mockResolvedValue([{ notificationId: "notification-1" }]),
	}));
	const deleteMock = vi.fn(() => ({ where: notificationWhere }));
	const findFirst = vi
		.fn()
		.mockResolvedValueOnce({
			notificationId: "notification-1",
			notificationType: "custom",
			customId: "shared-custom",
		})
		.mockResolvedValueOnce({ notificationId: "notification-2" });

	transactionMock.mockImplementation(async (callback) =>
		callback({
			query: { notifications: { findFirst } },
			delete: deleteMock,
		}),
	);

	await removeNotificationById("notification-1");
	expect(deleteMock).toHaveBeenCalledOnce();
	expect(deleteMock).toHaveBeenCalledWith(notifications);
});

test("does not delete a provider when the notification is already absent", async () => {
	const deleteMock = vi.fn();
	transactionMock.mockImplementation(async (callback) =>
		callback({
			query: {
				notifications: { findFirst: vi.fn().mockResolvedValue(undefined) },
			},
			delete: deleteMock,
		}),
	);

	await expect(removeNotificationById("missing")).resolves.toBeUndefined();
	expect(deleteMock).not.toHaveBeenCalled();
});
