/**
 * The chat composer (DESIGN §3.6): a floating card with the queued-messages tray, image attachments,
 * an auto-growing text box with `@file` mentions, and one bottom row of tools.
 *
 * Keys: Enter sends (queued while omp works), Shift+Enter adds a line, ⌘/Ctrl+Enter sends now (steers
 * the running turn), Esc stops omp when the box is empty. Typing `!` or `$` into an empty box switches
 * to the Shell / Python quick mode, like omp's own editor; Backspace in an empty box leaves it.
 */
import { ArrowUp, AtSign, BookMarked, ImagePlus, Lock, Paperclip, Plus, Sparkles, Square, SquareSlash, X } from "lucide-react";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { chatSlots } from "../../registry/slots";
import type { SessionController } from "../../state/session";
import { Button, cn, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, toast, Tooltip } from "../../ui";
import { attachFiles, attachPaths, useThumbnail } from "./attach";
import { type Attachment, appendWithSpace, registerComposerEditor, takePendingFocus, useComposerDrafts } from "./drafts";
import { fuzzyFiles, mentionAtCaret, mentionRanges } from "./fuzzy";
import { MentionPicker, useProjectFiles } from "./MentionPicker";
import { type LibraryTab, PromptLibrary } from "./PromptLibrary";
import { applyMode, deliver } from "./send";
import { QueueTray } from "./QueueTray";
import "./tools";

const MIN_HEIGHT = 24;
const MAX_HEIGHT = 200;
const EMPTY: readonly Attachment[] = [];
const IS_MAC = window.vomp.platform === "darwin";

/** Textarea and its highlight mirror must lay text out identically. */
const textLayout =
	"col-start-1 row-start-1 w-full whitespace-pre-wrap break-words px-0 py-0.5 text-base leading-[22px] [scrollbar-gutter:stable] [overflow-wrap:anywhere]";

function MentionMirror({ text }: { text: string }) {
	const parts: ReactNode[] = [];
	let at = 0;
	for (const { start, end } of mentionRanges(text)) {
		if (start > at) parts.push(text.slice(at, start));
		parts.push(
			<span key={start} className="rounded-[4px] bg-accent-2-muted text-accent-2 shadow-[0_0_0_2px_var(--accent-2-muted)]">
				{text.slice(start, end)}
			</span>,
		);
		at = end;
	}
	parts.push(text.slice(at));
	// Trailing newline needs a visible character to keep the mirror's height in step with the textarea.
	return <>{parts}{text.endsWith("\n") ? " " : null}</>;
}

function AttachmentChip({ item, onRemove }: { item: Attachment; onRemove(): void }) {
	const { t } = useTranslation("composer");
	const thumb = useThumbnail(item.path);
	return (
		<li className="group relative flex h-10 max-w-56 items-center gap-2 rounded-md border border-border bg-inset py-1 pr-1 pl-1">
			{thumb ? (
				<img src={thumb} alt="" className="size-8 shrink-0 rounded-sm object-cover" />
			) : (
				<span className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm bg-hover text-fg-faint">
					<ImagePlus className="size-4" aria-hidden />
				</span>
			)}
			<span className="min-w-0 truncate text-sm text-fg" title={item.path}>
				{item.name}
			</span>
			<IconButton size="sm" label={t("attach.remove", { name: item.name })} icon={<X />} onClick={onRemove} />
		</li>
	);
}

/** Full-column drop target (DESIGN §3.6), attached to the chat column around the composer. */
function useDropVeil(root: HTMLElement | null, onFiles: (files: File[]) => void): HTMLElement | null {
	const [column, setColumn] = useState<HTMLElement | null>(null);
	const [active, setActive] = useState(false);
	const onFilesRef = useRef(onFiles);
	onFilesRef.current = onFiles;
	useEffect(() => {
		const target = root?.closest<HTMLElement>("[data-chat-column]") ?? root?.parentElement ?? null;
		if (!target) return;
		let depth = 0;
		const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
		const enter = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth++;
			setActive(true);
		};
		const over = (event: DragEvent) => {
			if (!hasFiles(event) || !event.dataTransfer) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
		};
		const leave = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) setActive(false);
		};
		const drop = (event: DragEvent) => {
			if (!hasFiles(event) || !event.dataTransfer) return;
			event.preventDefault();
			depth = 0;
			setActive(false);
			onFilesRef.current([...event.dataTransfer.files]);
		};
		target.addEventListener("dragenter", enter);
		target.addEventListener("dragover", over);
		target.addEventListener("dragleave", leave);
		target.addEventListener("drop", drop);
		setColumn(target);
		return () => {
			target.removeEventListener("dragenter", enter);
			target.removeEventListener("dragover", over);
			target.removeEventListener("dragleave", leave);
			target.removeEventListener("drop", drop);
		};
	}, [root]);
	return active ? column : null;
}

