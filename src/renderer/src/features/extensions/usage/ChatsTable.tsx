/**
 * Usage & limits → Chats (DESIGN §4.18): the range's chats in one table under the page scroll (sticky
 * header, 25 rows a page). Search, project and model filters apply to the table and its export only;
 * the summary and chart above always cover every chat in the range.
 *
 * Below 56rem of table width (a narrow window or large text) the model, token and time columns would
 * leave the chat title too little room, so they move onto a second line under the title and a
 * "Sort by" control in the toolbar keeps every sort available.
 */
import { ArrowDown, ArrowUp, CaretLeft, CaretRight, Cpu, DownloadSimple, Folder, FunnelSimple } from "@phosphor-icons/react";
import type { SpendChat, SpendDay } from "@shared/contracts/extensions";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/state/app";
import {
	Button,
	Cell,
	cn,
	EmptyState,
	FilterPill,
	MenuRadioGroup,
	MenuRadioItem,
	SearchInput,
	Segmented,
	Select,
	SelectItem,
	SortHeaderCell,
	Table,
	TableHead,
	TableRow,
	toast,
} from "@/ui";
import { focusRing, focusRingInset } from "@/ui/styles";
import { errorText, formatCount, formatDuration, formatUsd } from "../format";
import { type ChatSortKey, chatsCsv, chatsCsvName, filterChats, projectName, promptTokens, type SortDirection, sortChats } from "./model";
import { useUsageView } from "./viewStore";

const PAGE_SIZE = 25;
/** Filter menu value for "no filter" (the store keeps null). */
const ALL = "__all__";

/** Columns that only show in the wide layout. */
const WIDE_ONLY = "hidden @min-[56rem]/chats:table-cell";

const COLUMNS: { key: ChatSortKey; align: "left" | "right"; className?: string }[] = [
	{ key: "title", align: "left" },
	{ key: "model", align: "left", className: `w-32 ${WIDE_ONLY}` },
	{ key: "inputTokens", align: "right", className: `w-28 ${WIDE_ONLY}` },
	{ key: "outputTokens", align: "right", className: `w-30 ${WIDE_ONLY}` },
	{ key: "cost", align: "right", className: "w-36" },
	{ key: "durationMs", align: "right", className: `w-32 ${WIDE_ONLY}` },
];

/** First direction when a column becomes the sort: numbers highest first, text A to Z. */
const firstDirection = (key: ChatSortKey): SortDirection => (key === "title" || key === "model" ? "asc" : "desc");

