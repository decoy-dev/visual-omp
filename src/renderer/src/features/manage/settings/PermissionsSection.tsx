import type { ApprovalPolicy } from "@shared/contracts/config";
import { CursorClick, Desktop, FilePlus, FileText, Folder, Globe, type Icon, ImageIcon, MagnifyingGlass, PencilSimpleLine, Plus, Robot, Terminal, TerminalWindow, Trash, Wrench } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsSectionProps } from "@/registry/slots";
import { Button, Dialog, DialogContent, IconButton, Input, Notice, PageHeader, SectionHeader, Segmented } from "@/ui";
import { listRowMotion } from "../listMotion";
import { useResource } from "../shared";
import { ConfigNotices, SectionScope, SourceChip } from "./parts";
import { useOmpSettings } from "./useOmpSettings";
import type { OmpSettings } from "./useOmpSettings";
import { restrictedFoldersForEdit } from "./permissionsModel";

/** Tools people most often want to gate, in the order a newcomer thinks about them. */
const COMMON_TOOLS: readonly { tool: string; icon: Icon }[] = [
	{ tool: "read", icon: FileText },
	{ tool: "edit", icon: PencilSimpleLine },
	{ tool: "write", icon: FilePlus },
	{ tool: "bash", icon: Terminal },
	{ tool: "eval", icon: TerminalWindow },
	{ tool: "fetch", icon: Globe },
	{ tool: "web_search", icon: MagnifyingGlass },
	{ tool: "browser", icon: CursorClick },
	{ tool: "computer.control", icon: Desktop },
	{ tool: "task", icon: Robot },
	{ tool: "generate_image", icon: ImageIcon },
];

type PolicyChoice = ApprovalPolicy | "default";
const CHOICES: readonly PolicyChoice[] = ["default", "prompt", "allow", "deny"];

export function PermissionsSection({ projectPath, scope, setScope }: SettingsSectionProps) {
	const { t } = useTranslation("manage");
	const omp = useOmpSettings(projectPath, scope);
	const approval = useResource(() => window.vomp.invoke("config:approval", projectPath ?? undefined), [projectPath]);
	const [added, setAdded] = useState<string[]>([]);
	const [newTool, setNewTool] = useState("");
	const [confirmForget, setConfirmForget] = useState(false);
	const [forgetting, setForgetting] = useState(false);
	const [forgotten, setForgotten] = useState<string | null>(null);
	const state = approval.data;

	const rows = useMemo(() => {
		const known = new Set(COMMON_TOOLS.map(entry => entry.tool));
		const extra = [...(state?.policies.map(policy => policy.tool) ?? []), ...added].filter(tool => !known.has(tool));
		return [...COMMON_TOOLS, ...[...new Set(extra)].sort().map(tool => ({ tool, icon: Wrench }))];
	}, [state, added]);

	const setPolicy = async (tool: string, choice: PolicyChoice) => {
		try {
			const next = await window.vomp.invoke(
				"config:approval:setPolicy",
				tool,
				choice === "default" ? null : choice,
				omp.scope,
				omp.cwd ?? undefined,
			);
			approval.setData(next);
			const effective = next.policies.find(policy => policy.tool === tool);
			// Clearing one layer leaves the other layer's entry in charge.
			if ((effective?.policy ?? "default") !== choice && effective) omp.reportShadow(effective.source);
		} catch (error) {
			omp.reportError(error);
		}
	};

	const forget = async () => {
		setConfirmForget(false);
		setForgetting(true);
		setForgotten(null);
		try {
			setForgotten(await window.vomp.invoke("config:approval:forget"));
		} catch (error) {
			omp.reportError(error);
		} finally {
			setForgetting(false);
		}
	};

	const addTool = (event: FormEvent) => {
		event.preventDefault();
		const tool = newTool.trim();
		if (!tool) return;
		setAdded(list => (list.includes(tool) ? list : [...list, tool]));
		setNewTool("");
	};

	return (
		<div>
			<PageHeader
				title={t("settings.sections.permissions")}
				description={t("permissions.description")}
				meta={<SectionScope projectPath={projectPath} scope={scope} setScope={setScope} />}
			/>
			<ConfigNotices
				cwd={projectPath}
				error={approval.error ?? omp.snapshot.error}
				onReload={() => {
					void omp.snapshot.reload();
					void approval.reload();
				}}
			/>
			<p className="text-md text-fg-muted">
				{t("permissions.intro", { mode: state ? t(`general.approvalMode.${state.mode ?? "unknown"}`) : "…" })}
			</p>
			{state && state.unrecognized.length > 0 && (
				<Notice tone="warn" className="mt-3">
					{t("permissions.unrecognized", { tools: state.unrecognized.map(entry => entry.tool).join(", ") })}
				</Notice>
			)}
			{state && (
				<div className="mt-4 flex flex-wrap items-center gap-3">
					<p className="min-w-0 flex-1 text-sm text-fg-muted">{t("permissions.forget.help")}</p>
					<Button size="sm" variant="secondary" disabled={forgetting} onClick={() => setConfirmForget(true)}>
						{t(forgetting ? "permissions.forget.busy" : "permissions.forget.action")}
					</Button>
				</div>
			)}
			{forgotten && <Notice tone="info" className="mt-3">{forgotten}</Notice>}
			<Dialog open={confirmForget} onOpenChange={setConfirmForget}>
				<DialogContent
					size="sm"
					title={t("permissions.forget.title")}
					description={t("permissions.forget.confirmHelp")}
					footer={
						<>
							<Button variant="ghost" onClick={() => setConfirmForget(false)}>{t("common.cancel")}</Button>
							<Button variant="primary" onClick={() => void forget()}>{t("permissions.forget.action")}</Button>
						</>
					}
				/>
			</Dialog>
			<p className="mt-4 text-sm text-fg-muted">{t("permissions.computerHelp")}</p>
			<ul className="relative mt-4 divide-y divide-border rounded-lg border border-border bg-panel" aria-label={t("permissions.listLabel")}>
				<AnimatePresence initial={false} mode="popLayout">
				{rows.map(({ tool, icon: Icon }) => {
					const policy = state?.policies.find(entry => entry.tool === tool);
					const plainName = tool === "computer.control" ? t("permissions.computerControl") : t(`permissions.tools.${tool}`, { defaultValue: "" });
					return (
						<motion.li key={tool} {...listRowMotion} className="flex flex-wrap items-center gap-3 px-3 py-2">
							<Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
							<div className="min-w-40 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate text-md text-fg">{plainName || tool}</span>
									{policy && <SourceChip source={policy.source} />}
								</div>
								{plainName && <span className="block truncate font-mono text-xs text-fg-faint">{tool}</span>}
							</div>
							<Segmented
								className="ml-auto"
								size="sm"
								aria-label={t("permissions.rowLabel", { tool: plainName || tool })}
								value={policy?.policy ?? "default"}
								disabled={!state}
								onValueChange={choice => void setPolicy(tool, choice)}
								options={CHOICES.map(value => ({ value, label: t(`permissions.choice.${value}`) }))}
							/>
						</motion.li>
					);
				})}
				</AnimatePresence>
			</ul>
			<p className="mt-3 text-sm text-fg-muted">{t("permissions.defaultHelp")}</p>
			<form onSubmit={addTool} className="mt-5 flex items-end gap-2">
				<Input
					className="flex-1"
					size="sm"
					label={t("permissions.add.label")}
					placeholder={t("permissions.add.placeholder")}
					value={newTool}
					spellCheck={false}
					onChange={event => setNewTool(event.currentTarget.value)}
				/>
				<Button type="submit" size="sm" icon={<Plus />} disabled={!newTool.trim()}>
					{t("permissions.add.button")}
				</Button>
			</form>
			<p className="mt-2 text-sm text-fg-muted">{t("permissions.add.description")}</p>
			<RestrictedFolders omp={omp} />
		</div>
	);
}

