import { FolderInput, Loader2, PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import type { Services } from "@/pages/dashboard/project/[projectId]/environment/[environmentId]";

interface MoveServiceDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	service: Services | null;
	sourceProjectId: string;
	sourceEnvironmentId: string;
	onMoved?: () => void;
}

export const MoveServiceDialog = ({
	open,
	onOpenChange,
	service,
	sourceProjectId,
	sourceEnvironmentId,
	onMoved,
}: MoveServiceDialogProps) => {
	const utils = api.useUtils();

	const [selectedTargetProject, setSelectedTargetProject] = useState("");
	const [selectedTargetEnvironment, setSelectedTargetEnvironment] =
		useState("");
	const [isCreatingProject, setIsCreatingProject] = useState(false);
	const [isCreatingEnvironment, setIsCreatingEnvironment] = useState(false);
	const [newProjectName, setNewProjectName] = useState("");
	const [newEnvironmentName, setNewEnvironmentName] = useState("");

	const { data: allProjects } = api.project.all.useQuery(undefined, {
		enabled: open,
	});
	const { data: selectedProjectEnvironments } =
		api.environment.byProjectId.useQuery(
			{ projectId: selectedTargetProject },
			{ enabled: !!selectedTargetProject },
		);

	const createProject = api.project.create.useMutation();
	const createEnvironment = api.environment.create.useMutation();

	// Move mutations for each service type
	const moveApplication = api.application.move.useMutation();
	const moveCompose = api.compose.move.useMutation();
	const movePostgres = api.postgres.move.useMutation();
	const moveMysql = api.mysql.move.useMutation();
	const moveMariadb = api.mariadb.move.useMutation();
	const moveRedis = api.redis.move.useMutation();
	const moveMongo = api.mongo.move.useMutation();

	const isMoving =
		moveApplication.isLoading ||
		moveCompose.isLoading ||
		movePostgres.isLoading ||
		moveMysql.isLoading ||
		moveMariadb.isLoading ||
		moveRedis.isLoading ||
		moveMongo.isLoading;

	const resetState = () => {
		setSelectedTargetProject("");
		setSelectedTargetEnvironment("");
		setIsCreatingProject(false);
		setIsCreatingEnvironment(false);
		setNewProjectName("");
		setNewEnvironmentName("");
	};

	const handleCreateProject = async () => {
		if (!newProjectName.trim()) {
			toast.error("Project name is required");
			return;
		}

		try {
			const result = await createProject.mutateAsync({
				name: newProjectName.trim(),
				description: "",
				projectId: "",
			});
			await utils.project.all.invalidate();

			const newProjectId =
				result && "project" in result ? result.project.projectId : undefined;
			const newEnvId =
				result && "environment" in result
					? result.environment.environmentId
					: undefined;

			if (newProjectId) {
				setSelectedTargetProject(newProjectId);
				if (newEnvId) {
					setSelectedTargetEnvironment(newEnvId);
				}
			}
			setIsCreatingProject(false);
			setNewProjectName("");
			toast.success("Project created");
		} catch (error) {
			toast.error(
				`Failed to create project: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	};

	const handleCreateEnvironment = async () => {
		if (!newEnvironmentName.trim()) {
			toast.error("Environment name is required");
			return;
		}
		if (!selectedTargetProject) {
			toast.error("Please select a project first");
			return;
		}

		try {
			const result = await createEnvironment.mutateAsync({
				projectId: selectedTargetProject,
				name: newEnvironmentName.trim(),
				description: null,
			});
			await utils.environment.byProjectId.invalidate({
				projectId: selectedTargetProject,
			});

			if (result?.environmentId) {
				setSelectedTargetEnvironment(result.environmentId);
			}
			setIsCreatingEnvironment(false);
			setNewEnvironmentName("");
			toast.success("Environment created");
		} catch (error) {
			toast.error(
				`Failed to create environment: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	};

	const handleMove = async () => {
		if (!service || !selectedTargetEnvironment) return;

		if (selectedTargetEnvironment === sourceEnvironmentId) {
			toast.error("Service is already in this environment");
			return;
		}

		try {
			switch (service.type) {
				case "application":
					await moveApplication.mutateAsync({
						applicationId: service.id,
						targetEnvironmentId: selectedTargetEnvironment,
					});
					break;
				case "compose":
					await moveCompose.mutateAsync({
						composeId: service.id,
						targetEnvironmentId: selectedTargetEnvironment,
					});
					break;
				case "postgres":
					await movePostgres.mutateAsync({
						postgresId: service.id,
						targetEnvironmentId: selectedTargetEnvironment,
					});
					break;
				case "mysql":
					await moveMysql.mutateAsync({
						mysqlId: service.id,
						targetEnvironmentId: selectedTargetEnvironment,
					});
					break;
				case "mariadb":
					await moveMariadb.mutateAsync({
						mariadbId: service.id,
						targetEnvironmentId: selectedTargetEnvironment,
					});
					break;
				case "redis":
					await moveRedis.mutateAsync({
						redisId: service.id,
						targetEnvironmentId: selectedTargetEnvironment,
					});
					break;
				case "mongo":
					await moveMongo.mutateAsync({
						mongoId: service.id,
						targetEnvironmentId: selectedTargetEnvironment,
					});
					break;
			}

			// Invalidate caches so the UI refreshes
			await Promise.all([
				utils.environment.one.invalidate({
					environmentId: sourceEnvironmentId,
				}),
				utils.environment.one.invalidate({
					environmentId: selectedTargetEnvironment,
				}),
				utils.project.one.invalidate({ projectId: sourceProjectId }),
				utils.project.all.invalidate(),
				utils.environment.byProjectId.invalidate({
					projectId: sourceProjectId,
				}),
				selectedTargetProject !== sourceProjectId
					? utils.environment.byProjectId.invalidate({
							projectId: selectedTargetProject,
						})
					: Promise.resolve(),
				selectedTargetProject !== sourceProjectId
					? utils.project.one.invalidate({
							projectId: selectedTargetProject,
						})
					: Promise.resolve(),
			]);

			toast.success(`Service "${service.name}" moved successfully`);
			onOpenChange(false);
			resetState();
			onMoved?.();
		} catch (error) {
			toast.error(
				`Failed to move service: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	};

	// Find target project and environment names for confirmation display
	const targetProjectName = allProjects?.find(
		(p) => p.projectId === selectedTargetProject,
	)?.name;
	const targetEnvironmentName = selectedProjectEnvironments?.find(
		(e) => e.environmentId === selectedTargetEnvironment,
	)?.name;

	return (
		<Dialog
			open={open}
			onOpenChange={(isOpen) => {
				onOpenChange(isOpen);
				if (!isOpen) {
					resetState();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Move Service</DialogTitle>
					<DialogDescription>
						Move "{service?.name}" to a different project and environment.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					{/* Step 1: Select or Create Project */}
					<div className="flex flex-col gap-2">
						<Label>Target Project</Label>
						{isCreatingProject ? (
							<div className="flex items-center gap-2">
								<Input
									placeholder="New project name"
									value={newProjectName}
									onChange={(e) => setNewProjectName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleCreateProject();
										}
									}}
									autoFocus
								/>
								<Button
									size="sm"
									onClick={handleCreateProject}
									disabled={
										!newProjectName.trim() || createProject.isLoading
									}
								>
									{createProject.isLoading ? (
										<Loader2 className="h-4 w-4 animate-spin" />
									) : (
										"Create"
									)}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => {
										setIsCreatingProject(false);
										setNewProjectName("");
									}}
								>
									Cancel
								</Button>
							</div>
						) : (
							<div className="flex items-center gap-2">
								<Select
									value={selectedTargetProject}
									onValueChange={(value) => {
										setSelectedTargetProject(value);
										setSelectedTargetEnvironment("");
									}}
								>
									<SelectTrigger className="flex-1">
										<SelectValue placeholder="Select target project" />
									</SelectTrigger>
									<SelectContent>
										{allProjects?.map((project) => (
											<SelectItem
												key={project.projectId}
												value={project.projectId}
											>
												{project.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									size="icon"
									variant="outline"
									onClick={() => setIsCreatingProject(true)}
									title="Create new project"
								>
									<PlusIcon className="h-4 w-4" />
								</Button>
							</div>
						)}
					</div>

					{/* Step 2: Select or Create Environment */}
					{selectedTargetProject && (
						<div className="flex flex-col gap-2">
							<Label>Target Environment</Label>
							{isCreatingEnvironment ? (
								<div className="flex items-center gap-2">
									<Input
										placeholder="New environment name"
										value={newEnvironmentName}
										onChange={(e) =>
											setNewEnvironmentName(e.target.value)
										}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												handleCreateEnvironment();
											}
										}}
										autoFocus
									/>
									<Button
										size="sm"
										onClick={handleCreateEnvironment}
										disabled={
											!newEnvironmentName.trim() ||
											createEnvironment.isLoading
										}
									>
										{createEnvironment.isLoading ? (
											<Loader2 className="h-4 w-4 animate-spin" />
										) : (
											"Create"
										)}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setIsCreatingEnvironment(false);
											setNewEnvironmentName("");
										}}
									>
										Cancel
									</Button>
								</div>
							) : (
								<div className="flex items-center gap-2">
									<Select
										value={selectedTargetEnvironment}
										onValueChange={setSelectedTargetEnvironment}
									>
										<SelectTrigger className="flex-1">
											<SelectValue placeholder="Select target environment" />
										</SelectTrigger>
										<SelectContent>
											{selectedProjectEnvironments?.map((env) => (
												<SelectItem
													key={env.environmentId}
													value={env.environmentId}
												>
													{env.name}
													{env.environmentId === sourceEnvironmentId
														? " (current)"
														: ""}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										size="icon"
										variant="outline"
										onClick={() => setIsCreatingEnvironment(true)}
										title="Create new environment"
									>
										<PlusIcon className="h-4 w-4" />
									</Button>
								</div>
							)}
						</div>
					)}

					{/* Confirmation summary */}
					{selectedTargetEnvironment &&
						selectedTargetEnvironment !== sourceEnvironmentId && (
							<div className="rounded-md border p-3 bg-muted/50">
								<p className="text-sm">
									<span className="font-medium">{service?.name}</span>
									<span className="text-muted-foreground">
										{" "}
										({service?.type}) will be moved to{" "}
									</span>
									<span className="font-medium">{targetProjectName}</span>
									<span className="text-muted-foreground"> / </span>
									<span className="font-medium">
										{targetEnvironmentName}
									</span>
								</p>
							</div>
						)}
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => {
							onOpenChange(false);
							resetState();
						}}
						disabled={isMoving}
					>
						Cancel
					</Button>
					<Button
						onClick={handleMove}
						disabled={
							!selectedTargetProject ||
							!selectedTargetEnvironment ||
							selectedTargetEnvironment === sourceEnvironmentId ||
							isMoving
						}
					>
						{isMoving ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								Moving...
							</>
						) : (
							<>
								<FolderInput className="mr-2 h-4 w-4" />
								Move Service
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
