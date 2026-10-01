/**
 * The chat composer (DESIGN §3.6): a floating card with the queued-messages tray, image attachments,
 * an auto-growing text box with `@file` mentions, and one bottom row of tools that ends in the action
 * slot (stop while omp works, send when there is something to send).
 *
 * Keys: Enter sends (queued while omp works), Shift+Enter adds a line, ⌘/Ctrl+Enter sends now (steers
 * the running turn), Esc stops omp when the box is empty. Typing `!` or `$` into an empty box switches
 * to the Shell / Python quick mode, like omp's own editor; Backspace in an empty box leaves it.
 */
import { ArrowUp, At, BookBookmark, Command, Cpu, GraduationCap, ImageSquare, Lock, Microphone, Paperclip, Plus, Square, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
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
import { PermissionSubmenu, ThinkingSubmenu, usePickerRequests } from "../../features/session-tools/pickers";
import { chatSlots } from "../../registry/slots";
import type { SessionController } from "../../state/session";
import {
	cn,
	duration,
	ease,
	Expand,
	IconButton,
	Kbd,
	Menu,
	MenuCheckboxItem,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	spring,
	toast,
	Tooltip,
} from "../../ui";
import { attachFiles, attachPaths, useThumbnail } from "./attach";
import { type Attachment, appendWithSpace, registerComposerEditor, takePendingFocus, useComposerDrafts } from "./drafts";
import { fuzzyFiles, mentionAtCaret, mentionRanges } from "./fuzzy";
import { MentionPicker, useProjectFiles } from "./MentionPicker";
import { type LibraryTab, PromptLibrary } from "./PromptLibrary";
import { applyMode, deliver } from "./send";
import { QueueTray } from "./QueueTray";
import { QUICK_MODES } from "./tools";
import { useVoiceRequests } from "./VoiceTool";

const MIN_HEIGHT = 24;
const MAX_HEIGHT = 200;
const EMPTY: readonly Attachment[] = [];
const IS_MAC = window.vomp.platform === "darwin";

/**
 * Bottom-row compaction tiers (DESIGN §3.6), in the order they apply: tier n sets the first n data
 * attributes on the card, and the row's tools (including feature slots) read them through
 * `group-data-<tier>/composer` variants. Tiers change only CSS, never the row's DOM, so measuring a
 * tier cannot trigger another measurement.
 */
const ROW_TIERS = [
	"data-compact-pill", // the permission button drops "runs without asking"
	"data-compact-modes", // Shell and Python show only their glyph
	"data-compact-thinking", // thinking shows only its icon
	"data-fold-modes", // Shell and Python move into the ＋ menu
	"data-fold-tools", // permission and the idle mic move into the ＋ menu
	"data-fold-thinking", // thinking moves into the ＋ menu
	"data-compact-model", // the model button shows only its icon
	"data-tight", // narrower gaps and padding; the context ring drops its label
	"data-fold-ring", // the context ring leaves the row (the status bar still shows usage)
	"data-fold-model", // the model button moves into the ＋ menu; its picker opens at the row's end
] as const;

/**
 * The tools fit when every tool's layout box ends inside the strip's content box and no `data-row-label`
 * is squeezed below its control's own max width. Layout boxes (offset*) ignore transforms, so the mic's
 * ping ring and press feedback never count as overflow the way they would in `scrollWidth`.
 */
function toolsFit(tools: HTMLElement): boolean {
	// offset* values are whole pixels; the 1px allowance stays inside the strip's padding, so nothing is clipped.
	const end = tools.offsetLeft + tools.clientWidth - Number.parseFloat(getComputedStyle(tools).paddingRight) + 1;
	for (const tool of tools.children) {
		if (tool instanceof HTMLElement && tool.offsetParent && tool.offsetLeft + tool.offsetWidth > end) return false;
	}
	for (const label of tools.querySelectorAll<HTMLElement>("[data-row-label]")) {
		if (label.scrollWidth <= label.clientWidth) continue;
		const control = label.closest("button") ?? label;
		// A label cut at its control's max width is by design; a narrower control means the row is short of room.
		if (!(control.offsetWidth >= Number.parseFloat(getComputedStyle(control).maxWidth) - 1)) return false;
	}
	return true;
}

/**
 * Applies the lowest tier at which the tools fit, measuring synchronously so no frame shows a crowded
 * row. It settles from tier 0 again when the row's content changes (DOM mutations in the tools, the
 * action slot's size, which also follows the text size, and font loads). When the card narrows it only
 * climbs; when it widens it retries a lower tier once the card is wider than where that tier last
 * failed, so the tier cannot oscillate. Returns the tier so the ＋ menu can offer what was folded away.
 */
function useRowTier(card: HTMLElement | null, tools: HTMLElement | null, actions: HTMLElement | null): number {
	const [tier, setTier] = useState(0);
	useLayoutEffect(() => {
		if (!card || !tools || !actions) return;
		/** Card width at which each tier last failed to fit. */
		let failedAt: number[] = [];
		let current = 0;
		let width = card.offsetWidth;
		const settle = (from: number) => {
			let next = from;
			for (;;) {
				ROW_TIERS.forEach((attr, index) => card.toggleAttribute(attr, index < next));
				if (next === ROW_TIERS.length || toolsFit(tools)) break;
				failedAt[next] = width;
				next++;
			}
			current = next;
			setTier(next);
		};
		const restart = () => {
			failedAt = [];
			settle(0);
		};
		restart();
		const resize = new ResizeObserver(entries => {
			if (entries.some(entry => entry.target === actions)) return restart();
			const next = card.offsetWidth;
			if (next === width) return;
			const grew = next > width;
			width = next;
			let from = current;
			while (grew && from > 0 && width > (failedAt[from - 1] ?? 0)) from--;
			settle(from);
		});
		resize.observe(card);
		resize.observe(actions);
		const mutations = new MutationObserver(restart);
		mutations.observe(tools, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
		document.fonts.addEventListener("loadingdone", restart);
		return () => {
			resize.disconnect();
			mutations.disconnect();
			document.fonts.removeEventListener("loadingdone", restart);
		};
	}, [card, tools, actions]);
	return tier;
}

/** Textarea and its highlight mirror must lay text out identically. */
const textLayout =
	"col-start-1 row-start-1 w-full whitespace-pre-wrap break-words px-0 py-0.5 text-base leading-[22px] [scrollbar-gutter:stable] [overflow-wrap:anywhere]";

function MentionMirror({ text }: { text: string }) {
	const parts: ReactNode[] = [];
	let at = 0;
	for (const { start, end } of mentionRanges(text)) {
		if (start > at) parts.push(text.slice(at, start));
		parts.push(
			<span key={start} className="rounded-[4px] bg-accent-muted text-accent shadow-[0_0_0_2px_var(--accent-muted)]">
				{text.slice(start, end)}
			</span>,
		);
		at = end;
	}
	parts.push(text.slice(at));
	// Trailing newline needs a visible character to keep the mirror's height in step with the textarea.
	return <>{parts}{text.endsWith("\n") ? " " : null}</>;
}

/** Sits directly under a popLayout AnimatePresence, which measures a leaving chip through this ref. */
function AttachmentChip({ item, onRemove, ref }: { item: Attachment; onRemove(): void; ref?: Ref<HTMLLIElement> }) {
	const { t } = useTranslation("composer");
	const thumb = useThumbnail(item.path);
	return (
		<motion.li
			ref={ref}
			layout="position"
			initial={{ opacity: 0, scale: 0.92 }}
			animate={{ opacity: 1, scale: 1 }}
			exit={{ opacity: 0, scale: 0.92, transition: { duration: duration.fast, ease: "easeIn" } }}
			transition={{ layout: spring.gentle, scale: spring.snappy, opacity: { duration: duration.base, ease: ease.outQuart } }}
			className="group relative flex h-10 max-w-56 items-center gap-2 rounded-md border border-border bg-inset py-1 pr-1 pl-1"
		>
			{thumb ? (
				<img src={thumb} alt="" className="size-8 shrink-0 rounded-sm object-cover" />
			) : (
				<span className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm bg-hover text-fg-faint">
					<ImageSquare className="size-4" aria-hidden />
				</span>
			)}
			<span className="min-w-0 truncate text-sm text-fg" title={item.path}>
				{item.name}
			</span>
			<IconButton size="sm" label={t("attach.remove", { name: item.name })} icon={<X />} onClick={onRemove} />
		</motion.li>
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
	// The chip row stays open while the last chips leave, then collapses (see AnimatePresence onExitComplete below).
	const [chipsHeld, setChipsHeld] = useState(attachments.length > 0);
	if (attachments.length > 0 && !chipsHeld) setChipsHeld(true);

	const [root, setRoot] = useState<HTMLDivElement | null>(null);
	const [card, setCard] = useState<HTMLDivElement | null>(null);
	const [toolRow, setToolRow] = useState<HTMLDivElement | null>(null);
	const [actions, setActions] = useState<HTMLDivElement | null>(null);
	const tier = useRowTier(card, toolRow, actions);
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
	const foldModes = tier > ROW_TIERS.indexOf("data-fold-modes");
	const foldTools = tier > ROW_TIERS.indexOf("data-fold-tools");
	const foldThinking = tier > ROW_TIERS.indexOf("data-fold-thinking");
	const foldModel = tier > ROW_TIERS.indexOf("data-fold-model");

	return (
		<div ref={setRoot} className="relative mx-auto w-full max-w-[760px]">
			{dropColumn &&
				createPortal(
					<div aria-hidden className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-2">
						<motion.div
							initial={{ opacity: 0, scale: 0.98 }}
							animate={{ opacity: 1, scale: 1 }}
							transition={{ scale: spring.snappy, opacity: { duration: duration.fast, ease: ease.outQuart } }}
							className="flex size-full flex-col items-center justify-center gap-2 rounded-xl bg-accent-muted outline-2 -outline-offset-8 outline-accent"
						>
							<Paperclip className="size-6 text-accent" />
							<p className="text-base font-semibold text-accent">{t("attach.drop")}</p>
							<p className="text-sm text-fg-muted">{t("attach.dropHint")}</p>
						</motion.div>
					</div>,
					dropColumn,
				)}
			<div
				ref={setCard}
				className={cn(
					"group/composer @container/composer rounded-xl border border-border-strong bg-panel shadow-(--shadow-composer)",
					readOnly && "bg-inset",
				)}
			>
				<QueueTray session={session} queue={view.queue} questionId={questionId} />
				<Expand open={chipsHeld}>
					<ul aria-label={t("attach.label")} className="relative flex flex-wrap gap-1.5 px-3 pt-3">
						<AnimatePresence
							initial={false}
							mode="popLayout"
							onExitComplete={() => {
								if ((useComposerDrafts.getState().attachments[tabId] ?? EMPTY).length === 0) setChipsHeld(false);
							}}
						>
							{attachments.map(item => (
								<AttachmentChip
									key={item.path}
									item={item}
									onRemove={() => useComposerDrafts.getState().removeAttachment(tabId, item.path)}
								/>
							))}
						</AnimatePresence>
					</ul>
				</Expand>
				<Expand open={readOnly}>
					<p className="flex items-start gap-2 px-4 pt-3 text-sm text-fg-muted">
						<Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
						{t("readOnly")}
					</p>
				</Expand>
				<div className="relative px-4 pt-3 pb-1">
					{mention && (
						<MentionPicker id={pickerId} matches={matches} active={activeMatch} onActive={setActiveMatch} onPick={pickMention} />
					)}
					<div className="flex items-start gap-2">
						<AnimatePresence initial={false}>
							{mode && (
								<motion.span
									key="mode"
									initial={{ opacity: 0, scale: 0.8 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{ opacity: 0, scale: 0.8, transition: { duration: duration.fast, ease: "easeIn" } }}
									transition={spring.snappy}
									className="inline-flex shrink-0"
								>
									<Tooltip content={t(`modes.${mode}.tip`)}>
										<button
											type="button"
											onClick={() => {
												useComposerDrafts.getState().setMode(tabId, null);
												textarea.current?.focus();
											}}
											aria-label={t("modes.exit", { mode: t(`modes.${mode}.label`) })}
											className="mt-0.5 inline-flex h-[22px] shrink-0 items-center rounded-sm bg-selected px-1.5 font-mono text-sm font-semibold text-fg outline-none focus-visible:outline-2 focus-visible:outline-ring"
										>
											{mode === "shell" ? "!" : "$"}
										</button>
									</Tooltip>
								</motion.span>
							)}
						</AnimatePresence>
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
							<span
								title={t("send.nowTip")}
								className="mt-0.5 flex h-[22px] shrink-0 items-center gap-1.5 text-xs text-fg-faint @max-[30rem]/composer:hidden"
							>
								<Kbd>{`${mod}↵`}</Kbd>
								{working && <span>{t("send.nowShort")}</span>}
							</span>
						)}
					</div>
				</div>
				<div className="relative flex h-10 items-center gap-1 px-2 pb-1.5 group-data-tight/composer:gap-0.5 group-data-tight/composer:px-1.5">
					<Menu>
						<Tooltip content={t("plus.tip")}>
							<MenuTrigger asChild disabled={readOnly}>
								<button
									type="button"
									aria-label={t("plus.label")}
									className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 data-[state=open]:bg-selected"
								>
									<Plus className="size-4" aria-hidden />
								</button>
							</MenuTrigger>
						</Tooltip>
						<MenuContent side="top" align="start" onCloseAutoFocus={event => event.preventDefault()}>
							<MenuItem icon={<Paperclip />} onSelect={() => void pickFiles()}>
								{t("plus.attach")}
							</MenuItem>
							<MenuItem icon={<At />} onSelect={() => requestAnimationFrame(startMention)}>
								{t("plus.mention")}
							</MenuItem>
							{foldTools && (
								<MenuItem icon={<Microphone />} onSelect={() => useVoiceRequests.getState().requestStart(tabId)}>
									{t("voice.start")}
								</MenuItem>
							)}
							{foldModes && (
								<>
									<MenuSeparator />
									{QUICK_MODES.map(({ mode: quick, glyph }) => (
										<MenuCheckboxItem
											key={quick}
											checked={mode === quick}
											shortcut={glyph}
											onSelect={() => {
												useComposerDrafts.getState().setMode(tabId, mode === quick ? null : quick);
												requestAnimationFrame(() => textarea.current?.focus());
											}}
										>
											{t(`modes.${quick}.label`)}
										</MenuCheckboxItem>
									))}
								</>
							)}
							{(foldTools || foldThinking || foldModel) && <MenuSeparator />}
							{foldTools && <PermissionSubmenu session={session} />}
							{foldModel && (
								<MenuItem
									icon={<Cpu />}
									shortcut="⌘⇧M"
									onSelect={() => requestAnimationFrame(() => usePickerRequests.getState().openModel(tabId))}
								>
									{t("plus.model")}
								</MenuItem>
							)}
							{foldThinking && <ThinkingSubmenu session={session} />}
							<MenuSeparator />
							<MenuItem icon={<BookBookmark />} onSelect={() => setLibrary("saved")}>
								{t("plus.library")}
							</MenuItem>
							<MenuItem icon={<GraduationCap />} onSelect={() => setLibrary("skills")}>
								{t("plus.skills")}
							</MenuItem>
							<MenuItem icon={<Command />} onSelect={() => setLibrary("commands")}>
								{t("plus.commands")}
							</MenuItem>
						</MenuContent>
					</Menu>
					{/*
					 * Every tool, including feature slots, in one strip that can only clip sideways, so the ＋ button and
					 * the action slot always keep their room. Its 4px padding (cancelled by the margin) keeps focus rings
					 * inside the clip. useRowTier makes sure nothing is clipped short of the last tier.
					 */}
					<div
						ref={setToolRow}
						className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-clip px-1 group-data-tight/composer:-mx-0.5 group-data-tight/composer:gap-0.5 group-data-tight/composer:px-0.5"
					>
						{leftTools.map(slot => (
							<slot.component key={slot.id} session={session} />
						))}
						{/* The spacer's negative margin cancels one gap, so it costs nothing when the row is full. */}
						<div className="-ml-1 flex-1 group-data-tight/composer:-ml-0.5" />
						{rightTools.map(slot => (
							<slot.component key={slot.id} session={session} />
						))}
					</div>
					<div ref={setActions} className="relative ml-1 flex shrink-0 items-center gap-1 group-data-tight/composer:ml-0.5">
						<AnimatePresence initial={false} mode="popLayout">
							{working && (
								<motion.span
									key="stop"
									layout="position"
									initial={{ opacity: 0, scale: 0.9 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{ opacity: 0, scale: 0.9, transition: { duration: duration.fast, ease: "easeIn" } }}
									transition={spring.snappy}
									className="inline-flex"
								>
									<Tooltip content={t("send.stop")} shortcut="Esc">
										<button
											type="button"
											aria-label={t("send.stop")}
											onClick={() => session.abort()}
											className="inline-flex size-8 items-center justify-center rounded-md bg-err-bg text-err outline-none transition-[background-color,color,scale] duration-(--dur-fast) hover:bg-err hover:text-fg-inverse active:scale-[0.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
										>
											<Square weight="fill" className="size-3.5" aria-hidden />
										</button>
									</Tooltip>
								</motion.span>
							)}
							{(!working || canSend) && (
								<motion.span
									key="send"
									layout="position"
									initial={{ opacity: 0, scale: 0.9 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{ opacity: 0, scale: 0.9, transition: { duration: duration.fast, ease: "easeIn" } }}
									transition={spring.snappy}
									className="inline-flex"
								>
									<Tooltip content={working ? t("send.queueTip") : t("send.tip")} shortcut="↵">
										<button
											type="button"
											aria-label={working ? t("send.queue") : t("send.label")}
											disabled={!canSend}
											onClick={() => submit(false)}
											className="inline-flex size-8 items-center justify-center rounded-md bg-accent text-accent-fg shadow-(--shadow-primary) outline-none transition-[background-color,scale,opacity] duration-(--dur-fast) enabled:hover:bg-accent-hover enabled:active:scale-[0.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45"
										>
											<ArrowUp className="size-4" aria-hidden />
										</button>
									</Tooltip>
								</motion.span>
							)}
						</AnimatePresence>
					</div>
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
