import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PaneProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { cn, Tooltip } from "@/ui";
import { focusRing } from "@/ui/styles";
import { formatUsd } from "../format";

const REFRESH_MS = 60_000;

/** Status bar (right, order 20): today's estimated cost; opens the usage dashboard. */
export function UsageStatus({ projectPath }: PaneProps) {
	const { t } = useTranslation("extensions");
	const [cost, setCost] = useState<number | null>(null);
	useEffect(() => {
		let alive = true;
		const refresh = () =>
			void window.vomp
				.invoke("extensions:spend", 1)
				.then(summary => alive && setCost(summary.days.at(-1)?.cost ?? 0))
				.catch(() => undefined);
		refresh();
		const timer = setInterval(refresh, REFRESH_MS);
		window.addEventListener("focus", refresh);
		return () => {
			alive = false;
			clearInterval(timer);
			window.removeEventListener("focus", refresh);
		};
	}, []);
	if (cost === null) return null;
	const text = t("usage.statusText", { cost: formatUsd(cost) });
	return (
		<Tooltip content={t("usage.statusTooltip")}>
			<button
				type="button"
				onClick={() => useApp.getState().openSheet("usage", { projectPath })}
				className={cn("inline-flex h-full items-center rounded-sm px-1.5 font-mono text-xs text-fg-muted hover:bg-hover hover:text-fg", focusRing)}
			>
				{text}
			</button>
		</Tooltip>
	);
}