function RestrictedFolders({ omp }: { omp: OmpSettings }) {
	const { t } = useTranslation("manage");
	const [busy, setBusy] = useState(false);
	const setting = omp.byKey.get("tools.restrictedFolders");
	const raw = omp.scope === "global" ? setting?.globalValue : setting?.projectValue;
	const folders = restrictedFoldersForEdit(setting, omp.scope);
	const save = async (next: string[]) => {
		setBusy(true);
		try { await omp.write("tools.restrictedFolders", next); }
		finally { setBusy(false); }
	};
	const add = async () => {
		setBusy(true);
		try {
			const folder = await window.vomp.invoke("app:pickFolder", t("permissions.restricted.pick"));
			if (folder && !folders.includes(folder)) await omp.write("tools.restrictedFolders", [...folders, folder]);
		} catch (error) { omp.reportError(error); }
		finally { setBusy(false); }
	};
	return (
		<section className="mt-8" aria-labelledby="restricted-folders-title">
			<SectionHeader id="restricted-folders-title" title={t("permissions.restricted.title")} description={t("permissions.restricted.help")}
				actions={<Button size="sm" icon={<Plus />} disabled={!setting || busy} onClick={() => void add()}>{t("permissions.restricted.add")}</Button>} />
			{folders.length > 0 ? (
				<ul className="divide-y divide-border border-y border-border" aria-label={t("permissions.restricted.title")}>
					{folders.map(folder => <li key={folder} className="flex items-center gap-3 py-2">
						<Folder aria-hidden className="size-4 shrink-0 text-fg-muted" />
						<span className="min-w-0 flex-1 break-all font-mono text-sm">{folder}</span>
						<IconButton size="sm" icon={<Trash />} label={t("permissions.restricted.remove", { folder })} disabled={busy} onClick={() => void save(folders.filter(value => value !== folder))} />
					</li>)}
				</ul>
			) : <p className="text-sm text-fg-muted">{t("permissions.restricted.empty")}</p>}
			{omp.scope === "project" && raw == null && folders.length > 0 && <Notice tone="info" className="mt-3">{t("permissions.restricted.inherited")}</Notice>}
			{omp.scope === "global" && setting?.source === "project" && <Notice tone="info" className="mt-3">{t("permissions.restricted.overridden")}</Notice>}
			{raw != null && <Button className="mt-3" size="sm" variant="ghost" disabled={busy} onClick={() => void omp.reset("tools.restrictedFolders")}>{t("permissions.restricted.reset")}</Button>}
		</section>
	);
}
