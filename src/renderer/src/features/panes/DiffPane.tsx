/**
 * Diff pane (DESIGN §3.7): changed files on the left, the unified diff of every file on the right
 * with syntax colors and word-level emphasis. Hovering a line's gutter shows ＋ to leave a comment;
 * "Send N comments to omp" (⌘↵) turns them into one chat message. "Review code" runs `/review`.
 */
import {
	ArrowUUpLeft,
	CaretRight,
	ChatCenteredDots,
	GitDiff as GitDiffIcon,
	PaperPlaneRight,
	PencilSimple,
	Plus,
	ShieldCheck,
	SidebarSimple,
	Trash,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { GitDiff, GitDiffHunk, GitDiffLine, GitFileDiff, GitFileStatus } from "@shared/contracts/git";
import type { PaneProps } from "../../registry/slots";
import { controllerFor, useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import {
	Button,
	cn,
	Dialog,
	DialogClose,
	DialogContent,
	duration,
	ease,
	EmptyState,
	Expand,
	IconButton,
	Kbd,
	PresenceSwap,
	Rise,
	Spinner,
	spring,
	Textarea,
	toast,
	useMotionReduced,
} from "../../ui";
import { focusRingInset } from "../../ui/styles";
import { composeReviewMessage, type LineComment } from "./comments";
import { listRowMotion, PaneToolbar, usePaneVisible } from "./common";
import { refreshGit, useGit } from "./git-store";
import { languageFor, SYN_CLASS, type SynToken, tokenizeLines } from "./highlight";
import { hunkEmphasis, type Range } from "./inline-diff";

/** Lines rendered per file before a "Show all" button (keeps huge generated diffs responsive). */
const LINE_BUDGET = 1500;
const MOD_KEY = window.vomp?.platform === "darwin" ? "⌘" : "Ctrl+";

// ── comments store (per project, survives pane switches) ────────────────────────────────────────

interface CommentsState {
	byProject: Record<string, LineComment[]>;
	add(project: string, comment: Omit<LineComment, "id">): void;
	update(project: string, id: string, text: string): void;
	remove(project: string, id: string): void;
	clear(project: string): void;
}

let commentSeq = 0;
const useComments = create<CommentsState>(set => ({
	byProject: {},
	add: (project, comment) =>
		set(state => ({
			byProject: { ...state.byProject, [project]: [...(state.byProject[project] ?? []), { ...comment, id: `c${++commentSeq}` }] },
		})),
	update: (project, id, text) =>
		set(state => ({
			byProject: { ...state.byProject, [project]: (state.byProject[project] ?? []).map(c => (c.id === id ? { ...c, text } : c)) },
		})),
	remove: (project, id) =>
		set(state => ({ byProject: { ...state.byProject, [project]: (state.byProject[project] ?? []).filter(c => c.id !== id) } })),
	clear: project => set(state => ({ byProject: { ...state.byProject, [project]: [] } })),
}));

const NO_COMMENTS: LineComment[] = [];

/** The focused chat, or a new one in this project. */
function chatFor(session: SessionController | null, projectPath: string): SessionController | null {
	if (session) return session;
	return controllerFor(useApp.getState().newChat(projectPath));
}

// ── line rendering ──────────────────────────────────────────────────────────────────────────────

interface Segment {
	role: SynToken["role"];
	text: string;
	emphasis: boolean;
}

/** Split syntax tokens at emphasis range boundaries. */
function segments(tokens: readonly SynToken[], ranges: readonly Range[] | undefined): Segment[] {
	if (!ranges?.length) return tokens.map(token => ({ ...token, emphasis: false }));
	const out: Segment[] = [];
	let offset = 0;
	for (const token of tokens) {
		let start = 0;
		while (start < token.text.length) {
			const at = offset + start;
			const inside = ranges.find(([a, b]) => at >= a && at < b);
			const nextEdge = inside
				? inside[1]
				: Math.min(...ranges.map(([a]) => a).filter(a => a > at), offset + token.text.length);
			const end = Math.min(token.text.length, nextEdge - offset);
			out.push({ role: token.role, text: token.text.slice(start, end), emphasis: inside !== undefined });
			start = end;
		}
		offset += token.text.length;
	}
	return out;
}

const ROW_BG: Record<GitDiffLine["kind"], string> = {
	context: "",
	add: "bg-diff-add-bg",
	del: "bg-diff-del-bg",
};
const EMPHASIS_BG: Record<GitDiffLine["kind"], string> = {
	context: "",
	add: "bg-diff-add-line",
	del: "bg-diff-del-line",
};
const MARKER: Record<GitDiffLine["kind"], string> = { context: " ", add: "+", del: "−" };

const KIND_LETTER: Record<GitFileStatus["kind"], string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	copied: "C",
	typechange: "T",
	untracked: "U",
	conflicted: "!",
};
const KIND_TONE: Record<GitFileStatus["kind"], string> = {
	modified: "text-warn",
	added: "text-diff-add-text",
	untracked: "text-diff-add-text",
	deleted: "text-diff-del-text",
	renamed: "text-fg",
	copied: "text-fg",
	typechange: "text-fg-muted",
	conflicted: "text-err",
};

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

// ── comment editor ──────────────────────────────────────────────────────────────────────────────

function CommentEditor({
	initial,
	onSave,
	onCancel,
}: {
	initial: string;
	onSave(text: string): void;
	onCancel(): void;
}) {
	const { t } = useTranslation("panes");
	const [text, setText] = useState(initial);
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			onCancel();
		} else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey && text.trim()) {
			// Enter saves; Shift+Enter is a new line; ⌘↵ bubbles up to "send all".
			event.preventDefault();
			onSave(text);
		} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim()) {
			onSave(text);
		}
	};
	return (
		<div className="border-y border-border bg-panel px-3 py-2 font-ui">
			<Textarea
				autoFocus
				value={text}
				minRows={2}
				maxRows={8}
				aria-label={t("diff.commentLabel")}
				placeholder={t("diff.commentPlaceholder")}
				onChange={event => setText(event.target.value)}
				onKeyDown={onKeyDown}
			/>
			<div className="mt-2 flex items-center justify-end gap-2">
				<span className="mr-auto text-xs text-fg-faint">{t("diff.commentHint")}</span>
				<Button size="sm" variant="ghost" onClick={onCancel}>
					{t("diff.cancelComment")}
				</Button>
				<Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => onSave(text)}>
					{t("diff.addComment")}
				</Button>
			</div>
		</div>
	);
}

