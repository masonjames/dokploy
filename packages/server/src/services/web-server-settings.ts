import { db } from "@dokploy/server/db";
import { server, webServerSettings } from "@dokploy/server/db/schema";
import {
	normalizeWebServerProvider,
	type WebServerProvider,
} from "@dokploy/server/utils/web-server/providers";
import { eq } from "drizzle-orm";

/**
 * Get the web server settings (singleton - only one row should exist)
 */
export const getWebServerSettings = async () => {
	const settings = await db.query.webServerSettings.findFirst({
		orderBy: (settings, { asc }) => [asc(settings.createdAt)],
	});

	if (!settings) {
		// Create default settings if none exist
		const [newSettings] = await db
			.insert(webServerSettings)
			.values({})
			.returning();

		return newSettings;
	}

	return settings;
};

/**
 * Update web server settings
 */
export const updateWebServerSettings = async (
	updates: Partial<typeof webServerSettings.$inferInsert>,
) => {
	const current = await getWebServerSettings();

	const [updated] = await db
		.update(webServerSettings)
		.set({
			...updates,
			updatedAt: new Date(),
		})
		.where(eq(webServerSettings.id, current?.id ?? ""))
		.returning();

	return updated;
};

export const getLocalWebServerProvider = async (): Promise<WebServerProvider> => {
	const settings = await getWebServerSettings();
	return normalizeWebServerProvider(settings?.webServerProvider);
};

export const updateLocalWebServerProvider = async (
	provider: WebServerProvider,
) => {
	return updateWebServerSettings({ webServerProvider: provider });
};

export const getRemoteWebServerProvider = async (
	serverId: string,
): Promise<WebServerProvider> => {
	const remoteServer = await db.query.server.findFirst({
		where: eq(server.serverId, serverId),
		columns: {
			webServerProvider: true,
		},
	});

	if (!remoteServer) {
		throw new Error(`Server not found: ${serverId}`);
	}

	return normalizeWebServerProvider(remoteServer.webServerProvider);
};

export const updateRemoteWebServerProvider = async (
	serverId: string,
	provider: WebServerProvider,
) => {
	const [updated] = await db
		.update(server)
		.set({ webServerProvider: provider })
		.where(eq(server.serverId, serverId))
		.returning();

	return updated;
};

export const resolveWebServerProvider = async (
	serverId?: string | null,
): Promise<WebServerProvider> => {
	if (serverId) {
		return getRemoteWebServerProvider(serverId);
	}

	return getLocalWebServerProvider();
};
