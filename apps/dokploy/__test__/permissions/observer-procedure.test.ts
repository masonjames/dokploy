import { expect, test } from "vitest";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";

const router = createTRPCRouter({
	application: createTRPCRouter({
		immutableReleaseSnapshot: protectedProcedure.query(() => "snapshot"),
		runtimeStatus: protectedProcedure.query(() => "runtime"),
		one: protectedProcedure.query(() => "unredacted"),
		write: protectedProcedure.mutation(() => "mutated"),
	}),
});

const caller = (role: "member" | "observer") =>
	router.createCaller({
		session: {
			userId: "user-1",
			activeOrganizationId: "org-1",
		},
		user: {
			id: "user-1",
			role,
			ownerId: "owner-1",
			email: "observer@example.com",
			enableEnterpriseFeatures: false,
			isValidEnterpriseLicense: false,
		},
		req: { headers: {} },
		res: {},
	} as never);

test("observer can query only normalized release observations", async () => {
	await expect(
		caller("observer").application.immutableReleaseSnapshot(),
	).resolves.toBe("snapshot");
	await expect(caller("observer").application.runtimeStatus()).resolves.toBe(
		"runtime",
	);
	await expect(caller("observer").application.one()).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(caller("observer").application.write()).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
});

test("the observer veto does not change member procedures", async () => {
	await expect(caller("member").application.one()).resolves.toBe("unredacted");
	await expect(caller("member").application.write()).resolves.toBe("mutated");
});
