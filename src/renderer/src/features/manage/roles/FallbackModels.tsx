import type { JsonValue, ModelInfo, ModelRoleInfo, RoleThinking, SettingInfo, SettingScope } from "@shared/contracts/config";
import { ArrowDown, ArrowUp, X } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton, Notice, Select, SelectItem, Switch } from "@/ui";
import { SettingRow, SettingsSection, SourceChip } from "../settings/parts";
import type { OmpSettings } from "../settings/useOmpSettings";
import { ModelSelect } from "./ModelSelect";
import { FALLBACK_KEY, fallbackEntry, fallbackRecord, fallbackScopeRecord, replaceFallback, scopedFallbackSetting, type FallbackDraft } from "./fallbackModel";

interface FallbackModelsProps {
	role: ModelRoleInfo;
	value: JsonValue | undefined;
	models: ModelInfo[] | null;
	disabled: boolean;
	effectiveValue: JsonValue | undefined;
	scope: SettingScope;
	onChange(chain: FallbackDraft): void;
}

/** Role chains wait for Save roles, just like their primary assignments. */
export function FallbackModels({ role, value, models, disabled, effectiveValue, scope, onChange }: FallbackModelsProps) {
	const { t } = useTranslation("manage");
	const group = useRef<HTMLDivElement>(null);
	const focusAfterChange = useRef<{ index: number; delta?: number } | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const list = models ?? [];
	const chain = value === undefined ? [] : value;
	const editable = Array.isArray(chain) && chain.every(raw => {
		const entry = fallbackEntry(raw, list);
		return entry !== null && role.acceptsKinds.includes(entry.model.kind);
	});
	const name = role.name || role.id;
	const id = `fallbacks-${role.id}`;

	// Reordering replaces row contents. Keep keyboard focus with the moved entry.
	useLayoutEffect(() => {
		const pending = focusAfterChange.current;
		if (!pending) return;
		focusAfterChange.current = null;
		const row = group.current?.querySelector(`[data-fallback-index="${pending.index}"]`);
		const sameAction = row?.querySelector<HTMLButtonElement>(`button[data-move="${pending.delta}"]:not(:disabled)`);
		const nextControl = sameAction ?? row?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled)')
			?? group.current?.querySelector<HTMLElement>('[data-add-fallback] button, [data-add-fallback] select');
		nextControl?.focus();
	}, [value]);

	const move = (index: number, delta: -1 | 1) => {
		if (!Array.isArray(chain)) return;
		const next = [...chain] as string[];
		[next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
		focusAfterChange.current = { index: index + delta, delta };
		setAnnouncement(t("fallbacks.moved", { index: index + delta + 1 }));
		onChange(next);
	};
	const remove = (index: number) => {
		if (!Array.isArray(chain)) return;
		focusAfterChange.current = { index: Math.max(0, Math.min(index, chain.length - 2)) };
		onChange((chain as string[]).filter((_, position) => position !== index));
	};

	return (
		<div ref={group} className="mt-4" role="group" aria-labelledby={id}>
			<h4 id={id} className="text-sm font-medium text-fg-muted">{t("fallbacks.title")}</h4>
			{!editable ? (
				<div className="mt-2 space-y-2">
					<pre className="whitespace-pre-wrap break-all font-mono text-xs text-fg-muted">{JSON.stringify(chain, null, 2)}</pre>
					<p className="text-sm text-fg-muted">{t("fallbacks.readOnly")}</p>
				</div>
			) : (
				<>
					{chain.length === 0 && <p className="mt-2 text-sm text-fg-faint">{t("fallbacks.empty")}</p>}
					<ol className="mt-2 space-y-2" aria-label={t("fallbacks.listFor", { role: name })}>
						{chain.map((raw, index) => {
							// omp's hub omits new Auto picks: retry fallback applies Auto as inheritance.
							// Keep a stored :auto suffix visible and unchanged until the user edits it.
							const entry = fallbackEntry(raw, list)!;
							const choices = [...new Set<RoleThinking>([
								"inherit", ...(entry.model.reasoning && entry.model.thinkingLevels.length > 0 ? ["off" as const, ...entry.model.thinkingLevels] : []),
								...(entry.thinking ? [entry.thinking] : []),
							])];
							return (
								<li key={index} data-fallback-index={index} className="flex flex-wrap items-center gap-2">
									<span className="w-4 text-xs tabular-nums text-fg-faint" aria-hidden>{index + 1}.</span>
									<ModelSelect
										className="min-w-0 flex-[2_1_12rem]"
										models={list} accepts={role.acceptsKinds} value={entry.model.selector}
										autoLabel={t("fallbacks.choose")}
										aria-label={t("fallbacks.modelFor", { role: name, index: index + 1 })}
										disabled={disabled}
										onChange={value => { if (value) onChange(replaceFallback(chain as string[], index, value)); }}
									/>
									<Select
										className="min-w-0 flex-[1_1_8rem]"
										value={entry.thinking ?? "inherit"}
										aria-label={t("fallbacks.thinkingFor", { role: name, index: index + 1 })}
										disabled={disabled || choices.length < 2}
										onValueChange={thinking => onChange(replaceFallback(chain as string[], index,
											thinking === "inherit" ? entry.model.selector : `${entry.model.selector}:${thinking}`))}
									>
										{choices.map(choice => <SelectItem key={choice} value={choice}>
											{choice === "inherit" ? t("fallbacks.inherit") : t(`thinking.${choice}`)}
										</SelectItem>)}
									</Select>
									<div className="flex items-center">
										<IconButton icon={<ArrowUp />} data-move={-1} label={t("fallbacks.up", { role: name, index: index + 1 })}
											disabled={disabled || index === 0} onClick={() => move(index, -1)} />
										<IconButton icon={<ArrowDown />} data-move={1} label={t("fallbacks.down", { role: name, index: index + 1 })}
											disabled={disabled || index === chain.length - 1} onClick={() => move(index, 1)} />
										<IconButton icon={<X />} label={t("fallbacks.remove", { role: name, index: index + 1 })}
											disabled={disabled} onClick={() => remove(index)} />
									</div>
								</li>
							);
						})}
					</ol>
					<div data-add-fallback className="mt-2">
						<ModelSelect
							className="w-full" models={list} accepts={role.acceptsKinds} value={null}
							autoLabel={t("fallbacks.add")} aria-label={t("fallbacks.addFor", { role: name })}
							disabled={disabled || !models}
							onChange={value => { if (value && !chain.includes(value)) onChange([...(chain as string[]), value]); }}
						/>
					</div>
					<p className="mt-2 text-xs text-fg-faint">{t(value === undefined
						? "fallbacks.unsetHelp" : chain.length === 0 ? "fallbacks.explicitEmptyHelp" : "fallbacks.chainHelp")}</p>
					<div className="mt-2 flex flex-wrap gap-2">
						{(value === undefined || chain.length > 0) && <Button size="sm" variant="ghost" aria-label={t("fallbacks.disableFor", { role: name })} disabled={disabled} onClick={() => onChange(null)}>
							{t("fallbacks.disable")}
						</Button>}
						{value !== undefined && <Button size="sm" variant="ghost" aria-label={t("fallbacks.resetFor", { role: name })} disabled={disabled} onClick={() => onChange([])}>
							{t(scope === "project" ? "fallbacks.useInherited" : "fallbacks.useDefaults")}
						</Button>}
					</div>
				</>
			)}
			{JSON.stringify(value) !== JSON.stringify(effectiveValue) && effectiveValue !== undefined && (
				<Notice tone="info" className="mt-3">
					{t("fallbacks.effectiveChain")}
					<pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(effectiveValue, null, 2)}</pre>
				</Notice>
			)}
			<span className="sr-only" role="status">{announcement}</span>
		</div>
	);
}

