import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("compose deletion contract", () => {
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
});
