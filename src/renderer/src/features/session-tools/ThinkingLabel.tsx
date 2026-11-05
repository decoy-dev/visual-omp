import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ThinkingState } from "./thinking";

/** The same wording serves the toolbar, menu and status bar, including their accessible names. */
export function thinkingLabel(thinking: ThinkingState, t: TFunction): string {
	const label = t(thinking.configured ? `session:thinking.levels.${thinking.configured}.label` : "session:thinking.title");
	if (thinking.configured !== "auto") return label;
	const effort = thinking.resolved ? t(`session:thinking.levels.${thinking.resolved}.label`) : null;
	const detail = effort ? thinking.provisional ? t("session:thinking.provisional", { level: effort }) : effort : thinking.provisional ? t("session:thinking.pending") : null;
	return detail ? `${label} · ${detail}` : label;
}

export function ThinkingLabel({ thinking }: { thinking: ThinkingState }) {
	const { t } = useTranslation("session");
	const label = thinkingLabel(thinking, t);
	const separator = label.indexOf(" · ");
	if (separator < 0) return <span>{label}</span>;
	return <span>{label.slice(0, separator)}<span className={thinking.resolved === "low" ? "font-medium text-fg" : "text-fg-muted"}>{label.slice(separator)}</span></span>;
}
