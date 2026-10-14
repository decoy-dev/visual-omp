import type { SettingInfo } from "@shared/contracts/config";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsSectionProps } from "@/registry/slots";
import {
	cn,
	Button,
	Dialog,
	DialogContent,
	EmptyState,
	IconButton,
	Input,
	PageHeader,
	SearchInput,
	Select,
	SelectItem,
	Skeleton,
	Switch,
	toast,
	Tooltip,
} from "@/ui";
import { type AdvancedRow, buildAdvancedRows, parseSettingInput, valueToText } from "./advancedModel";
import { ConfigNotices, SectionScope, SourceChip } from "./parts";
import { type OmpSettings, useOmpSettings } from "./useOmpSettings";

const GROUP_HEIGHT = 36;
const ROW_HEIGHT = 60;
/** Rows rendered above/below the viewport, so Tab can move into the next rows before they scroll in. */
const OVERSCAN_PX = 600;

/** Deep-link props (`openSettings("advanced", { sectionProps })`). */
export interface AdvancedSectionProps {
	/** Prefills the search, such as "memory.backend". */
	query?: string;
}

export function AdvancedSection({ projectPath, scope, setScope, props }: SettingsSectionProps) {
	const { t } = useTranslation("manage");
	const omp = useOmpSettings(projectPath, scope);
	// Each deep link remounts the section (SettingsPage), so the linked search applies once here.
	const [query, setQuery] = useState((props as AdvancedSectionProps | undefined)?.query ?? "");
	const [editedOnly, setEditedOnly] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const [resetting, setResetting] = useState(false);
	const settings = omp.snapshot.data?.settings;
	const rows = useMemo(() => buildAdvancedRows(settings ?? [], query, editedOnly), [settings, query, editedOnly]);

	// Settings that have a value in the scope being edited (credentials are never wiped in bulk).
	const resettable = useMemo(
		() =>
			(settings ?? []).filter(setting => !setting.redacted && (omp.scope === "project" ? setting.projectValue : setting.globalValue) !== null),
		[settings, omp.scope],
	);

	const resetAll = async () => {
		setResetting(true);
		let failed = 0;
		for (const setting of resettable) {
			// Sequential: every reset rewrites the same config file.
			if (!(await omp.reset(setting.key))) failed++;
		}
		setResetting(false);
		setConfirmReset(false);
		if (failed === 0) toast({ tone: "ok", message: t("advanced.resetAll.done", { count: resettable.length }) });
	};

	return (
		<>
			<PageHeader
				title={t("settings.sections.advanced")}
				description={t("advanced.description")}
				meta={<SectionScope projectPath={projectPath} scope={scope} setScope={setScope} />}
				actions={
					<Button variant="danger-ghost" disabled={resettable.length === 0} onClick={() => setConfirmReset(true)}>
						{t("advanced.resetAll.button")}
					</Button>
				}
			/>
			<ConfigNotices cwd={projectPath} error={omp.snapshot.error} onReload={() => void omp.snapshot.reload()} />
			<div className="sticky top-0 z-(--z-sticky) -mx-1 flex items-center gap-2 bg-bg px-1 pb-2 pt-1">
				<SearchInput
					className="flex-1"
					value={query}
					onValueChange={setQuery}
					placeholder={t("advanced.search")}
					aria-label={t("advanced.search")}
					aria-controls="manage-advanced-list"
				/>
				<Button variant={editedOnly ? "primary" : "secondary"} aria-pressed={editedOnly} onClick={() => setEditedOnly(value => !value)}>
					{t("advanced.editedOnly")}
				</Button>
			</div>
			<p className="pb-2 text-xs text-fg-faint" aria-live="polite">
				{settings ? t("advanced.count", { count: rows.filter(row => row.kind === "setting").length }) : t("advanced.loading")}
			</p>
			{!settings ? (
				<div className="space-y-3" aria-busy>
					{Array.from({ length: 6 }, (_, index) => (
						<Skeleton key={index} height={44} />
					))}
				</div>
			) : rows.length === 0 ? (
				<EmptyState title={t("advanced.empty")} />
			) : (
				<VirtualSettings rows={rows} omp={omp} />
			)}
			<Dialog open={confirmReset} onOpenChange={setConfirmReset}>
				<DialogContent
					destructive
					title={t("advanced.resetAll.title")}
					description={t(`advanced.resetAll.body.${omp.scope}`, { count: resettable.length })}
					footer={
						<>
							<Button variant="ghost" onClick={() => setConfirmReset(false)}>
								{t("common.cancel")}
							</Button>
							<Button variant="danger" loading={resetting} onClick={() => void resetAll()}>
								{t("advanced.resetAll.confirm")}
							</Button>
						</>
					}
				/>
			</Dialog>
		</>
	);
}

/** Nearest scrolling ancestor: the page's scroll region. */
function scrollParent(element: HTMLElement): HTMLElement | null {
	for (let node = element.parentElement; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if (overflow === "auto" || overflow === "scroll") return node;
	}
	return null;
}

