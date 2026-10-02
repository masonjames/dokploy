import { execFileSync } from "node:child_process";

export const hasOpenSsl = () => {
	try {
		execFileSync("openssl", ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

/**
 * A self-signed certificate for the given names, and its key, as PEM.
 */
export const issueCertificate = (names: string[], days = 30) => {
	const pem = execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-days",
			String(days),
			"-subj",
			`/CN=${names[0]}`,
			"-addext",
			`subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`,
			"-keyout",
			"/dev/stdout",
			"-out",
			"/dev/stdout",
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	const part = (label: string) =>
		pem.match(
			new RegExp(`-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`),
		)?.[0] ?? "";
	return { certificate: part("CERTIFICATE"), key: part("PRIVATE KEY") };
};