export function Composer({ session }: { session: SessionController }): ReactNode {
	const { t } = useTranslation("composer");
	const tabId = session.tabId;
	const projectPath = session.projectPath;
	const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
	const draft = useComposerDrafts(state => state.drafts[tabId] ?? "");
	const attachments = useComposerDrafts(state => state.attachments[tabId] ?? EMPTY);
	const mode = useComposerDrafts(state => state.modes[tabId] ?? null);
	const tools = chatSlots.use().filter(slot => slot.placement === "composerTools");

	const [root, setRoot] = useState<HTMLDivElement | null>(null);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const mirror = useRef<HTMLDivElement>(null);
	const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
	const [activeMatch, setActiveMatch] = useState(0);
	const [library, setLibrary] = useState<LibraryTab | null>(null);
	const pickerId = useId();

	const readOnly = view.readOnly;
	const working = view.working;
	const files = useProjectFiles(projectPath, mention !== null);
	const matches = useMemo(() => (mention && files ? fuzzyFiles(files, mention.query, 40) : null), [mention, files]);

	const setDraft = useCallback((text: string) => useComposerDrafts.getState().setDraft(tabId, text), [tabId]);

	const refreshMention = useCallback((text: string, caret: number) => {
		const next = mentionAtCaret(text, caret);
		setMention(current => (current?.start === next?.start && current?.query === next?.query ? current : next));
		setActiveMatch(0);
	}, []);

	/** Replace `[from, to)` of the draft and place the caret after the inserted text. */
	const replaceRange = useCallback(
		(from: number, to: number, text: string) => {
			const current = useComposerDrafts.getState().drafts[tabId] ?? "";
			const next = current.slice(0, from) + text + current.slice(to);
			setDraft(next);
			const caret = from + text.length;
			requestAnimationFrame(() => {
				const el = textarea.current;
				if (!el) return;
				el.focus();
				el.setSelectionRange(caret, caret);
				refreshMention(next, caret);
			});
		},
		[tabId, setDraft, refreshMention],
	);

	// Other features insert text (mentions, prompts) through the draft store.
	useEffect(
		() =>
			registerComposerEditor(tabId, {
				insertAtCaret(text) {
					const el = textarea.current;
					const current = useComposerDrafts.getState().drafts[tabId] ?? "";
					const start = el ? el.selectionStart : current.length;
					const end = el ? el.selectionEnd : current.length;
					const before = current.slice(0, start);
					const joined = appendWithSpace(before, text);
					replaceRange(0, end, joined);
				},
				focus() {
					textarea.current?.focus();
				},
			}),
		[tabId, replaceRange],
	);

	useEffect(() => {
		if (takePendingFocus(tabId)) textarea.current?.focus();
	}, [tabId]);

	// Auto-grow 24 → 200px.
	useLayoutEffect(() => {
		const el = textarea.current;
		if (!el) return;
		el.style.height = "0px";
		const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight));
		el.style.height = `${height}px`;
		if (mirror.current) {
			mirror.current.style.height = `${height}px`;
			mirror.current.scrollTop = el.scrollTop;
		}
	}, [draft]);

	const dropColumn = useDropVeil(root, dropped => {
		if (readOnly) return;
		void attachFiles(tabId, projectPath, dropped).catch((error: unknown) =>
			toast({ tone: "err", message: t("attach.failed"), description: String(error) }),
		);
	});

	const submit = (now: boolean) => {
		if (readOnly) return;
		const text = applyMode(draft, mode);
		const images = [...attachments];
		if (!text && images.length === 0) return;
		const store = useComposerDrafts.getState();
		store.setDraft(tabId, "");
		store.clearAttachments(tabId);
		store.setMode(tabId, null);
		setMention(null);
		deliver(session, text, images, now).catch((error: unknown) => {
			// Put the message back so nothing typed is lost.
			const restore = useComposerDrafts.getState();
			if (!(restore.drafts[tabId] ?? "")) restore.setDraft(tabId, draft);
			restore.addAttachments(tabId, images);
			restore.setMode(tabId, mode);
			toast({ tone: "err", message: t("send.failed"), description: error instanceof Error ? error.message : String(error) });
		});
	};

	const pickMention = (path: string) => {
		if (!mention) return;
		const el = textarea.current;
		const caret = el ? el.selectionStart : mention.start + mention.query.length + 1;
		setMention(null);
		replaceRange(mention.start, caret, `@${path} `);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (mention && matches && matches.length > 0) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const delta = event.key === "ArrowDown" ? 1 : -1;
				setActiveMatch(index => (index + delta + matches.length) % matches.length);
				return;
			}
			if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
				const match = matches[activeMatch];
				if (match) {
					event.preventDefault();
					pickMention(match.path);
					return;
				}
			}
		}
		if (event.key === "Escape") {
			if (mention) {
				event.preventDefault();
				event.stopPropagation();
				setMention(null);
			} else if (working && !draft) {
				event.preventDefault();
				session.abort();
			}
			return;
		}
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit(true);
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit(false);
			return;
		}
		if (!draft && !mode && (event.key === "!" || event.key === "$") && !event.metaKey && !event.ctrlKey) {
			event.preventDefault();
			useComposerDrafts.getState().setMode(tabId, event.key === "!" ? "shell" : "python");
			return;
		}
		if (!draft && mode && event.key === "Backspace") {
			event.preventDefault();
			useComposerDrafts.getState().setMode(tabId, null);
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const pasted = [...event.clipboardData.files];
		if (pasted.length === 0) return;
		event.preventDefault();
		void attachFiles(tabId, projectPath, pasted)
			.then(count => {
				if (count === 0) toast({ tone: "warn", message: t("attach.unsupported") });
			})
			.catch((error: unknown) => toast({ tone: "err", message: t("attach.failed"), description: String(error) }));
	};

	const pickFiles = async () => {
		const paths = await window.vomp.invoke("composer:pickFiles", projectPath);
		if (paths.length > 0) attachPaths(tabId, projectPath, paths);
	};

	const startMention = () => {
		const el = textarea.current;
		const current = useComposerDrafts.getState().drafts[tabId] ?? "";
		const start = el ? el.selectionStart : current.length;
		const end = el ? el.selectionEnd : current.length;
		const needsSpace = start > 0 && !/\s/.test(current[start - 1] ?? "");
		replaceRange(start, end, needsSpace ? " @" : "@");
	};

	const placeholder = readOnly
		? t("placeholder.readOnly")
		: mode
			? t(`placeholder.${mode}`)
			: working
				? t("placeholder.working")
				: t("placeholder.idle");
	const canSend = !readOnly && (draft.trim().length > 0 || attachments.length > 0);
	const mod = IS_MAC ? "⌘" : "Ctrl+";
	const questionId = view.guest?.uiRequest?.reqId ?? null;
	const leftTools = tools.filter(slot => slot.order < 50);
	const rightTools = tools.filter(slot => slot.order >= 50);

	return (
		<div ref={setRoot} className="relative mx-auto w-full max-w-[760px]">
			{dropColumn &&
				createPortal(
					<div
						aria-hidden
						className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-2"
					>
						<div className="flex size-full flex-col items-center justify-center gap-2 rounded-xl bg-accent-muted/60 outline-2 -outline-offset-8 outline-accent">
							<Paperclip className="size-6 text-accent" />
							<p className="text-base font-semibold text-accent">{t("attach.drop")}</p>
							<p className="text-sm text-fg-muted">{t("attach.dropHint")}</p>
						</div>
					</div>,
					dropColumn,
				)}
			<div
				data-active={working ? "" : undefined}
				className={cn(
					"vo-glow rounded-xl border border-border-strong bg-panel shadow-(--shadow-composer)",
					readOnly && "bg-inset",
				)}
			>
				<QueueTray session={session} queue={view.queue} questionId={questionId} />
				{attachments.length > 0 && (
					<ul aria-label={t("attach.label")} className="flex flex-wrap gap-1.5 px-3 pt-3">
						{attachments.map(item => (
							<AttachmentChip
								key={item.path}
								item={item}
								onRemove={() => useComposerDrafts.getState().removeAttachment(tabId, item.path)}
							/>
						))}
					</ul>
				)}
				{readOnly && (
					<p className="flex items-start gap-2 px-4 pt-3 text-sm text-fg-muted">
						<Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
						{t("readOnly")}
					</p>
				)}
				<div className="relative px-4 pt-3 pb-1">
					{mention && (
						<MentionPicker id={pickerId} matches={matches} active={activeMatch} onActive={setActiveMatch} onPick={pickMention} />
					)}
					<div className="flex items-start gap-2">
						{mode && (
							<Tooltip content={t(`modes.${mode}.tip`)}>
								<button
									type="button"
									onClick={() => {
										useComposerDrafts.getState().setMode(tabId, null);
										textarea.current?.focus();
									}}
									aria-label={t("modes.exit", { mode: t(`modes.${mode}.label`) })}
									className="mt-0.5 inline-flex h-[22px] shrink-0 items-center rounded-sm bg-accent-2-muted px-1.5 font-mono text-sm font-semibold text-accent-2 outline-none focus-visible:outline-2 focus-visible:outline-ring"
								>
									{mode === "shell" ? "!" : "$"}
								</button>
							</Tooltip>
						)}
						<div className="grid min-w-0 flex-1">
							<div
								ref={mirror}
								aria-hidden
								className={cn(textLayout, "pointer-events-none overflow-hidden text-fg", mode && "font-mono text-code")}
							>
								<MentionMirror text={draft} />
							</div>
							<textarea
								ref={textarea}
								value={draft}
								disabled={readOnly}
								rows={1}
								spellCheck={!mode}
								placeholder={placeholder}
								aria-label={t("label")}
								role="combobox"
								aria-expanded={mention !== null}
								aria-controls={mention ? pickerId : undefined}
								aria-autocomplete="list"
								aria-activedescendant={mention && matches?.length ? `${pickerId}-${activeMatch}` : undefined}
								onChange={event => {
									setDraft(event.target.value);
									refreshMention(event.target.value, event.target.selectionStart);
								}}
								onSelect={event => refreshMention(event.currentTarget.value, event.currentTarget.selectionStart)}
								onBlur={() => setMention(null)}
								onScroll={event => {
									if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop;
								}}
								onKeyDown={onKeyDown}
								onPaste={onPaste}
								className={cn(
									textLayout,
									"resize-none overflow-y-auto bg-transparent text-transparent caret-fg outline-none placeholder:text-fg-faint selection:bg-accent/25 disabled:cursor-not-allowed",
									mode && "font-mono text-code",
								)}
							/>
						</div>
						{!readOnly && (
							<kbd className="mt-0.5 hidden shrink-0 font-mono text-xs leading-[22px] text-fg-faint sm:block" title={t("send.nowTip")}>
								{working ? `${mod}↵ ${t("send.nowShort")}` : `${mod}↵`}
							</kbd>
						)}
					</div>
				</div>
				<div className="flex h-10 items-center gap-1 px-2 pb-1.5">
					<Menu>
						<Tooltip content={t("plus.tip")}>
							<MenuTrigger asChild disabled={readOnly}>
								<button
									type="button"
									aria-label={t("plus.label")}
									className="inline-flex size-7 items-center justify-center rounded-md text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 data-[state=open]:bg-selected"
								>
									<Plus className="size-4" aria-hidden />
								</button>
							</MenuTrigger>
						</Tooltip>
						<MenuContent side="top" align="start" onCloseAutoFocus={event => event.preventDefault()}>
							<MenuItem icon={<Paperclip />} onSelect={() => void pickFiles()}>
								{t("plus.attach")}
							</MenuItem>
							<MenuItem icon={<AtSign />} onSelect={() => requestAnimationFrame(startMention)}>
								{t("plus.mention")}
							</MenuItem>
							<MenuSeparator />
							<MenuItem icon={<BookMarked />} onSelect={() => setLibrary("saved")}>
								{t("plus.library")}
							</MenuItem>
							<MenuItem icon={<Sparkles />} onSelect={() => setLibrary("skills")}>
								{t("plus.skills")}
							</MenuItem>
							<MenuItem icon={<SquareSlash />} onSelect={() => setLibrary("commands")}>
								{t("plus.commands")}
							</MenuItem>
						</MenuContent>
					</Menu>
					{leftTools.map(slot => (
						<slot.component key={slot.id} session={session} />
					))}
					<div className="flex-1" />
					{rightTools.map(slot => (
						<slot.component key={slot.id} session={session} />
					))}
					{working && (
						<Button
							size="sm"
							variant="danger-ghost"
							icon={<Square className="fill-current" />}
							title={t("send.stopTip")}
							onClick={() => session.abort()}
						>
							{t("send.stop")}
						</Button>
					)}
					{(!working || canSend) && (
						<Tooltip content={working ? t("send.queueTip") : t("send.tip")} shortcut="↵">
							<button
								type="button"
								aria-label={working ? t("send.queue") : t("send.label")}
								disabled={!canSend}
								onClick={() => submit(false)}
								className="ml-1 inline-flex size-8 items-center justify-center rounded-md bg-accent text-accent-fg shadow-(--shadow-primary) outline-none transition-[background-color,translate] duration-(--dur-fast) enabled:hover:-translate-y-px enabled:hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45"
							>
								<ArrowUp className="size-4" aria-hidden />
							</button>
						</Tooltip>
					)}
				</div>
			</div>
			<PromptLibrary
				open={library !== null}
				tab={library ?? "saved"}
				projectPath={projectPath}
				draft={draft}
				onTabChange={setLibrary}
				onClose={() => {
					setLibrary(null);
					requestAnimationFrame(() => textarea.current?.focus());
				}}
				onPick={(text, replace) => {
					if (replace) replaceRange(0, draft.length, text);
					else useComposerDrafts.getState().insert(tabId, text);
				}}
			/>
		</div>
	);
}
