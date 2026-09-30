import { FolderOpen, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SkillEntry } from "@shared/contracts/skills";
import { Markdown } from "@/transcript/Markdown";
import { BracketLabel, Button, Chip, Sheet, SheetContent, Skeleton, Switch } from "@/ui";
import { LetterTile, Notice, useLoad } from "../shared";
import { lockedReason, providerLabel } from "./model";

interface SkillDrawerProps {
	skill: SkillEntry | null;
	onClose(): void;
	onToggle(skill: SkillEntry, enabled: boolean): void;
	onRemove(skill: SkillEntry): void;
}

/** Detail drawer over the browser: what the skill does, when omp uses it, where it comes from. */
export function SkillDrawer({ skill, onClose, onToggle, onRemove }: SkillDrawerProps) {
	return (
		<Sheet open={skill !== null} onOpenChange={open => !open && onClose()}>
			{skill && <DrawerBody skill={skill} onToggle={onToggle} onRemove={onRemove} />}
		</Sheet>
	);
}

function DrawerBody({ skill, onToggle, onRemove }: Omit<SkillDrawerProps, "skill" | "onClose"> & { skill: SkillEntry }) {
	const { t } = useTranslation("extensions");
	const doc = useLoad(() => window.vomp.invoke("skills:read", skill.filePath), [skill.filePath]);
	const locked = lockedReason(skill);
	const issues = [...skill.issues.map(issue => issue.message), ...skill.warnings];
	return (
		<SheetContent
			width={460}
			noScrim
			title={
				<span className="flex items-center gap-2">
					<LetterTile name={skill.name} className="size-6 text-xs" />
					<span className="truncate">{skill.name}</span>
				</span>
			}
			description={t(skill.level === "project" ? "scope.project" : "scope.user")}
			bodyClassName="flex flex-col gap-5"
			footer={
				<>
					<Button icon={<FolderOpen />} className="mr-auto" onClick={() => void window.vomp.invoke("app:showItem", skill.filePath)}>
						{t("skills.drawer.showFile")}
					</Button>
					{skill.registry && (
						<Button variant="danger-ghost" icon={<Trash2 />} onClick={() => onRemove(skill)}>
							{t("common.remove")}
						</Button>
					)}
				</>
			}
		>
			<Switch
				label={t("skills.drawer.enabled")}
				description={locked ? t(`skills.reason.${locked}`) : t("skills.drawer.enabledHint")}
				checked={skill.enabled}
				disabled={Boolean(locked)}
				onCheckedChange={enabled => onToggle(skill, enabled)}
			/>

			<section className="flex flex-col gap-1.5">
				<BracketLabel as="h3">{t("skills.drawer.what")}</BracketLabel>
				<p className="text-md text-fg">{skill.description || t("skills.noDescription")}</p>
			</section>

			<section className="flex flex-col gap-1.5">
				<BracketLabel as="h3">{t("skills.drawer.when")}</BracketLabel>
				<p className="text-md text-fg-muted">{t(skill.hidden ? "skills.drawer.whenHidden" : "skills.drawer.whenAuto")}</p>
				<code className="self-start rounded-sm bg-inset px-1.5 py-0.5 font-mono text-sm text-fg">/skill:{skill.name}</code>
			</section>

			<section className="flex flex-col gap-1.5">
				<BracketLabel as="h3">{t("skills.drawer.source")}</BracketLabel>
				<div className="flex flex-wrap items-center gap-1.5">
					<Chip tone="neutral">{providerLabel(skill.provider)}</Chip>
					{skill.registry && <Chip tone="blue">{`${skill.registry.id}@${skill.registry.version}`}</Chip>}
				</div>
				<span className="break-all font-mono text-xs text-fg-faint">{skill.filePath}</span>
			</section>

			{issues.length > 0 && (
				<Notice tone="warn">
					<ul className="flex flex-col gap-1">
						{issues.map(issue => (
							<li key={issue}>{issue}</li>
						))}
					</ul>
				</Notice>
			)}

			<section className="flex flex-col gap-1.5">
				<BracketLabel as="h3">{t("skills.drawer.instructions")}</BracketLabel>
				{doc.error ? (
					<Notice tone="err">{doc.error}</Notice>
				) : doc.data ? (
					<div className="rounded-md border border-border bg-inset p-3 text-sm">
						<Markdown text={doc.data.body} />
					</div>
				) : (
					<Skeleton height={160} />
				)}
			</section>
		</SheetContent>
	);
}
