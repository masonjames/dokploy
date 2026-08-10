import { quote } from "shell-quote";

const OUTPUT_PREFIX = "DOKPLOY_STACK_CLEANUP_";

export interface StackCleanupReport {
	kind: "stack";
	stackName: string;
	deleteVolumes: boolean;
	discoveredVolumes: string[];
	removedVolumes: string[];
	retainedVolumes: string[];
	residualServices: string[];
	residualContainers: string[];
	residualNetworks: string[];
	residualVolumes: string[];
	verified: boolean;
}

export class StackCleanupError extends Error {
	public readonly report: StackCleanupReport;

	constructor(
		message: string,
		report: StackCleanupReport,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "StackCleanupError";
		this.report = report;
	}
}

const shellQuote = (value: string) => quote([value]);

export const buildStackCleanupCommand = ({
	stackName,
	deleteVolumes,
	isolatedDeployment = false,
	waitSeconds = 60,
}: {
	stackName: string;
	deleteVolumes: boolean;
	isolatedDeployment?: boolean;
	waitSeconds?: number;
}) => {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(stackName)) {
		throw new Error("Stack name is not safe for Docker cleanup");
	}
	if (
		!Number.isSafeInteger(waitSeconds) ||
		waitSeconds < 1 ||
		waitSeconds > 600
	) {
		throw new Error("Stack cleanup wait must be between 1 and 600 seconds");
	}

	return `
set -eu
_dokploy_stack=${shellQuote(stackName)}
_dokploy_delete_volumes=${deleteVolumes ? "1" : "0"}
_dokploy_isolated=${isolatedDeployment ? "1" : "0"}
_dokploy_wait_seconds=${waitSeconds}
_dokploy_label="com.docker.stack.namespace=$_dokploy_stack"
_dokploy_volumes_file=$(mktemp)
_dokploy_cleanup_temp() {
	rm -f -- "$_dokploy_volumes_file"
}
trap '_dokploy_cleanup_temp' EXIT HUP INT TERM

docker volume ls --filter "label=$_dokploy_label" --format '{{.Name}}' | sort -u > "$_dokploy_volumes_file"
while IFS= read -r _dokploy_volume; do
	[ -n "$_dokploy_volume" ] || continue
	printf '${OUTPUT_PREFIX}DISCOVERED_VOLUME=%s\n' "$_dokploy_volume"
done < "$_dokploy_volumes_file"

if docker stack services "$_dokploy_stack" >/dev/null 2>&1; then
	docker stack rm "$_dokploy_stack"
fi

_dokploy_attempt=0
while :; do
	_dokploy_services=$(docker service ls -q --filter "label=$_dokploy_label")
	_dokploy_containers=$(docker ps -aq --filter "label=$_dokploy_label")
	if [ -z "$_dokploy_services" ] && [ -z "$_dokploy_containers" ]; then
		break
	fi
	_dokploy_attempt=$((_dokploy_attempt + 1))
	if [ "$_dokploy_attempt" -ge "$_dokploy_wait_seconds" ]; then
		echo "Stack cleanup timed out waiting for service and container detach" >&2
		exit 70
	fi
	sleep 1
done

if [ "$_dokploy_isolated" = "1" ] && docker network inspect "$_dokploy_stack" >/dev/null 2>&1; then
	_dokploy_attached_containers=$(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$_dokploy_stack")
	for _dokploy_container in $_dokploy_attached_containers; do
		docker network disconnect -f "$_dokploy_stack" "$_dokploy_container" >/dev/null 2>&1 || true
	done
	docker network rm "$_dokploy_stack" >/dev/null 2>&1 || true
fi

while IFS= read -r _dokploy_volume; do
	[ -n "$_dokploy_volume" ] || continue
	if [ "$_dokploy_delete_volumes" = "1" ]; then
		if docker ps -aq --filter "volume=$_dokploy_volume" | grep -q .; then
			echo "Stack volume is still attached: $_dokploy_volume" >&2
			exit 71
		fi
		if ! docker volume rm -- "$_dokploy_volume" >/dev/null; then
			echo "Stack volume removal failed: $_dokploy_volume" >&2
			exit 72
		fi
		printf '${OUTPUT_PREFIX}REMOVED_VOLUME=%s\n' "$_dokploy_volume"
	else
		printf '${OUTPUT_PREFIX}RETAINED_VOLUME=%s\n' "$_dokploy_volume"
	fi
done < "$_dokploy_volumes_file"

_dokploy_residual_services=$(docker service ls -q --filter "label=$_dokploy_label")
_dokploy_residual_containers=$(docker ps -aq --filter "label=$_dokploy_label")
_dokploy_residual_networks=$(
	docker network ls -q --filter "label=$_dokploy_label"
	if [ "$_dokploy_isolated" = "1" ] && docker network inspect "$_dokploy_stack" >/dev/null 2>&1; then
		docker network inspect --format '{{.ID}}' "$_dokploy_stack"
	fi
)
_dokploy_residual_volumes=""
if [ "$_dokploy_delete_volumes" = "1" ]; then
	_dokploy_residual_volumes=$(docker volume ls -q --filter "label=$_dokploy_label")
fi

for _dokploy_id in $_dokploy_residual_services; do
	printf '${OUTPUT_PREFIX}RESIDUAL_SERVICE=%s\n' "$_dokploy_id"
done
for _dokploy_id in $_dokploy_residual_containers; do
	printf '${OUTPUT_PREFIX}RESIDUAL_CONTAINER=%s\n' "$_dokploy_id"
done
for _dokploy_id in $_dokploy_residual_networks; do
	printf '${OUTPUT_PREFIX}RESIDUAL_NETWORK=%s\n' "$_dokploy_id"
done
for _dokploy_id in $_dokploy_residual_volumes; do
	printf '${OUTPUT_PREFIX}RESIDUAL_VOLUME=%s\n' "$_dokploy_id"
done

if [ -n "$_dokploy_residual_services$_dokploy_residual_containers$_dokploy_residual_networks$_dokploy_residual_volumes" ]; then
	echo "Stack cleanup verification found residual Docker resources" >&2
	exit 73
fi

printf '${OUTPUT_PREFIX}VERIFIED=1\n'
`;
};

const valuesFor = (stdout: string, key: string) =>
	stdout
		.split(/\r?\n/)
		.filter((line) => line.startsWith(`${OUTPUT_PREFIX}${key}=`))
		.map((line) => line.slice(`${OUTPUT_PREFIX}${key}=`.length))
		.filter(Boolean);

export const parseStackCleanupOutput = ({
	stackName,
	deleteVolumes,
	stdout,
}: {
	stackName: string;
	deleteVolumes: boolean;
	stdout: string;
}): StackCleanupReport => ({
	kind: "stack",
	stackName,
	deleteVolumes,
	discoveredVolumes: valuesFor(stdout, "DISCOVERED_VOLUME"),
	removedVolumes: valuesFor(stdout, "REMOVED_VOLUME"),
	retainedVolumes: valuesFor(stdout, "RETAINED_VOLUME"),
	residualServices: valuesFor(stdout, "RESIDUAL_SERVICE"),
	residualContainers: valuesFor(stdout, "RESIDUAL_CONTAINER"),
	residualNetworks: valuesFor(stdout, "RESIDUAL_NETWORK"),
	residualVolumes: valuesFor(stdout, "RESIDUAL_VOLUME"),
	verified: valuesFor(stdout, "VERIFIED").includes("1"),
});