export function ChatsTable({ chats, days }: { chats: readonly SpendChat[]; days: readonly SpendDay[] }) {
	const { t } = useTranslation("extensions");
	const { sort, query, project, model, page, setSort, setFilters, clearFilters, setPage } = useUsageView();
	const heading = useRef<HTMLHeadingElement>(null);
	const focusHeading = useRef(false);

	const projects = useMemo(() => {
		const paths = [...new Set(chats.map(chat => chat.cwd))];
		if (project !== null && !paths.includes(project)) paths.push(project);
		return paths.sort((a, b) => projectName(a).localeCompare(projectName(b)));
	}, [chats, project]);
	const models = useMemo(() => {
		const ids = [...new Set(chats.flatMap(chat => (chat.model ? [chat.model] : [])))];
		if (model !== null && !ids.includes(model)) ids.push(model);
		return ids.sort((a, b) => a.localeCompare(b));
	}, [chats, model]);
	const rows = useMemo(() => sortChats(filterChats(chats, { query, project, model }), sort.key, sort.direction), [chats, query, project, model, sort]);

	const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
	const current = Math.min(page, pageCount - 1);
	const visible = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
	const filtered = query.trim() !== "" || project !== null || model !== null;

	// After Previous or Next, the heading takes focus at the top of the new page, so the next Tab
	// reaches the filters and then the new rows in reading order.
	useEffect(() => {
		if (!focusHeading.current) return;
		focusHeading.current = false;
		heading.current?.focus({ preventScroll: true });
		heading.current?.scrollIntoView({ block: "start" });
	}, [current]);
	const goTo = (next: number) => {
		focusHeading.current = true;
		setPage(next);
	};

	const open = async (chat: SpendChat) => {
		try {
			const known = (await window.vomp.invoke("sessions:list", chat.cwd)).find(session => session.file === chat.file);
			useApp.getState().openSession(
				known ?? {
					id: chat.id,
					file: chat.file,
					cwd: chat.cwd,
					title: chat.title,
					createdAt: chat.createdAt || chat.firstAt,
					updatedAt: chat.lastAt,
					parentSession: null,
					preview: null,
					archived: false,
				},
			);
		} catch (err) {
			toast({ tone: "err", message: t("usage.chats.openFailed"), description: errorText(err), action: { label: t("common.retry"), onClick: () => void open(chat) } });
		}
	};

	const exportCsv = async () => {
		try {
			const saved = await window.vomp.invoke("extensions:saveText", {
				title: t("usage.chats.export"),
				defaultName: chatsCsvName(days),
				content: chatsCsv(rows, t("usage.untitled")),
				filters: [{ name: "CSV", extensions: ["csv"] }],
			});
			if (saved) toast({ tone: "ok", message: t("usage.toast.exported"), action: { label: t("common.showInFolder"), onClick: () => void window.vomp.invoke("app:showItem", saved) } });
		} catch (err) {
			toast({ tone: "err", message: t("usage.toast.exportFailed"), description: errorText(err) });
		}
	};

	return (
		<section aria-labelledby="usage-chats-title" className="@container/chats flex flex-col rounded-lg border border-border bg-panel">
			<div className="px-card pt-card">
				<h3 ref={heading} id="usage-chats-title" tabIndex={-1} className={cn("w-fit scroll-mt-4 rounded-sm text-md font-semibold text-fg", focusRing)}>
					{t("usage.chats.title")}
				</h3>
				<p className="mt-1 text-sm text-fg-muted">{t("usage.chats.description")}</p>
			</div>

			<div role="toolbar" aria-label={t("usage.chats.toolbar")} className="mt-stack flex flex-wrap items-center gap-toolbar px-card">
				<SearchInput
					value={query}
					onValueChange={value => setFilters({ query: value })}
					placeholder={t("usage.chats.search")}
					aria-label={t("usage.chats.search")}
					size="sm"
					className="w-full max-w-64"
				/>
				<FilterPill
					label={t("usage.chats.projectFilter")}
					icon={<Folder />}
					value={project === null ? undefined : projectName(project)}
					onClear={() => setFilters({ project: null })}
					clearLabel={t("usage.chats.clearProject")}
				>
					<MenuRadioGroup value={project ?? ALL} onValueChange={value => setFilters({ project: value === ALL ? null : value })}>
						<MenuRadioItem value={ALL}>{t("usage.chats.allProjects")}</MenuRadioItem>
						{projects.map(path => (
							<MenuRadioItem key={path} value={path} description={projects.some(other => other !== path && projectName(other) === projectName(path)) ? path : undefined}>
								{projectName(path)}
							</MenuRadioItem>
						))}
					</MenuRadioGroup>
				</FilterPill>
				<FilterPill
					label={t("usage.chats.modelFilter")}
					icon={<Cpu />}
					value={model === null ? undefined : model.split("/").pop()}
					onClear={() => setFilters({ model: null })}
					clearLabel={t("usage.chats.clearModel")}
				>
					<MenuRadioGroup value={model ?? ALL} onValueChange={value => setFilters({ model: value === ALL ? null : value })}>
						<MenuRadioItem value={ALL}>{t("usage.chats.allModels")}</MenuRadioItem>
						{models.map(id => (
							<MenuRadioItem key={id} value={id} description={id.split("/")[0]}>
								{id.split("/").pop()}
							</MenuRadioItem>
						))}
					</MenuRadioGroup>
				</FilterPill>
				<div className="flex items-center gap-2 @min-[56rem]/chats:hidden">
					<Select
						size="sm"
						value={sort.key}
						onValueChange={value => {
							const key = COLUMNS.find(column => column.key === value)?.key ?? "cost";
							setSort({ key, direction: firstDirection(key) });
						}}
						aria-label={t("usage.chats.sortBy")}
						className="max-w-56"
					>
						{COLUMNS.map(column => (
							<SelectItem key={column.key} value={column.key}>
								{t("usage.chats.sortByOption", { column: t(`usage.chats.column.${column.key}`) })}
							</SelectItem>
						))}
					</Select>
					<Segmented<SortDirection>
						aria-label={t("usage.chats.sortDirection")}
						size="sm"
						value={sort.direction}
						onValueChange={direction => setSort({ key: sort.key, direction })}
						options={[
							{ value: "asc", label: t("usage.chats.ascending"), icon: <ArrowUp aria-hidden /> },
							{ value: "desc", label: t("usage.chats.descending"), icon: <ArrowDown aria-hidden /> },
						]}
					/>
				</div>
				<Button size="sm" icon={<DownloadSimple />} onClick={() => void exportCsv()} disabled={rows.length === 0} className="ml-auto">
					{t("usage.chats.export")}
				</Button>
			</div>

			{rows.length === 0 ? (
				<EmptyState
					icon={<FunnelSimple />}
					title={t("usage.chats.noMatch")}
					actions={
						filtered && (
							<Button size="sm" onClick={clearFilters}>
								{t("usage.chats.clear")}
							</Button>
						)
					}
					className="py-10"
				/>
			) : (
				<>
					<Table
						aria-labelledby="usage-chats-title"
						className="mt-stack [&_td:first-child]:pl-card [&_td:last-child]:pr-card [&_th:first-child]:pl-card [&_th:last-child]:pr-card"
					>
						<TableHead className="bg-panel">
							<tr>
								{COLUMNS.map(column => (
									<SortHeaderCell
										key={column.key}
										label={t(`usage.chats.column.${column.key}`)}
										align={column.align}
										className={column.className}
										active={sort.key === column.key}
										direction={sort.direction}
										onSort={() =>
											setSort({
												key: column.key,
												direction: sort.key === column.key ? (sort.direction === "asc" ? "desc" : "asc") : firstDirection(column.key),
											})
										}
									/>
								))}
							</tr>
						</TableHead>
						<tbody>
							{visible.map(chat => (
								<TableRow key={chat.file} className="hover:bg-hover">
									<Cell>
										<button
											type="button"
											onClick={() => void open(chat)}
											className={cn("block rounded-sm text-left text-fg [overflow-wrap:anywhere] hover:underline", focusRingInset)}
										>
											{chat.title ?? t("usage.untitled")}
										</button>
										<span className="block truncate text-xs text-fg-faint" title={chat.cwd}>
											{projectName(chat.cwd)}
										</span>
										<span className="mt-1 block text-xs tabular-nums text-fg-muted @min-[56rem]/chats:hidden">
											{t("usage.chats.rowDetails", {
												model: chat.model?.split("/").pop() ?? t("usage.noModel"),
												input: formatCount(promptTokens(chat)),
												output: formatCount(chat.outputTokens),
												time: formatDuration(chat.durationMs),
											})}
										</span>
									</Cell>
									<Cell className={cn("font-mono text-xs text-fg-muted [overflow-wrap:anywhere]", WIDE_ONLY)} title={chat.model ?? undefined}>
										{chat.model?.split("/").pop() ?? t("usage.noModel")}
									</Cell>
									<Cell align="right" numeric className={cn("text-fg-muted", WIDE_ONLY)}>
										{formatCount(promptTokens(chat))}
									</Cell>
									<Cell align="right" numeric className={cn("text-fg-muted", WIDE_ONLY)}>
										{formatCount(chat.outputTokens)}
									</Cell>
									<Cell align="right" numeric className="text-fg">
										{formatUsd(chat.cost)}
									</Cell>
									<Cell align="right" numeric className={cn("text-fg-muted", WIDE_ONLY)}>
										{formatDuration(chat.durationMs)}
									</Cell>
								</TableRow>
							))}
						</tbody>
					</Table>
					<nav aria-label={t("usage.chats.pages")} className="flex flex-wrap items-center justify-between gap-2 px-card py-3 text-sm text-fg-muted">
						<p aria-live="polite">
							{t("usage.chats.showing", { from: current * PAGE_SIZE + 1, to: current * PAGE_SIZE + visible.length, count: rows.length })}
						</p>
						{pageCount > 1 && (
							<div className="flex items-center gap-2">
								<Button size="sm" variant="ghost" icon={<CaretLeft />} disabled={current === 0} onClick={() => goTo(current - 1)}>
									{t("usage.chats.previous")}
								</Button>
								<span className="tabular-nums">{t("usage.chats.page", { page: current + 1, total: pageCount })}</span>
								<Button size="sm" variant="ghost" iconRight={<CaretRight />} disabled={current === pageCount - 1} onClick={() => goTo(current + 1)}>
									{t("usage.chats.next")}
								</Button>
							</div>
						)}
					</nav>
				</>
			)}
		</section>
	);
}