function SavedComment({ comment, projectPath }: { comment: LineComment; projectPath: string }) {
	const { t } = useTranslation("panes");
	const [editing, setEditing] = useState(false);
	const { update, remove } = useComments.getState();
	if (editing) {
		return (
			<CommentEditor
				initial={comment.text}
				onCancel={() => setEditing(false)}
				onSave={text => {
					update(projectPath, comment.id, text.trim());
					setEditing(false);
				}}
			/>
		);
	}
	return (
		<Rise distance={4} className="flex items-start gap-2 border-y border-border bg-accent-muted/60 px-3 py-2 font-ui text-md text-fg">
			<ChatCenteredDots className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
			<p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{comment.text}</p>
			<IconButton size="sm" label={t("diff.editComment")} icon={<PencilSimple />} onClick={() => setEditing(true)} />
			<IconButton size="sm" label={t("diff.deleteComment")} icon={<Trash />} onClick={() => remove(projectPath, comment.id)} />
		</Rise>
	);
}

// ── one hunk ────────────────────────────────────────────────────────────────────────────────────

interface Draft {
	path: string;
	line: number;
	side: "new" | "old";
}

const Hunk = memo(function Hunk({
	hunk,
	lang,
	path,
	projectPath,
	comments,
	draft,
	setDraft,
	limit,
}: {
	hunk: GitDiffHunk;
	lang: string | null;
	path: string;
	projectPath: string;
	comments: readonly LineComment[];
	draft: Draft | null;
	setDraft(draft: Draft | null): void;
	limit: number;
}) {
	const { t } = useTranslation("panes");
	const tokens = useMemo(() => tokenizeLines(hunk.lines.map(line => line.text), lang), [hunk, lang]);
	const emphasis = useMemo(() => hunkEmphasis(hunk.lines), [hunk]);
	const lines = hunk.lines.slice(0, limit);
	return (
		<>
			<div className="flex h-6 items-center bg-diff-hunk-bg px-3 font-mono text-xs text-diff-hunk-text">
				<span className="truncate">
					@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
					{hunk.section && <span className="ml-2 text-fg-faint">{hunk.section}</span>}
				</span>
			</div>
			{lines.map((line, index) => {
				const side = line.kind === "del" ? "old" : "new";
				const number = side === "old" ? line.oldLine : line.newLine;
				const lineComments = number === null ? [] : comments.filter(c => c.line === number && c.side === side);
				const drafting = draft !== null && draft.path === path && draft.line === number && draft.side === side;
				const commentLabel = t("diff.commentOnLine", { line: number });
				return (
					<div key={`${hunk.header}:${index}`}>
						<div className={cn("group/line flex min-h-5 font-mono text-[12px] leading-5", ROW_BG[line.kind])}>
							<span className="relative w-10 shrink-0 select-none pr-1.5 text-right text-fg-faint tabular-nums">
								{line.oldLine ?? ""}
								{number !== null && (
									<button
										type="button"
										aria-label={commentLabel}
										title={commentLabel}
										onClick={() => setDraft({ path, line: number, side })}
										className={cn(
											"absolute inset-y-0 left-0.5 my-auto inline-flex size-4 items-center justify-center rounded-sm bg-accent text-accent-fg",
											"opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100",
											focusRingInset,
										)}
									>
										<Plus className="size-3" weight="bold" aria-hidden />
									</button>
								)}
							</span>
							<span className="w-10 shrink-0 select-none pr-1.5 text-right text-fg-faint tabular-nums">{line.newLine ?? ""}</span>
							<span
								aria-hidden
								className={cn(
									"w-4 shrink-0 select-none text-center",
									line.kind === "add" ? "text-diff-add-text" : line.kind === "del" ? "text-diff-del-text" : "text-fg-faint",
								)}
							>
								{MARKER[line.kind]}
							</span>
							<span className="sr-only">{t(`diff.lineKind.${line.kind}`)}</span>
							<code className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">
								{segments(tokens[index] ?? [], emphasis.get(index)).map((segment, i) => (
									<span
										// biome-ignore lint/suspicious/noArrayIndexKey: static render of one line
										key={i}
										className={cn(SYN_CLASS[segment.role], segment.emphasis && cn(EMPHASIS_BG[line.kind], "rounded-[2px]"))}
									>
										{segment.text}
									</span>
								))}
								{line.noNewline && <span className="ml-2 font-ui text-xs text-fg-faint">{t("diff.noNewline")}</span>}
							</code>
						</div>
						{lineComments.map(comment => (
							<SavedComment key={comment.id} comment={comment} projectPath={projectPath} />
						))}
						{drafting && number !== null && (
							<Rise distance={4}>
								<CommentEditor
									initial=""
									onCancel={() => setDraft(null)}
									onSave={text => {
										useComments.getState().add(projectPath, { path, line: number, side, excerpt: line.text, text: text.trim() });
										setDraft(null);
									}}
								/>
							</Rise>
						)}
					</div>
				);
			})}
		</>
	);
});

