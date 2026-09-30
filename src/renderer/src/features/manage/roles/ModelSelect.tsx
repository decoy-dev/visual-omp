import type { ModelInfo, ModelKind } from "@shared/contracts/config";
import { Brain, Eye, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Select, SelectGroup, SelectItem, SelectLabel, SelectSeparator } from "@/ui";
import { formatContextWindow, groupModelsByProvider, modelValueStatus } from "./rolesModel";

/** Radix Select forbids "" as an item value. */
const AUTO = "__auto__";

/** Low-cost models get the ⚡ badge: at most $1 per million input tokens. */
const CHEAP_INPUT_USD_PER_MTOK = 1;

export function ModelCapabilities({ model }: { model: ModelInfo }) {
	const { t } = useTranslation("manage");
	const context = formatContextWindow(model.contextWindow);
	return (
		<span className="inline-flex items-center gap-1.5 text-fg-faint">
			{model.vision && (
				<span title={t("models.caps.vision")}>
					<Eye aria-hidden className="size-3.5" />
					<span className="sr-only">{t("models.caps.vision")}</span>
				</span>
			)}
			{model.reasoning && (
				<span title={t("models.caps.reasoning")}>
					<Brain aria-hidden className="size-3.5" />
					<span className="sr-only">{t("models.caps.reasoning")}</span>
				</span>
			)}
			{model.cost && model.cost.input <= CHEAP_INPUT_USD_PER_MTOK && (
				<span title={t("models.caps.cheap")}>
					<Zap aria-hidden className="size-3.5" />
					<span className="sr-only">{t("models.caps.cheap")}</span>
				</span>
			)}
			{context && <span className="font-mono text-xs">{t("models.context", { size: context })}</span>}
		</span>
	);
}

export interface ModelSelectProps {
	models: readonly ModelInfo[];
	accepts: readonly ModelKind[];
	/** Stored selector; null = automatic. */
	value: string | null;
	onChange(value: string | null): void;
	/** Label of the null choice ("Let omp choose", "Use the helper's own model"). */
	autoLabel: string;
	"aria-label": string;
	disabled?: boolean;
	className?: string;
}

/** Model picker grouped by provider with capability icons and context size. */
export function ModelSelect({ models, accepts, value, onChange, autoLabel, disabled, className, ...aria }: ModelSelectProps) {
	const { t } = useTranslation("manage");
	const groups = groupModelsByProvider(models, accepts);
	const status = modelValueStatus(value, models);
	// Aliases, patterns and unavailable models are kept selectable so the current value shows.
	const unlisted = value !== null && !models.some(model => model.selector === value) ? value : null;
	return (
		<Select
			value={value ?? AUTO}
			onValueChange={next => onChange(next === AUTO ? null : next)}
			invalid={status === "missing"}
			disabled={disabled}
			className={className}
			aria-label={aria["aria-label"]}
			contentClassName="max-w-[420px]"
		>
			<SelectItem value={AUTO}>{autoLabel}</SelectItem>
			{unlisted && (
				<SelectItem value={unlisted} hint={t(status === "alias" ? "models.alias" : status === "missing" ? "models.unavailable" : "models.custom")}>
					{unlisted}
				</SelectItem>
			)}
			{groups.map(([provider, list]) => (
				<SelectGroup key={provider}>
					<SelectSeparator />
					<SelectLabel>{provider}</SelectLabel>
					{list.map(model => (
						<SelectItem key={model.selector} value={model.selector} hint={<ModelCapabilities model={model} />}>
							{model.name}
						</SelectItem>
					))}
				</SelectGroup>
			))}
		</Select>
	);
}
