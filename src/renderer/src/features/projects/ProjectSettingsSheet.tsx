/**
 * Per-project settings: this project's default model and permission mode (written to
 * `<project>/.omp/config.yml`), shortcuts to its connected tools, helpers and instructions, and
 * removing it from the list.
 */
import type { ApprovalMode, ApprovalState, ModelInfo, ModelRolesState } from "@shared/contracts/config";
import { FileText, Plug, Robot, X } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { Button, Dialog, DialogContent, Divider, EmptyState, PresenceSwap, Segmented, Sheet, SheetContent, Skeleton, toast } from "@/ui";
import { ModelSelect } from "../manage/roles/ModelSelect";
import { errorText } from "./actions";
import { folderName } from "./format";

export interface ProjectSettingsProps {
	projectPath?: string | null;
}

const MODES: readonly ApprovalMode[] = ["always-ask", "write", "yolo"];
const STRICTNESS: Record<ApprovalMode, number> = { "always-ask": 2, write: 1, yolo: 0 };
/** DESIGN §8.4: the Auto warning shows once. */
const AUTO_WARNED_KEY = "visual-omp:projects:autoWarned";

interface Loaded {
	roles: ModelRolesState;
	approval: ApprovalState;
	models: ModelInfo[];
}

export function ProjectSettingsSheet({ props, close }: SheetProps<ProjectSettingsProps | undefined>): ReactNode {
	const { t } = useTranslation("projects");
	const active = useApp(state => state.activeProject);
	const projectPath = props?.projectPath ?? active;
	return (
		<Sheet open onOpenChange={open => !open && close()}>
			<SheetContent
				width={560}
				title={t("settings.title")}
				description={projectPath ? folderName(projectPath) : undefined}
				bodyClassName="flex flex-col gap-6 p-5"
			>
				{projectPath ? <SettingsBody projectPath={projectPath} close={close} /> : <EmptyState title={t("instructions.noProject")} />}
			</SheetContent>
		</Sheet>
	);
}

