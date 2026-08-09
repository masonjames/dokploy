import { findServerById } from "@dokploy/server/services/server";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";

const OUTPUT_PREFIX = "DOKPLOY_CAPACITY_V1";

export interface ServerFilesystemCapacity {
	scope: "root" | "docker";
	totalBytes: number;
	usedBytes: number;
	availableBytes: number;
	usedPercent: number;
	totalInodes: number;
	usedInodes: number;
	availableInodes: number;
	inodeUsedPercent: number;
}

export interface ServerCapacityReport {
	serverId: string;
	hostname: string;
	filesystems: ServerFilesystemCapacity[];
}

export const buildServerCapacityCommand = () => `
set -eu
export LC_ALL=C
_dokploy_emit_capacity() {
	_dokploy_scope=$1
	_dokploy_target=$2
	_dokploy_blocks=$(df -Pk -- "$_dokploy_target" | awk 'NR == 2 { print $2 " " $3 " " $4 " " $5 }')
	_dokploy_inodes=$(df -Pi -- "$_dokploy_target" | awk 'NR == 2 { print $2 " " $3 " " $4 " " $5 }')
	[ -n "$_dokploy_blocks" ] && [ -n "$_dokploy_inodes" ] || {
		echo "Capacity evidence is incomplete for $_dokploy_scope" >&2
		exit 74
	}
	printf '${OUTPUT_PREFIX}\t%s\t%s\t%s\n' "$_dokploy_scope" "$_dokploy_blocks" "$_dokploy_inodes"
}
_dokploy_docker_root=$(docker info --format '{{.DockerRootDir}}')
case "$_dokploy_docker_root" in
	/*) ;;
	*) echo "DockerRootDir is not absolute" >&2; exit 74 ;;
esac
printf '${OUTPUT_PREFIX}\thostname\t%s\n' "$(hostname)"
_dokploy_emit_capacity root /
_dokploy_emit_capacity docker "$_dokploy_docker_root"
`;

const parseNumber = (value: string, label: string) => {
	const parsed = Number(value.replace(/%$/, ""));
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid server capacity value for ${label}`);
	}
	return parsed;
};

export const parseServerCapacityOutput = (
	serverId: string,
	stdout: string,
): ServerCapacityReport => {
	let hostname = "";
	const filesystems: ServerFilesystemCapacity[] = [];

	for (const line of stdout.split(/\r?\n/)) {
		if (!line.startsWith(`${OUTPUT_PREFIX}\t`)) continue;
		const fields = line.split(/\s+/);
		if (fields[1] === "hostname") {
			hostname = fields.slice(2).join(" ");
			continue;
		}
		if (
			fields.length !== 10 ||
			(fields[1] !== "root" && fields[1] !== "docker")
		) {
			throw new Error("Malformed server capacity evidence");
		}
		const [
			,
			scope,
			totalBlocks,
			usedBlocks,
			availableBlocks,
			diskUsedPercent,
			totalInodes,
			usedInodes,
			availableInodes,
			inodeUsedPercent,
		] = fields as [
			string,
			"root" | "docker",
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		filesystems.push({
			scope,
			totalBytes: parseNumber(totalBlocks, "total blocks") * 1024,
			usedBytes: parseNumber(usedBlocks, "used blocks") * 1024,
			availableBytes: parseNumber(availableBlocks, "available blocks") * 1024,
			usedPercent: parseNumber(diskUsedPercent, "disk used percent"),
			totalInodes: parseNumber(totalInodes, "total inodes"),
			usedInodes: parseNumber(usedInodes, "used inodes"),
			availableInodes: parseNumber(availableInodes, "available inodes"),
			inodeUsedPercent: parseNumber(inodeUsedPercent, "inode used percent"),
		});
	}

	if (!hostname || filesystems.length !== 2) {
		throw new Error("Server capacity evidence is incomplete");
	}
	return { serverId, hostname, filesystems };
};

export const getServerCapacity = async (
	serverId: string,
): Promise<ServerCapacityReport> => {
	const server = await findServerById(serverId);
	if (!server.sshKeyId) {
		throw new Error("No SSH key available for server capacity check");
	}
	const { stdout } = await execAsyncRemote(
		serverId,
		buildServerCapacityCommand(),
	);
	return parseServerCapacityOutput(serverId, stdout);
};