/** Renders only the rows near the page's viewport; the list scrolls with the page. */
function VirtualSettings({ rows, omp }: { rows: readonly AdvancedRow[]; omp: OmpSettings }) {
	const { t } = useTranslation("manage");
	const list = useRef<HTMLDivElement>(null);
	// The page viewport, in list coordinates.
	const [view, setView] = useState({ top: 0, height: 800 });

	useLayoutEffect(() => {
		const element = list.current;
		const scroller = element && scrollParent(element);
		if (!element || !scroller) return;
		const measure = () => {
			const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
			setView({ top: -offset, height: scroller.clientHeight });
		};
		measure();
		scroller.addEventListener("scroll", measure, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		observer.observe(element);
		return () => {
			scroller.removeEventListener("scroll", measure);
			observer.disconnect();
		};
	}, []);

	const offsets = useMemo(() => {
		const list: number[] = [];
		let top = 0;
		for (const row of rows) {
			list.push(top);
			top += row.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT;
		}
		list.push(top);
		return list;
	}, [rows]);
	const total = offsets[offsets.length - 1] ?? 0;

	const from = view.top - OVERSCAN_PX;
	const to = view.top + view.height + OVERSCAN_PX;
	const visible: number[] = [];
	for (let index = 0; index < rows.length; index++) {
		if (offsets[index + 1] >= from && offsets[index] <= to) visible.push(index);
	}

	return (
		<div ref={list} id="manage-advanced-list" role="list" aria-label={t("advanced.listLabel")} style={{ height: total }} className="relative">
			{visible.map(index => {
				const row = rows[index];
				const style = { top: offsets[index], height: row.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT };
				return row.kind === "group" ? (
					<div key={`g:${row.domain}`} role="listitem" style={style} className="absolute inset-x-0 flex items-end pb-1.5">
						<h2 className="text-sm font-medium text-fg-muted">
							<span className="font-mono">{row.domain}</span> <span className="tabular-nums text-fg-faint">{row.count}</span>
						</h2>
					</div>
				) : (
					<SettingLine key={row.setting.key} setting={row.setting} omp={omp} style={style} />
				);
			})}
		</div>
	);
}


function SettingLine({ setting, omp, style }: { setting: SettingInfo; omp: OmpSettings; style: { top: number; height: number } }) {
	const { t } = useTranslation("manage");
	const layerValue = omp.scope === "project" ? setting.projectValue : setting.globalValue;
	const canReset = layerValue !== null || (setting.redacted && setting.source === omp.scope);
	return (
		<div role="listitem" style={style} className="absolute inset-x-0 flex items-center gap-3 border-b border-border">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					{setting.modified && (
						<Tooltip content={t("advanced.edited")}>
							<span className="inline-flex size-4 items-center justify-center">
								<span aria-hidden className="size-1.5 rounded-full bg-accent" />
								<span className="sr-only">{t("advanced.edited")}</span>
							</span>
						</Tooltip>
					)}
					<span className="truncate font-mono text-sm text-fg" title={setting.key}>
						{setting.key}
					</span>
					<SourceChip source={setting.source} />
				</div>
				<p className="truncate text-sm text-fg-muted" title={setting.description || undefined}>
					{setting.description || t("advanced.noDescription")}
				</p>
			</div>
			<div className="flex w-[228px] shrink-0 items-center justify-end gap-1">
				<SettingControl setting={setting} omp={omp} />
				<IconButton
					size="sm"
					label={t("advanced.reset", { key: setting.key })}
					icon={<ArrowCounterClockwise />}
					disabled={!canReset}
					className={cn(!canReset && "invisible")}
					onClick={() => void omp.reset(setting.key)}
				/>
			</div>
		</div>
	);
}

function SettingControl({ setting, omp }: { setting: SettingInfo; omp: OmpSettings }) {
	const { t } = useTranslation("manage");
	if (setting.type === "boolean") {
		return (
			<Switch
				aria-label={setting.key}
				checked={setting.value === true}
				onCheckedChange={checked => void omp.write(setting.key, checked)}
			/>
		);
	}
	if (setting.type === "enum" && setting.enumValues) {
		return (
			<Select
				size="sm"
				className="w-48"
				aria-label={setting.key}
				placeholder={t("advanced.notSet")}
				value={typeof setting.value === "string" ? setting.value : ""}
				onValueChange={value => void omp.write(setting.key, value)}
			>
				{setting.enumValues.map(value => (
					<SelectItem key={value} value={value} hint={value === setting.defaultValue ? t("advanced.default") : undefined}>
						{value}
					</SelectItem>
				))}
			</Select>
		);
	}
	return <TextControl setting={setting} omp={omp} />;
}

function TextControl({ setting, omp }: { setting: SettingInfo; omp: OmpSettings }) {
	const { t } = useTranslation("manage");
	const shown = setting.redacted ? "" : valueToText(setting.value);
	const [text, setText] = useState(shown);
	useEffect(() => setText(shown), [shown]);

	const commit = async () => {
		if (text === shown) return;
		if (setting.redacted && text === "") return;
		// Clearing a text field removes the value from this scope instead of saving an empty string.
		if (text.trim() === "" && setting.type !== "string") {
			await omp.reset(setting.key);
			return;
		}
		const parsed = parseSettingInput(setting.type, text);
		if (!parsed.ok) {
			toast({ tone: "err", message: t(`advanced.invalid.${parsed.error}`, { key: setting.key }) });
			setText(shown);
			return;
		}
		if (!(await omp.write(setting.key, parsed.value))) setText(shown);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void commit();
		} else if (event.key === "Escape" && text !== shown) {
			event.preventDefault();
			event.stopPropagation();
			setText(shown);
		}
	};
	const defaultText = setting.defaultValue === null ? t("advanced.notSet") : valueToText(setting.defaultValue);

	return (
		<Input
			size="sm"
			aria-label={setting.key}
			type={setting.redacted ? "password" : setting.type === "number" ? "number" : "text"}
			inputMode={setting.type === "number" ? "decimal" : undefined}
			placeholder={setting.redacted ? t("advanced.secretSaved") : defaultText}
			spellCheck={false}
			value={text}
			onChange={event => setText(event.currentTarget.value)}
			onBlur={() => void commit()}
			onKeyDown={onKeyDown}
			className={cn("w-48", (setting.type === "array" || setting.type === "record") && "font-mono")}
		/>
	);
}
