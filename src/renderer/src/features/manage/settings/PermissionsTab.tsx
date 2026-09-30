import type { ApprovalPolicy, ApprovalState } from "@shared/contracts/config";
import { CursorClick, FilePlus, FileText, Globe, type Icon, ImageIcon, MagnifyingGlass, PencilSimpleLine, Plus, Robot, Terminal, TerminalWindow, Wrench } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Segmented } from "@/ui";
import { listRowMotion } from "../listMotion";
import type { Resource } from "../shared";
import { SourceChip } from "./parts";
import type { OmpSettings } from "./useOmpSettings";

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
	{ tool: "task", icon: Robot },
	{ tool: "generate_image", icon: ImageIcon },
];

type PolicyChoice = ApprovalPolicy | "default";
const CHOICES: readonly PolicyChoice[] = ["default", "prompt", "allow", "deny"];

export function PermissionsTab({ omp, approval }: { omp: OmpSettings; approval: Resource<ApprovalState> }) {
	const { t } = useTranslation("manage");
	const [added, setAdded] = useState<string[]>([]);
	const [newTool, setNewTool] = useState("");
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

	const addTool = (event: FormEvent) => {
		event.preventDefault();
		const tool = newTool.trim();
		if (!tool) return;
		setAdded(list => (list.includes(tool) ? list : [...list, tool]));
		setNewTool("");
	};

	return (
		<div>
			<p className="text-md text-fg-muted">
				{t("permissions.intro", { mode: state ? t(`general.approvalMode.${state.mode}`) : "…" })}
			</p>
			{state && state.unrecognized.length > 0 && (
				<p role="status" className="mt-3 rounded-md border border-border bg-warn-bg px-3 py-2 text-sm text-warn">
					{t("permissions.unrecognized", { tools: state.unrecognized.map(entry => entry.tool).join(", ") })}
				</p>
			)}
			<ul className="relative mt-4 divide-y divide-border rounded-lg border border-border bg-panel" aria-label={t("permissions.listLabel")}>
				<AnimatePresence initial={false} mode="popLayout">
				{rows.map(({ tool, icon: Icon }) => {
					const policy = state?.policies.find(entry => entry.tool === tool);
					const plainName = t(`permissions.tools.${tool}`, { defaultValue: "" });
					return (
						<motion.li key={tool} {...listRowMotion} className="flex items-center gap-3 px-3 py-2">
							<Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate text-md text-fg">{plainName || tool}</span>
									{policy && <SourceChip source={policy.source} />}
								</div>
								{plainName && <span className="font-mono text-xs text-fg-faint">{tool}</span>}
							</div>
							<Segmented
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
					onChange={event => setNewTool(event.currentTarget.value)}
				/>
				<Button type="submit" size="sm" icon={<Plus />} disabled={!newTool.trim()}>
					{t("permissions.add.button")}
				</Button>
			</form>
			<p className="mt-1.5 text-sm text-fg-muted">{t("permissions.add.description")}</p>
		</div>
	);
}
