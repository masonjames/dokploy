import { db } from "@dokploy/server/db";
import { webServerSettings } from "@dokploy/server/db/schema";
import {
	DEFAULT_WEB_SERVER_PROVIDER,
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

/**
 * Resolve the active web-server provider for the Dokploy host (no
 * `serverId`) or a remote server (`serverId` provided).
 *
 * Traefik is currently the only provider, so this always resolves to the
 * default. It is intentionally async and keyed by server so that a future
 * per-instance provider setting can be introduced behind this seam without
 * changing any call site.
 */
export const resolveWebServerProvider = async (
	_serverId?: string | null,
): Promise<WebServerProvider> => {
	return DEFAULT_WEB_SERVER_PROVIDER;
};
