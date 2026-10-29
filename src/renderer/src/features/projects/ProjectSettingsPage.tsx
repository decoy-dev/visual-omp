/**
 * Project settings page: this project's default model and permission mode (written to
 * `<project>/.omp/config.yml`), links to its connected tools, helpers and instructions, and removing
 * it from the list.
 */
import type { ApprovalMode, ApprovalState, ModelInfo, ModelRolesState } from "@shared/contracts/config";
import { FileText, Plug, Robot, X } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PageProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { openProjectInstructions, openSettings, type ProjectPageProps, usePageBack } from "@/state/navigation";
import { Button, Dialog, DialogContent, Divider, PageFrame, PageHeader, PresenceSwap, SectionHeader, Segmented, Skeleton, toast } from "@/ui";
import type { HelpersSectionProps } from "../manage/agents/HelpersSection";
import { ModelSelect } from "../manage/roles/ModelSelect";
import { errorText } from "./actions";
import { approvalModes } from "../session-tools/approval";
import { folderName } from "./format";

const STRICTNESS: Record<ApprovalMode, number> = { "always-ask": 2, "always-ask-cached": 3, write: 1, yolo: 0 };
/** DESIGN §8.4: the Auto warning shows once. */
const AUTO_WARNED_KEY = "visual-omp:projects:autoWarned";

interface Loaded {
	roles: ModelRolesState;
	approval: ApprovalState;
	models: ModelInfo[];
}

export function ProjectSettingsPage({ props, seq, close }: PageProps<ProjectPageProps>): ReactNode {
	const { t } = useTranslation("projects");
	const { projectPath } = props;
	const name = useApp(state => state.projects.find(entry => entry.path === projectPath)?.name ?? folderName(projectPath));
	return (
		<PageFrame back={usePageBack(close)} width="form" label={t("settings.title")} focusKey={seq}>
			<PageHeader
				title={t("settings.title")}
				description={t("settings.description", { name })}
				meta={<span className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{projectPath}</span>}
			/>
			<SettingsBody key={projectPath} projectPath={projectPath} close={close} />
		</PageFrame>
	);
}

function SettingsBody({ projectPath, close }: { projectPath: string; close(): void }): ReactNode {
	const { t } = useTranslation("projects");
	const [data, setData] = useState<Loaded | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmAuto, setConfirmAuto] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState(false);

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

	const mode = data?.approval.mode ?? null;
	const setMode = (next: ApprovalMode, confirmed = false) => {
		if (next === "yolo" && (mode === null || STRICTNESS[mode] > 0) && !confirmed && localStorage.getItem(AUTO_WARNED_KEY) === null) {
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
		<div className="flex flex-col gap-10">
			<section aria-labelledby="ps-model">
				<SectionHeader id="ps-model" title={t("settings.model.title")} description={t("settings.model.body")} />
				{data && role ? (
					<div className="flex flex-col gap-2">
						<ModelSelect
							aria-label={t("settings.model.title")}
							models={data.models}
							accepts={role.acceptsKinds}
							value={role.projectValue ? role.projectValue.replace(/:[a-z]+$/, "") : null}
							onChange={setModel}
							autoLabel={role.globalValue ? t("settings.model.inherit", { model: role.globalValue }) : t("settings.model.auto")}
						/>
						<p className="text-sm text-fg-muted">{role.projectValue ? t("settings.model.projectOnly") : t("settings.model.usingGlobal")}</p>
					</div>
				) : (
					<Skeleton height={32} />
				)}
			</section>

			<section aria-labelledby="ps-mode">
				<SectionHeader id="ps-mode" title={t("settings.mode.title")} description={t("settings.mode.body")} />
				{data ? (
					<div className="flex flex-col gap-3">
						<Segmented<ApprovalMode | "">
							aria-label={t("settings.mode.title")}
							value={mode ?? ""}
							onValueChange={next => { if (next) setMode(next); }}
							options={approvalModes(data.approval).map(value => ({ value, label: t(`settings.mode.${value}.label`) }))}
						/>
						<PresenceSwap swapKey={mode ?? "unknown"} className="text-md text-fg-muted">
							<p>{t(`settings.mode.${mode ?? "unknown"}.body`, { value: JSON.stringify(data.approval.rawMode) })}</p>
						</PresenceSwap>
						<div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
							<span className="flex-1">{data.approval.modeSource === "project" ? t("settings.mode.projectOnly") : t("settings.mode.usingGlobal")}</span>
							{data.approval.modeSource === "project" && (
								<Button size="sm" variant="ghost" onClick={() => void run(() => window.vomp.invoke("config:reset", "tools.approvalMode", "project", projectPath))}>
									{t("settings.mode.reset")}
								</Button>
							)}
						</div>
					</div>
				) : (
					<Skeleton height={32} />
				)}
			</section>

			<section aria-labelledby="ps-more">
				<SectionHeader id="ps-more" title={t("settings.more.title")} description={t("settings.more.body")} />
				<ul className="flex flex-col divide-y divide-border">
					<LinkRow
						icon={<Plug />}
						title={t("settings.more.mcp")}
						body={t("settings.more.mcpBody")}
						action={t("settings.more.mcpAction")}
						onOpen={() => openSettings("mcp", { projectPath, scope: "project" })}
					/>
					<LinkRow
						icon={<Robot />}
						title={t("settings.more.agents")}
						body={t("settings.more.agentsBody")}
						action={t("settings.more.agentsAction")}
						onOpen={() => openSettings("helpers", { projectPath, sectionProps: { filter: "project" } satisfies HelpersSectionProps })}
					/>
					<LinkRow
						icon={<FileText />}
						title={t("settings.more.instructions")}
						body={t("settings.more.instructionsBody")}
						action={t("settings.more.instructionsAction")}
						onOpen={() => openProjectInstructions(projectPath)}
					/>
				</ul>
			</section>

			<Divider />
			<section className="flex flex-wrap items-start gap-3">
				<div className="min-w-[min(100%,16rem)] flex-1">
					<h2 className="text-md font-medium text-fg">{t("settings.remove.title")}</h2>
					<p className="mt-1 text-sm text-fg-muted">{t("settings.remove.body")}</p>
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
		</div>
	);
}

function LinkRow({ icon, title, body, action, onOpen }: { icon: ReactNode; title: string; body: string; action: string; onOpen(): void }): ReactNode {
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
			<span className="shrink-0 self-start pt-1 text-fg-muted [&>svg]:size-4" aria-hidden>
				{icon}
			</span>
			<div className="min-w-[min(100%,14rem)] flex-1">
				<p className="text-md font-medium text-fg">{title}</p>
				<p className="text-sm text-fg-muted">{body}</p>
			</div>
			<Button size="sm" onClick={onOpen}>
				{action}
			</Button>
		</li>
	);
}
