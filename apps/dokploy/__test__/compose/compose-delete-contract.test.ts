import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("compose deletion contract", () => {
	const serviceSource = readFileSync(
		resolve(process.cwd(), "../../packages/server/src/services/compose.ts"),
		"utf8",
	);

	it("keeps the database record until verified runtime cleanup succeeds", () => {
		const source = readFileSync(
			resolve(process.cwd(), "server/api/routers/compose.ts"),
			"utf8",
		);
		const deleteProcedure = source.slice(
			source.indexOf("delete: protectedProcedure"),
			source.indexOf("cleanQueues: protectedProcedure"),
		);

		expect(deleteProcedure.indexOf("await removeCompose(")).toBeGreaterThan(-1);
		expect(deleteProcedure.indexOf(".delete(composeTable)")).toBeGreaterThan(
			deleteProcedure.indexOf("await removeCompose("),
		);
		expect(deleteProcedure).toContain("composeResult.serverId");
		expect(deleteProcedure).toContain("composeRecordDeleted: true");
		expect(deleteProcedure).not.toContain("catch (_) {}");
	});

	it("runs compose down from the deployed code directory and fails closed", () => {
		const removeCompose = serviceSource.slice(
			serviceSource.indexOf("export const removeCompose"),
			serviceSource.indexOf("export const startCompose"),
		);

		expect(removeCompose).toContain(
			'const projectPath = join(projectRoot, "code")',
		);
		expect(removeCompose).toContain("set -eu");
		expect(removeCompose).toContain("cd ${quote([projectPath])}");
		expect(removeCompose).toContain("-f ${quote([composePath])} down");
		expect(removeCompose).toContain("error.stdout");
		expect(removeCompose).toContain("new StackCleanupError");
	});
});
