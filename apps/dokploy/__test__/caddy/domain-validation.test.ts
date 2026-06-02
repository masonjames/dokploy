import { domain, domainCompose } from "@dokploy/server/db/validations/domain";
import { describe, expect, test } from "vitest";

describe("domain validation", () => {
	test("does not require a custom certificate resolver when HTTPS is disabled", () => {
		expect(
			domain.safeParse({
				host: "example.com",
				https: false,
				certificateType: "none",
			}).success,
		).toBe(true);

		expect(
			domainCompose.safeParse({
				host: "example.com",
				https: false,
				certificateType: "none",
				serviceName: "web",
			}).success,
		).toBe(true);
	});

	test("requires a custom certificate resolver for HTTPS custom certificates", () => {
		const result = domain.safeParse({
			host: "example.com",
			https: true,
			certificateType: "custom",
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						path: ["customCertResolver"],
						message: "Required when certificate type is custom",
					}),
				]),
			);
		}
	});
});
