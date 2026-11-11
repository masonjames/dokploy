import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import packageInfo from "../../package.json";

it("runs the migration through pnpm after setup", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "setup-script-"));
	try {
		for (const command of ["tsx", "sleep", "pnpm"]) {
			const shim = path.join(directory, command);
			writeFileSync(
				shim,
				`#!/bin/sh\necho '${command}' "$@" >> '${directory}/calls'\n`,
			);
			chmodSync(shim, 0o755);
		}
		execFileSync("/bin/sh", ["-c", packageInfo.scripts.setup], {
			env: { ...process.env, PATH: directory },
		});
		expect(readFileSync(path.join(directory, "calls"), "utf8")).toContain(
			"pnpm run migration:run",
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