function SettingsBody({ projectPath, close }: { projectPath: string; close(): void }): ReactNode {
	const { t } = useTranslation("projects");
	const [data, setData] = useState<Loaded | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmAuto, setConfirmAuto] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const openSheet = useApp(state => state.openSheet);

	const load = useCallback(async () => {
		try {
			const [roles, approval, models] = await Promise.all([
				window.vomp.invoke("config:roles", projectPath),
				window.vomp.invoke("config:approval", projectPath),
				window.vomp.invoke("config:models", projectPath),
			]);
			setData({ roles, approval, models });
			setError(null);
		} catch (failure) {
			setError(errorText(failure));
		}
	}, [projectPath]);

	useEffect(() => {
		void load();
		void window.vomp.invoke("config:watch", projectPath);
		const off = window.vomp.on("config:changed", () => void load());
		return () => {
			off();
			void window.vomp.invoke("config:unwatch", projectPath);
		};
	}, [projectPath, load]);

	const run = async (action: () => Promise<unknown>) => {
		try {
			await action();
			await load();
		} catch (failure) {
			toast({ tone: "err", message: t("settings.saveFailed"), description: errorText(failure) });
		}
	};

	const role = data?.roles.roles.find(entry => entry.id === "default") ?? null;
	const setModel = (model: string | null) =>
		void run(() =>
			window.vomp.invoke("config:roles:set", "default", model ? { model, thinking: role?.thinking ?? null } : null, {
				cwd: projectPath,
				scope: "project",
			}),
		);

	const mode = data?.approval.mode ?? "yolo";
	const setMode = (next: ApprovalMode, confirmed = false) => {
		if (next === "yolo" && STRICTNESS[mode] > 0 && !confirmed && localStorage.getItem(AUTO_WARNED_KEY) === null) {
			setConfirmAuto(true);
			return;
		}
		void run(() => window.vomp.invoke("config:approval:setMode", next, "project", projectPath));
	};

	const remove = async () => {
		setConfirmRemove(false);
		try {
			await window.vomp.invoke("project:remove", projectPath);
			await useApp.getState().refreshProjects();
			if (useApp.getState().activeProject === projectPath) {
				useApp.setState({ activeProject: useApp.getState().projects.find(entry => entry.path !== projectPath)?.path ?? null });
			}
			close();
		} catch (failure) {
			toast({ tone: "err", message: t("settings.removeFailed"), description: errorText(failure) });
		}
	};

	if (error) return <p className="text-sm text-err">{error}</p>;

	return (
		<>
			<section className="flex flex-col gap-3" aria-labelledby="ps-model">
				<h3 id="ps-model" className="text-base font-semibold text-fg">
					{t("settings.model.title")}
				</h3>
				<p className="text-sm text-fg-muted">{t("settings.model.body")}</p>
				{data && role ? (
					<>
						<ModelSelect
							aria-label={t("settings.model.title")}
							models={data.models}
							accepts={role.acceptsKinds}
							value={role.projectValue ? role.projectValue.replace(/:[a-z]+$/, "") : null}
							onChange={setModel}
							autoLabel={
								role.globalValue ? t("settings.model.inherit", { model: role.globalValue }) : t("settings.model.auto")
							}
						/>
						<p className="text-xs text-fg-faint">{role.projectValue ? t("settings.model.projectOnly") : t("settings.model.usingGlobal")}</p>
					</>
				) : (
					<Skeleton height={32} />
				)}
			</section>

			<section className="flex flex-col gap-3" aria-labelledby="ps-mode">
				<h3 id="ps-mode" className="text-base font-semibold text-fg">
					{t("settings.mode.title")}
				</h3>
				{data ? (
					<>
						<Segmented<ApprovalMode>
							aria-label={t("settings.mode.title")}
							value={mode}
							onValueChange={next => setMode(next)}
							options={MODES.map(value => ({ value, label: t(`settings.mode.${value}.label`) }))}
						/>
						<PresenceSwap swapKey={mode} className="text-sm text-fg-muted">
							<p>{t(`settings.mode.${mode}.body`)}</p>
						</PresenceSwap>
						<div className="flex items-center gap-2 text-xs text-fg-faint">
							<span className="flex-1">{data.approval.modeSource === "project" ? t("settings.mode.projectOnly") : t("settings.mode.usingGlobal")}</span>
							{data.approval.modeSource === "project" && (
								<Button size="sm" variant="ghost" onClick={() => void run(() => window.vomp.invoke("config:reset", "tools.approvalMode", "project", projectPath))}>
									{t("settings.mode.reset")}
								</Button>
							)}
						</div>
					</>
				) : (
					<Skeleton height={32} />
				)}
			</section>

			<section className="flex flex-col gap-1" aria-labelledby="ps-more">
				<h3 id="ps-more" className="text-base font-semibold text-fg mb-2">
					{t("settings.more.title")}
				</h3>
				<LinkRow
					icon={<Plug />}
					title={t("settings.more.mcp")}
					body={t("settings.more.mcpBody")}
					action={t("settings.more.mcpAction")}
					onOpen={() => openSheet("mcp", { projectPath, scope: "project" })}
				/>
				<LinkRow
					icon={<Robot />}
					title={t("settings.more.agents")}
					body={t("settings.more.agentsBody")}
					action={t("settings.more.agentsAction")}
					onOpen={() => openSheet("agents", { projectPath, scope: "project" })}
				/>
				<LinkRow
					icon={<FileText />}
					title={t("settings.more.instructions")}
					body={t("settings.more.instructionsBody")}
					action={t("settings.more.instructionsAction")}
					onOpen={() => openSheet("project-instructions", { projectPath })}
				/>
			</section>

			<Divider />
			<section className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<h3 className="text-md font-medium text-fg">{t("settings.remove.title")}</h3>
					<p className="mt-0.5 text-sm text-fg-muted">{t("settings.remove.body")}</p>
				</div>
				<Button variant="danger-ghost" icon={<X />} onClick={() => setConfirmRemove(true)}>
					{t("settings.remove.action")}
				</Button>
			</section>

			<Dialog open={confirmAuto} onOpenChange={setConfirmAuto}>
				<DialogContent
					size="sm"
					title={t("settings.mode.autoTitle")}
					description={t("settings.mode.autoWarning")}
					footer={
						<>
							<Button onClick={() => setConfirmAuto(false)}>{t("settings.cancel")}</Button>
							<Button
								variant="primary"
								onClick={() => {
									localStorage.setItem(AUTO_WARNED_KEY, "1");
									setConfirmAuto(false);
									setMode("yolo", true);
								}}
							>
								{t("settings.mode.understand")}
							</Button>
						</>
					}
				/>
			</Dialog>
			<Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
				<DialogContent
					size="sm"
					destructive
					title={t("settings.remove.confirmTitle", { name: folderName(projectPath) })}
					description={t("settings.remove.confirmBody")}
					footer={
						<>
							<Button onClick={() => setConfirmRemove(false)}>{t("settings.cancel")}</Button>
							<Button variant="danger" onClick={() => void remove()}>
								{t("settings.remove.action")}
							</Button>
						</>
					}
				/>
			</Dialog>
		</>
	);
}

function LinkRow({ icon, title, body, action, onOpen }: { icon: ReactNode; title: string; body: string; action: string; onOpen(): void }): ReactNode {
	return (
		<div className="flex items-center gap-3 py-2">
			<span className="shrink-0 text-fg-muted [&>svg]:size-4" aria-hidden>
				{icon}
			</span>
			<div className="min-w-0 flex-1">
				<p className="text-md font-medium text-fg">{title}</p>
				<p className="text-sm text-fg-muted">{body}</p>
			</div>
			<Button size="sm" onClick={onOpen}>
				{action}
			</Button>
		</div>
	);
}
