import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readSource = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("provider-neutral Caddy UI contract", () => {
	test("labels the account menu file-browser link as web-server files", () => {
		const source = readSource("../../components/layouts/user-nav.tsx");

		expect(source).toContain("permissions?.traefikFiles.read");
		expect(source).toContain('router.push("/dashboard/traefik")');
		expect(source).toContain("Web Server Files");
		expect(source).not.toMatch(/>\s*Traefik\s*</);
	});

	test("keeps custom-role file-browser permission copy provider-neutral", () => {
		const source = readSource(
			"../../components/proprietary/roles/manage-custom-roles.tsx",
		);

		expect(source).toContain("traefikFiles:");
		expect(source).toContain('label: "Web Server Files"');
		expect(source).toContain(
			'description: "Access to the active web server file browser"',
		);
		expect(source).not.toContain("Traefik Files");
		expect(source).not.toContain("Traefik file system configuration");
	});

	test("uses generic copy while active web-server provider is unresolved", () => {
		const actions = readSource(
			"../../components/dashboard/settings/servers/actions/show-traefik-actions.tsx",
		);
		const fileSystem = readSource(
			"../../components/dashboard/file-system/show-traefik-system.tsx",
		);

		expect(actions).toContain(': "Web Server";');
		expect(fileSystem).toContain('const isTraefik = provider === "traefik";');
		expect(fileSystem).toContain(
			"Provider-specific edit controls appear after Dokploy resolves the active provider.",
		);
	});
});