/** Controls edit the selected layer while keeping omp's effective value visible. */
export function FallbackBehavior({ omp }: { omp: OmpSettings }) {
	const { t } = useTranslation("manage");
	const enabled = omp.byKey.get("retry.modelFallback");
	const target = enabled ? scopedFallbackSetting(enabled, omp.scope) : null;
	return (
		<SettingsSection title={t("fallbacks.behavior")} description={t("fallbacks.scopeHelp")}>
			{enabled && target && <SettingRow
				label={t("fallbacks.enabled")}
				description={<>{t("fallbacks.enabledHelp")}<EffectiveFallbackValue setting={enabled} target={target.value} /></>}
				meta={<SourceChip source={target.source} />}
				control={typeof target.value === "boolean"
					? <Switch aria-label={t("fallbacks.enabled")} checked={target.value} onCheckedChange={value => void omp.write(enabled.key, value)} />
					: <code>{JSON.stringify(target.value)}</code>}
			/>}
			<FallbackChoice setting={omp.byKey.get("retry.fallbackOn")} label={t("fallbacks.when")} options={["any", "usage-limit", "except-usage-limit"]} omp={omp} />
			<FallbackChoice setting={omp.byKey.get("retry.fallbackRevertPolicy")} label={t("fallbacks.revert")} options={["cooldown-expiry", "never"]} omp={omp} />
		</SettingsSection>
	);
}