// ── one file ────────────────────────────────────────────────────────────────────────────────────

function FileSection({
	file,
	displayPath,
	projectPath,
	comments,
	draft,
	setDraft,
	onDiscard,
	register,
}: {
	file: GitFileDiff;
	displayPath: string;
	projectPath: string;
	comments: readonly LineComment[];
	draft: Draft | null;
	setDraft(draft: Draft | null): void;
	onDiscard(file: GitFileDiff): void;
	register(path: string, element: HTMLElement | null): void;
}) {
	const { t } = useTranslation("panes");
	const [open, setOpen] = useState(true);
	const [showAll, setShowAll] = useState(false);
	const lang = useMemo(() => languageFor(file.path), [file.path]);
	const fileComments = useMemo(() => comments.filter(c => c.path === displayPath), [comments, displayPath]);
	const total = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
	let budget = showAll ? Number.POSITIVE_INFINITY : LINE_BUDGET;
	return (
		<section ref={element => register(file.path, element)} aria-label={displayPath} className="border-b border-border">
			<header className="sticky top-0 z-(--z-sticky) flex h-9 items-center gap-1.5 border-b border-border bg-panel pl-1.5 pr-2">
				<IconButton
					size="sm"
					label={open ? t("diff.collapseFile") : t("diff.expandFile")}
					icon={<CaretRight className={cn("transition-transform duration-(--dur) ease-(--ease-out-quart)", open && "rotate-90")} />}
					aria-expanded={open}
					onClick={() => setOpen(!open)}
				/>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={displayPath}>
					{file.origPath && <span className="text-fg-faint">{file.origPath} → </span>}
					{displayPath}
				</span>
				{fileComments.length > 0 && (
					<span className="text-xs text-accent">{t("diff.commentCount", { count: fileComments.length })}</span>
				)}
				<span className="font-mono text-xs tabular-nums">
					<span className="text-diff-add-text">+{file.additions}</span>{" "}
					<span className="text-diff-del-text">−{file.deletions}</span>
				</span>
				<IconButton
					size="sm"
					variant="danger-ghost"
					label={t("diff.discardFile")}
					icon={<ArrowUUpLeft />}
					onClick={() => onDiscard(file)}
				/>
			</header>
			<Expand open={open} className="bg-inset">
				{file.binary ? (
					<p className="px-4 py-3 text-sm text-fg-muted">{t("diff.binary")}</p>
				) : file.truncated ? (
					<p className="px-4 py-3 text-sm text-fg-muted">{t("diff.truncated")}</p>
				) : file.hunks.length === 0 ? (
					<p className="px-4 py-3 text-sm text-fg-muted">{t("diff.modeOnly")}</p>
				) : (
					file.hunks.map(hunk => {
						if (budget <= 0) return null;
						const limit = budget;
						budget -= hunk.lines.length;
						return (
							<Hunk
								key={hunk.header}
								hunk={hunk}
								lang={lang}
								path={displayPath}
								projectPath={projectPath}
								comments={fileComments}
								draft={draft}
								setDraft={setDraft}
								limit={limit}
							/>
						);
					})
				)}
				{!showAll && total > LINE_BUDGET && (
					<div className="flex justify-center py-2">
						<Button size="sm" variant="secondary" onClick={() => setShowAll(true)}>
							{t("diff.showAll", { count: total })}
						</Button>
					</div>
				)}
			</Expand>
		</section>
	);
}

