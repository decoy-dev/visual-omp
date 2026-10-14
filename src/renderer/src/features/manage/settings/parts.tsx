import type { SettingSource } from "@shared/contracts/config";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsSectionProps } from "@/registry/slots";
import { Button, Chip, Notice, ScopeSwitch } from "@/ui";
import { whenLeaving } from "@/state/leaveGuard";
import { folderName, useExternalConfigChange } from "../shared";

/**
 * One settings row: label + help text on the left, control on the right. Controls carry their own
 * `aria-label` (the same text as the visible label), so the row needs no id plumbing.
 */
export function SettingRow({
	label,
	description,
	control,
	meta,
}: {
	label: ReactNode;
	description?: ReactNode;
	control: ReactNode;
	/** Chips after the label (source, edited). */
	meta?: ReactNode;
}) {
	return (
		<div className="flex items-start justify-between gap-6 py-3">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-md font-medium text-fg">{label}</span>
					{meta}
				</div>
				{description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
			</div>
			<div className="flex shrink-0 items-center gap-2">{control}</div>
		</div>
	);
}

/** Group of rows inside a Settings section, with an optional heading. */
export function SettingsSection({ title, description, children }: { title?: ReactNode; description?: ReactNode; children: ReactNode }) {
	return (
		<section className="mb-8">
			{title && <h2 className="text-md font-semibold text-fg">{title}</h2>}
			{description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
			<div className="relative mt-2 divide-y divide-border">{children}</div>
		</section>
	);
}

/** Where a value comes from, when that is not simply "your settings". */
export function SourceChip({ source }: { source: SettingSource }) {
	const { t } = useTranslation("manage");
	if (source === "global" || source === "default") return null;
	return <Chip tone={source === "project" ? "neutral" : "warn"}>{t(`settings.source.${source}`)}</Chip>;
}

/** The scope switch for a scoped section's `PageHeader` meta line. */
export function SectionScope({ projectPath, scope, setScope }: Pick<SettingsSectionProps, "projectPath" | "scope" | "setScope">) {
	const { t } = useTranslation("manage");
	return (
		<ScopeSwitch
			value={scope}
			onValueChange={setScope}
			label={t("settings.scope.label")}
			allLabel={t("settings.scope.global")}
			projectLabel={projectPath ? t("settings.scope.project", { name: folderName(projectPath) }) : t("settings.scope.noProject")}
			projectDisabled={!projectPath}
		/>
	);
}

/**
 * Notices above a section that reads omp's config: edits made outside the app since it loaded, and a
 * failed load. `onReload` reads everything again and may drop pending edits, so it runs only after
 * the user agrees to discard them (`whenLeaving`).
 */
export function ConfigNotices({ cwd, error, onReload }: { cwd: string | null; error: string | null; onReload(): void }) {
	const { t } = useTranslation("manage");
	const [externalChange, clearExternalChange] = useExternalConfigChange(cwd);
	if (!externalChange && !error) return null;
	const reload = () =>
		void whenLeaving(() => {
			clearExternalChange();
			onReload();
		});
	return (
		<div className="mb-6 flex flex-col gap-2">
			{externalChange && (
				<Notice
					tone="info"
					actions={
						<Button
							size="sm"
							icon={<ArrowsClockwise />}
							onClick={reload}
						>
							{t("settings.reload")}
						</Button>
					}
				>
					{t("settings.externalChange")}
				</Notice>
			)}
			{error && (
				<Notice
					tone="err"
					actions={
						<Button size="sm" onClick={reload}>
							{t("settings.retry")}
						</Button>
					}
				>
					{t("settings.loadFailed", { reason: error })}
				</Notice>
			)}
		</div>
	);
}