function EffectiveFallbackValue({ setting, target }: { setting: SettingInfo; target: JsonValue }) {
	const { t } = useTranslation("manage");
	if (JSON.stringify(setting.value) === JSON.stringify(target)) return null;
	const display = typeof setting.value === "boolean" ? t(setting.value ? "fallbacks.on" : "fallbacks.off")
		: typeof setting.value === "string" ? t(`fallbacks.values.${setting.value}`, { defaultValue: setting.value }) : JSON.stringify(setting.value);
	return <span className="mt-2 flex flex-wrap items-center gap-2">
		{t("fallbacks.effectiveValue", { value: display })} <SourceChip source={setting.source} />
	</span>;
}

function FallbackChoice({ setting, label, options, omp }: {
	setting: SettingInfo | undefined;
	label: string;
	options: string[];
	omp: OmpSettings;
}) {
	const { t } = useTranslation("manage");
	if (!setting) return null;
	const target = scopedFallbackSetting(setting, omp.scope);
	const metadataChoices = setting.enumValues;
	const supported = metadataChoices?.length ? options.filter(value => metadataChoices.includes(value))
		: options.filter(value => value !== "except-usage-limit");
	const known = typeof target.value === "string" && supported.includes(target.value);
	return <SettingRow label={label} meta={<SourceChip source={target.source} />}
		description={JSON.stringify(target.value) !== JSON.stringify(setting.value) ? <EffectiveFallbackValue setting={setting} target={target.value} /> : undefined}
		control={known
			? <Select className="w-52" aria-label={label} value={target.value as string} onValueChange={value => void omp.write(setting.key, value)}>
				{supported.map(value => <SelectItem key={value} value={value}>{t(`fallbacks.values.${value}`)}</SelectItem>)}
			</Select>
			: <code>{JSON.stringify(target.value)}</code>}
	/>;
}

export function OtherFallbackChains({ omp, roles }: { omp: OmpSettings; roles: ModelRoleInfo[] }) {
	const { t } = useTranslation("manage");
	const setting = omp.byKey.get(FALLBACK_KEY);
	if (!setting) return null;
	const target = fallbackScopeRecord(setting, omp.scope);
	const effective = fallbackRecord(setting.value);
	if (!target || !effective) return <Notice tone="warn" className="my-4">
		{t("fallbacks.readOnly")} <code className="break-all">{JSON.stringify(!target
			? omp.scope === "project" ? setting.projectValue : setting.globalValue : setting.value)}</code>
	</Notice>;
	const otherTarget = Object.fromEntries(Object.entries(target).filter(([key]) => !roles.some(role => role.id === key)));
	const otherEffective = Object.fromEntries(Object.entries(effective).filter(([key]) => !roles.some(role => role.id === key)));
	if (!Object.keys(otherTarget).length && !Object.keys(otherEffective).length) return null;
	return <details className="my-4 text-sm text-fg-muted">
		<summary className="cursor-pointer">{t("fallbacks.other")}</summary>
		<p className="mt-2">{t("fallbacks.otherHelp")}</p>
		<p className="mt-2">{t("fallbacks.savedScope")}</p>
		<pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(otherTarget, null, 2)}</pre>
		{JSON.stringify(otherTarget) !== JSON.stringify(otherEffective) && <>
			<p className="mt-2">{t("fallbacks.effectiveChain")}</p>
			<pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(otherEffective, null, 2)}</pre>
		</>}
	</details>;
}