// ── pane ────────────────────────────────────────────────────────────────────────────────────────

export function DiffPane({ session, projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	if (!projectPath) return <EmptyState icon={<GitDiffIcon />} title={t("diff.noProjectTitle")} body={t("diff.noProject")} />;
	return <DiffView session={session} projectPath={projectPath} />;
}

function DiffView({ session, projectPath }: { session: SessionController | null; projectPath: string }) {
	const { t } = useTranslation("panes");
	const git = useGit(projectPath);
	const visible = usePaneVisible("diff");
	const [diff, setDiff] = useState<GitDiff | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [listOpen, setListOpen] = useState(true);
	const listId = useId();
	const [selected, setSelected] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [discarding, setDiscarding] = useState<GitFileDiff | null>(null);
	const [busy, setBusy] = useState(false);
	const comments = useComments(state => state.byProject[projectPath] ?? NO_COMMENTS);
	const sections = useRef(new Map<string, HTMLElement>());
	const scroller = useRef<HTMLDivElement>(null);
	const reduced = useMotionReduced();
	const loaded = useRef(-1);
	useEffect(() => {
		loaded.current = -1;
		setDiff(null);
		setSelected(null);
		setLoadError(null);
	}, [projectPath]);


	// Reload the diff whenever the work tree changed and the pane is on screen.
	useEffect(() => {
		if (!visible || git.notRepo || git.version === 0 || loaded.current === git.version) return;
		let cancelled = false;
		const version = git.version;
		window.vomp
			.invoke("git:diff", projectPath)
			.then(next => {
				if (cancelled) return;
				loaded.current = version;
				setDiff(next);
				setLoadError(null);
			})
			.catch((error: unknown) => {
				if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			cancelled = true;
		};
	}, [visible, git.version, git.notRepo, projectPath]);

	// Paths relative to the project folder when it is a subfolder of the repository.
	const prefix = useMemo(() => {
		const root = diff?.root;
		if (!root || root === projectPath || !projectPath.startsWith(`${root}/`)) return "";
		return `${projectPath.slice(root.length + 1)}/`;
	}, [diff?.root, projectPath]);
	const display = (path: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);

	const statusByPath = useMemo(() => new Map(git.status?.files.map(file => [file.path, file]) ?? []), [git.status]);
	const files = diff?.files ?? [];

	const sendComments = async () => {
		// Read the store, not the render closure: ⌘↵ in a comment box saves that comment first.
		const pending = useComments.getState().byProject[projectPath] ?? NO_COMMENTS;
		if (pending.length === 0 || busy) return;
		const target = chatFor(session, projectPath);
		if (!target) return;
		setBusy(true);
		try {
			await target.send(composeReviewMessage(pending));
			useComments.getState().clear(projectPath);
			setDraft(null);
			toast({ tone: "ok", message: t("diff.sent", { count: pending.length }) });
		} catch (error) {
			toast({ tone: "err", message: t("diff.sendFailed"), description: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	};

	const review = () => {
		const target = chatFor(session, projectPath);
		target?.command("/review").catch((error: unknown) =>
			toast({ tone: "err", message: t("diff.reviewFailed"), description: error instanceof Error ? error.message : String(error) }),
		);
	};

	const confirmDiscard = async () => {
		const file = discarding;
		if (!file) return;
		setDiscarding(null);
		try {
			await window.vomp.invoke("git:discard", diff?.root ?? projectPath, [file.path]);
			toast({ tone: "ok", message: t("diff.discarded", { file: baseName(file.path) }) });
		} catch (error) {
			toast({ tone: "err", message: t("diff.discardFailed"), description: error instanceof Error ? error.message : String(error) });
		}
		refreshGit(projectPath);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void sendComments();
		}
	};

	const jumpTo = (path: string) => {
		setSelected(path);
		// Scroll the diff column only; scrollIntoView would also scroll the dock and push the toolbar out of view.
		const section = sections.current.get(path);
		const column = scroller.current;
		if (section && column) {
			const top = column.scrollTop + section.getBoundingClientRect().top - column.getBoundingClientRect().top;
			column.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
		}
	};

	const reviewButton = (
		<Button size="sm" variant="primary" icon={<ShieldCheck />} onClick={review} title={t("diff.reviewHint")}>
			{t("diff.review")}
		</Button>
	);

	if (git.notRepo) {
		return <EmptyState icon={<GitDiffIcon />} title={t("diff.notRepoTitle")} body={t("diff.notRepo")} />;
	}
	if (git.error || loadError) {
		return (
			<EmptyState
				icon={<GitDiffIcon />}
				title={t("diff.errorTitle")}
				body={git.error ?? loadError}
				actions={
					<Button size="sm" variant="secondary" onClick={() => refreshGit(projectPath)}>
						{t("diff.reload")}
					</Button>
				}
			/>
		);
	}
	if (!diff) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-muted" role="status">
				<Spinner /> {t("diff.loading")}
			</div>
		);
	}
	const selectedPath = selected ?? files[0]?.path ?? null;
	const view = (
		<div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
			<PaneToolbar>
				<IconButton
					size="sm"
					label={listOpen ? t("diff.hideList") : t("diff.showList")}
					icon={<SidebarSimple />}
					onClick={() => setListOpen(!listOpen)}
				/>
				<nav aria-label={t("diff.breadcrumb")} className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
					{selectedPath &&
						display(selectedPath)
							.split("/")
							.map((part, index, parts) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: path segments
								<span key={index} className={index === parts.length - 1 ? "text-fg" : undefined}>
									{part}
									{index < parts.length - 1 && <span className="px-0.5 text-fg-faint">/</span>}
								</span>
							))}
				</nav>
				{reviewButton}
			</PaneToolbar>
			<div className="flex min-h-0 flex-1">
				<AnimatePresence initial={false}>
					{listOpen && (
						<motion.ul
							key="file-list"
							aria-label={t("diff.fileList")}
							initial={{ opacity: 0, x: -12 }}
							animate={{ opacity: 1, x: 0 }}
							exit={{ opacity: 0, x: -12, transition: { duration: duration.fast, ease: "easeIn" } }}
							transition={{ x: spring.snappy, opacity: { duration: duration.base, ease: ease.outQuart } }}
							className="w-[140px] shrink-0 overflow-y-auto border-r border-border bg-panel py-1"
						>
							<AnimatePresence initial={false}>
								{files.map(file => {
									const kind = statusByPath.get(file.path)?.kind ?? (file.untracked ? "untracked" : file.kind);
									const active = file.path === selectedPath;
									return (
										<motion.li
											key={file.path}
											layout="position"
											{...listRowMotion}
										>
											<button
												type="button"
												title={display(file.path)}
												aria-current={active ? "true" : undefined}
												onClick={() => jumpTo(file.path)}
												className={cn(
													"relative flex h-7 w-full items-center gap-1.5 px-2 text-left text-sm",
													active ? "text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
													focusRingInset,
												)}
											>
												{active && (
													<motion.span aria-hidden layoutId={`${listId}-selected`} transition={spring.snappy} className="absolute inset-0 bg-selected" />
												)}
												<span className={cn("relative w-3 shrink-0 font-mono text-xs font-semibold", KIND_TONE[kind])} title={t(`diff.kind.${kind}`)}>
													{KIND_LETTER[kind]}
												</span>
												<span className="sr-only">{t(`diff.kind.${kind}`)}</span>
												<span className="relative min-w-0 flex-1 truncate">{baseName(file.path)}</span>
											</button>
										</motion.li>
									);
								})}
							</AnimatePresence>
						</motion.ul>
					)}
				</AnimatePresence>
				<div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
					{files.map(file => (
						<FileSection
							key={file.path}
							file={file}
							displayPath={display(file.path)}
							projectPath={projectPath}
							comments={comments}
							draft={draft}
							setDraft={setDraft}
							onDiscard={setDiscarding}
							register={(path, element) => {
								if (element) sections.current.set(path, element);
								else sections.current.delete(path);
							}}
						/>
					))}
				</div>
			</div>
			<Expand open={comments.length > 0} className="flex h-12 items-center gap-2 border-t border-border bg-panel px-3">
				<span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{t("diff.pending", { count: comments.length })}</span>
				<Button size="sm" variant="ghost" onClick={() => useComments.getState().clear(projectPath)}>
					{t("diff.clearComments")}
				</Button>
				<Button size="sm" variant="primary" icon={<PaperPlaneRight />} loading={busy} onClick={() => void sendComments()}>
					{t("diff.send", { count: comments.length })}
					<Kbd className="ml-1">{MOD_KEY}↵</Kbd>
				</Button>
			</Expand>
			<Dialog open={discarding !== null} onOpenChange={open => !open && setDiscarding(null)}>
				{discarding && (
					<DialogContent
						destructive
						size="sm"
						title={t("diff.discardTitle", { file: baseName(discarding.path) })}
						description={t(discarding.untracked || discarding.kind === "added" ? "diff.discardNewBody" : "diff.discardBody")}
						footer={
							<>
								<DialogClose asChild>
									<Button variant="ghost">{t("diff.keepChanges")}</Button>
								</DialogClose>
								<Button variant="danger" onClick={() => void confirmDiscard()}>
									{t("diff.discardConfirm")}
								</Button>
							</>
						}
					/>
				)}
			</Dialog>
		</div>
	);
	// The list stays the presence owner while its last file leaves: the old view fades out, then the empty state fades in.
	return (
		<PresenceSwap swapKey={files.length === 0 ? "empty" : "diff"} className="flex min-h-0 flex-1 flex-col">
			{files.length === 0 ? <EmptyState icon={<GitDiffIcon />} title={t("diff.emptyTitle")} body={t("diff.empty")} /> : view}
		</PresenceSwap>
	);
}

/** Tab badge: `+N −M` for the project's uncommitted changes. */
export function DiffBadge({ projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	const git = useGit(projectPath);
	const totals = git.status?.totals;
	if (!totals || totals.files === 0) return null;
	return (
		<span className="font-mono text-xs tabular-nums" aria-label={t("diff.badge", { add: totals.additions, del: totals.deletions })}>
			<span className="text-diff-add-text">+{totals.additions}</span> <span className="text-diff-del-text">−{totals.deletions}</span>
		</span>
	);
}
