import type { SettingSource } from "@shared/contracts/config";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Chip } from "@/ui";

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
				{description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
			</div>
			<div className="flex shrink-0 items-center gap-2">{control}</div>
		</div>
	);
}

/** Group heading inside a settings tab. */
export function SettingsSection({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
	return (
		<section className="mb-6">
			<h3 className="text-sm font-semibold text-fg">{title}</h3>
			{description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
			<div className="relative mt-1 divide-y divide-border">{children}</div>
		</section>
	);
}

/** Where a value comes from, when that is not simply "your settings". */
export function SourceChip({ source }: { source: SettingSource }) {
	const { t } = useTranslation("manage");
	if (source === "global" || source === "default") return null;
	return <Chip tone={source === "project" ? "neutral" : "warn"}>{t(`settings.source.${source}`)}</Chip>;
}
