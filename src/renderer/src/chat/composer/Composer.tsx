/**
 * The chat composer (DESIGN §3.6): the queued-messages tray sits on top of a card that holds image
 * attachments, ＋ (files, prompts, Shell and Python mode, dictation), an auto-growing text box with
 * `@file` mentions, the mic and the action buttons (stop while omp works; send, or "Send now" plus
 * "Queue message" while omp works). The settings for the chat sit in a quiet row under the card: the
 * folder chip and the permission button on the left, the model and thinking buttons and the context
 * ring on the right (every `composerTools` slot; order below 50 goes left). Both the card's line and
 * the row wrap when the column is narrow; nothing measures them.
 *
 * Keys: Enter sends (queued while omp works), Shift+Enter adds a line, ⌘/Ctrl+Enter sends now (steers
 * the running turn), Esc stops omp when the box is empty. Typing `!` or `$` into an empty box switches
 * to the Shell / Python quick mode, like omp's own editor; Backspace in an empty box leaves it.
 */
import { ArrowUp, At, BookBookmark, Command, GraduationCap, ImageSquare, Microphone, PaperPlaneRight, Paperclip, Plus, Square, X } from "@phosphor-icons/react";
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
import { routeSlash } from "../../features/session-tools/slash";
import { sendSlashCommand } from "../../features/session-tools/typed";
import { chatSlots } from "../../registry/slots";
import type { SessionController } from "../../state/session";
import { useApp } from "../../state/app";
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
import { type SlashContext, type SlashItem, SlashMenu, slashAtCaret, slashOptions, useSlashCommands } from "./SlashMenu";
import { QUICK_MODES } from "./tools";
import { useVoiceRequests, VoiceTool } from "./VoiceTool";

const MIN_HEIGHT = 24;
const MAX_HEIGHT = 200;
const EMPTY: readonly Attachment[] = [];
const IS_MAC = window.vomp.platform === "darwin";

/**
 * Motion for the action buttons as they appear and leave. Their layout animates only when the set of
 * buttons changes (`layoutDependency` = `actionSet`): a resize of the composer, such as the side panel
 * opening, must move them instantly instead of sliding them across the window.
 */
const actionMotion = {
	layout: "position",
	initial: { opacity: 0, scale: 0.9 },
	animate: { opacity: 1, scale: 1 },
	exit: { opacity: 0, scale: 0.9, transition: { duration: duration.fast, ease: "easeIn" } },
	transition: spring.snappy,
	className: "inline-flex",
} as const;

/** Textarea and its highlight mirror must lay text out identically. */
const textLayout =
	"col-start-1 row-start-1 w-full whitespace-pre-wrap break-words px-0 py-0.5 text-base leading-(--text-base--line-height) [scrollbar-gutter:stable] [overflow-wrap:anywhere]";

function MentionMirror({ text }: { text: string }) {
	const parts: ReactNode[] = [];
	let at = 0;
	for (const { start, end } of mentionRanges(text)) {
		if (start > at) parts.push(text.slice(at, start));
		parts.push(
			<span key={start} className="rounded-sm bg-accent-muted text-accent shadow-[0_0_0_2px_var(--accent-muted)]">
				{text.slice(start, end)}
			</span>,
		);
		at = end;
	}
	parts.push(text.slice(at));
	// Trailing newline needs a visible character to keep the mirror's height in step with the textarea.
	return <>{parts}{text.endsWith("\n") ? " " : null}</>;
}

/** An image waiting to go with the message. Sits directly under a popLayout AnimatePresence, which measures a leaving chip through this ref. */
export function AttachmentChip({ item, onRemove, ref }: { item: Attachment; onRemove(): void; ref?: Ref<HTMLLIElement> }) {
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
	const textarea = useRef<HTMLTextAreaElement>(null);
	const mirror = useRef<HTMLDivElement>(null);
	const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
	const [activeMatch, setActiveMatch] = useState(0);
	const [library, setLibrary] = useState<LibraryTab | null>(null);
	const pickerId = useId();
	const [slash, setSlash] = useState<SlashContext | null>(null);
	const [slashActive, setSlashActive] = useState(0);
	// Whether the arrows moved the slash selection since the menu last changed (see Enter below).
	const [slashMoved, setSlashMoved] = useState(false);
	// Esc closes the slash menu until the text changes again (DESIGN §3.6), by typing or otherwise.
	const [slashClosed, setSlashClosed] = useState(false);
	const [draftSeen, setDraftSeen] = useState(draft);
	if (draftSeen !== draft) {
		setDraftSeen(draft);
		setSlashClosed(false);
	}
	const [slashSeen, setSlashSeen] = useState<SlashContext | null>(null);
	if (slashSeen !== slash) {
		setSlashSeen(slash);
		setSlashActive(0);
		setSlashMoved(false);
	}
	const slashId = useId();

	const readOnly = view.readOnly;
	const working = view.working;
	const voiceOn = useApp(state => state.prefs?.voiceInput ?? false);
	const files = useProjectFiles(projectPath, mention !== null);
	const matches = useMemo(() => (mention && files ? fuzzyFiles(files, mention.query, 40) : null), [mention, files]);
	const slashList = useSlashCommands(projectPath, slash !== null && !mode);
	const slashMenu = useMemo(() => (slash && slashList ? slashOptions(slashList, slash) : null), [slash, slashList]);
	// The command name always shows the menu (loading, matches or "no match"); after the name it shows
	// only when there are subcommands to offer, or the argument hint before anything is typed.
	const slashOpen =
		slash !== null &&
		!mode &&
		!mention &&
		!slashClosed &&
		(slash.kind === "name" || (slashMenu !== null && (slashMenu.items.length > 0 || (slash.token === "" && slashMenu.command?.hint != null))));

	const setDraft = useCallback((text: string) => useComposerDrafts.getState().setDraft(tabId, text), [tabId]);

	const refreshMention = useCallback((text: string, caret: number) => {
		const next = mentionAtCaret(text, caret);
		setMention(current => (current?.start === next?.start && current?.query === next?.query ? current : next));
		setActiveMatch(0);
		const nextSlash = slashAtCaret(text, caret);
		setSlash(current => (JSON.stringify(current) === JSON.stringify(nextSlash) ? current : nextSlash));
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
		setSlash(null);
		// A slash command without attachments opens the app's own UI when there is one, else omp runs it.
		const sending =
			!mode && images.length === 0 && text.startsWith("/")
				? routeSlash(session, text).then(handled => (handled ? undefined : sendSlashCommand(session, text, { now })))
				: deliver(session, text, images, now);
		sending.catch((error: unknown) => {
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

	const pickSlash = (item: SlashItem) => {
		if (slash) replaceRange(slash.from, slash.to, item.insert);
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
		const slashItems = slashOpen ? (slashMenu?.items ?? []) : [];
		if (slashItems.length > 0) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const delta = event.key === "ArrowDown" ? 1 : -1;
				setSlashActive(index => (index + delta + slashItems.length) % slashItems.length);
				setSlashMoved(true);
				return;
			}
			const item = slashItems[slashActive];
			// Enter sends when the draft already holds the highlighted item, and after `/name ` until the
			// arrows pick a subcommand, so a bare `/fork` or `/mcp` still sends with one Enter.
			const sendsAsTyped = item?.typed || (slash?.kind === "args" && slash.token === "" && !slashMoved);
			if (item && ((event.key === "Tab" && !event.shiftKey) || (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !sendsAsTyped))) {
				event.preventDefault();
				pickSlash(item);
				return;
			}
		}
		if (event.key === "Escape") {
			if (mention) {
				event.preventDefault();
				event.stopPropagation();
				setMention(null);
			} else if (slashOpen) {
				event.preventDefault();
				event.stopPropagation();
				setSlashClosed(true);
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
		textarea.current?.focus();
	};

	/**
	 * ＋ menu items that move focus themselves (to the text box or a dialog) mark the close, so the menu
	 * skips returning focus to ＋ for them; dismissing the menu (Esc, outside click) still returns it there.
	 */
	const menuRedirect = useRef(false);
	const fromMenu = (action: () => void) => () => {
		menuRedirect.current = true;
		action();
	};

	const startMention = () => {
		const el = textarea.current;
		const current = useComposerDrafts.getState().drafts[tabId] ?? "";
		const start = el ? el.selectionStart : current.length;
		const end = el ? el.selectionEnd : current.length;
		const needsSpace = start > 0 && !/\s/.test(current[start - 1] ?? "");
		replaceRange(start, end, needsSpace ? " @" : "@");
	};

	// Read-only placeholders follow the header and banner: an unreadable file first, then owned elsewhere, free to
	// continue (the banner offers Continue here), or unchecked.
	const follow = view.follow;
	const placeholder = readOnly
		? t(
				follow && !follow.readable
					? "placeholder.readOnlyUnreadable"
					: follow?.ownership === "free"
						? "placeholder.readOnlyFree"
						: follow?.ownership === "unknown"
							? "placeholder.readOnlyUnknown"
							: "placeholder.readOnly",
			)
		: mode
			? t(`placeholder.${mode}`)
			: working
				? t("placeholder.working")
				: t("placeholder.idle");
	const canSend = !readOnly && (draft.trim().length > 0 || attachments.length > 0);
	const actionSet = `${working}:${canSend}`;
	const mod = IS_MAC ? "⌘" : "Ctrl+";
	const questionId = view.guest?.uiRequest?.reqId ?? null;
	// Slots below order 50 sit on the left of the row under the card (folder, permission); the rest on the right.
	const leadTools = tools.filter(slot => slot.order < 50);
	const trailTools = tools.filter(slot => slot.order >= 50);
	const sendNowKeys = `${mod}↵`;

	return (
		<div ref={setRoot} className="@container/composer relative mx-auto w-full max-w-(--chat-max)">
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
			<QueueTray session={session} queue={view.queue} questionId={questionId} />
			<div
				className={cn(
					"relative rounded-xl border border-border-strong bg-panel shadow-(--shadow-card) transition-colors duration-(--dur-fast) focus-within:border-control-border",
					readOnly && "bg-inset",
				)}
			>
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
				{/*
				 * One flex-wrap line: ＋, the text box, then the mic and the actions. The actions move to a second,
				 * right-aligned line when the text box would drop below its minimum width; buttons stay at the bottom
				 * as the text grows.
				 */}
				<div className="relative flex flex-wrap items-end gap-1 p-2">
					{mention ? (
						<MentionPicker id={pickerId} matches={matches} active={activeMatch} onActive={setActiveMatch} onPick={pickMention} />
					) : (
						slashOpen && <SlashMenu id={slashId} options={slashMenu} active={slashActive} onActive={setSlashActive} onPick={pickSlash} />
					)}
					<Menu>
						<Tooltip content={t("plus.tip")}>
							<MenuTrigger asChild disabled={readOnly}>
								<button
									type="button"
									aria-label={t("plus.label")}
									className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 data-[state=open]:bg-selected"
								>
									<Plus className="size-4" aria-hidden />
								</button>
							</MenuTrigger>
						</Tooltip>
						<MenuContent
							side="top"
							align="start"
							onCloseAutoFocus={event => {
								if (!menuRedirect.current) return;
								menuRedirect.current = false;
								event.preventDefault();
							}}
						>
							<MenuItem icon={<Paperclip />} onSelect={fromMenu(() => void pickFiles())}>
								{t("plus.attach")}
							</MenuItem>
							<MenuItem icon={<At />} onSelect={fromMenu(() => requestAnimationFrame(startMention))}>
								{t("plus.mention")}
							</MenuItem>
							<MenuSeparator />
							<MenuItem icon={<BookBookmark />} onSelect={fromMenu(() => setLibrary("saved"))}>
								{t("plus.library")}
							</MenuItem>
							<MenuItem icon={<GraduationCap />} onSelect={fromMenu(() => setLibrary("skills"))}>
								{t("plus.skills")}
							</MenuItem>
							<MenuItem icon={<Command />} onSelect={fromMenu(() => setLibrary("commands"))}>
								{t("plus.commands")}
							</MenuItem>
							<MenuSeparator />
							{QUICK_MODES.map(({ mode: quick, glyph }) => (
								<MenuCheckboxItem
									key={quick}
									checked={mode === quick}
									shortcut={glyph}
									onSelect={fromMenu(() => {
										useComposerDrafts.getState().setMode(tabId, mode === quick ? null : quick);
										requestAnimationFrame(() => textarea.current?.focus());
									})}
								>
									{t(`modes.${quick}.label`)}
								</MenuCheckboxItem>
							))}
							<MenuItem
								icon={<Microphone />}
								onSelect={fromMenu(() => {
									useVoiceRequests.getState().requestStart(tabId);
									// With voice off the request opens the voice dialog, which takes focus itself.
									if (voiceOn) requestAnimationFrame(() => textarea.current?.focus());
								})}
							>
								{t("voice.start")}
							</MenuItem>
						</MenuContent>
					</Menu>
					<div className="flex min-w-0 grow basis-48 items-start gap-2 px-1 py-1">
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
											className="mt-0.5 inline-flex h-(--text-base--line-height) shrink-0 items-center rounded-sm bg-selected px-1.5 font-mono text-sm font-semibold text-fg outline-none focus-visible:outline-2 focus-visible:outline-ring"
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
								aria-expanded={mention !== null || slashOpen}
								aria-controls={mention ? pickerId : slashOpen ? slashId : undefined}
								aria-autocomplete="list"
								aria-activedescendant={
									mention && matches?.length
										? `${pickerId}-${activeMatch}`
										: slashOpen && slashMenu?.items.length
											? `${slashId}-${slashActive}`
											: undefined
								}
								onChange={event => {
									setDraft(event.target.value);
									refreshMention(event.target.value, event.target.selectionStart);
								}}
								onSelect={event => refreshMention(event.currentTarget.value, event.currentTarget.selectionStart)}
								onBlur={() => {
									setMention(null);
									setSlash(null);
								}}
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
					</div>
					<div className="ml-auto flex shrink-0 items-center gap-1">
						<VoiceTool session={session} />
						<AnimatePresence initial={false} mode="popLayout">
							{working && (
								<motion.span key="stop" layoutDependency={actionSet} {...actionMotion}>
									<Tooltip content={t("send.stop")} shortcut="Esc">
										<button
											type="button"
											aria-label={t("send.stop")}
											onClick={() => session.abort()}
											className="inline-flex size-8 items-center justify-center rounded-sm bg-err-bg text-err outline-none transition-[background-color,color,scale] duration-(--dur-fast) hover:bg-err hover:text-fg-inverse active:scale-[0.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
										>
											<Square weight="fill" className="size-3.5" aria-hidden />
										</button>
									</Tooltip>
								</motion.span>
							)}
							{working && canSend && (
								<motion.span key="now" layoutDependency={actionSet} {...actionMotion}>
									<Tooltip content={t("send.nowTip")} shortcut={sendNowKeys}>
										<button
											type="button"
											aria-label={t("send.now")}
											aria-keyshortcuts={IS_MAC ? "Meta+Enter" : "Control+Enter"}
											onClick={() => submit(true)}
											className="inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-sm font-medium text-fg-muted outline-none transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
										>
											<PaperPlaneRight className="size-4 shrink-0" aria-hidden />
											<span className="whitespace-nowrap @max-[34rem]/composer:hidden">{t("send.now")}</span>
											<Kbd className="@max-[34rem]/composer:hidden">{sendNowKeys}</Kbd>
										</button>
									</Tooltip>
								</motion.span>
							)}
							{working && canSend && (
								<motion.span key="queue" layoutDependency={actionSet} {...actionMotion}>
									<Tooltip content={t("send.queueTip")} shortcut="↵">
										<button
											type="button"
											onClick={() => submit(false)}
											className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-sm bg-accent px-3 text-sm font-semibold text-accent-fg shadow-(--shadow-primary) outline-none transition-[background-color,scale] duration-(--dur-fast) hover:bg-accent-hover active:scale-[0.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
										>
											<ArrowUp className="size-4 shrink-0" aria-hidden />
											{t("send.queue")}
										</button>
									</Tooltip>
								</motion.span>
							)}
							{!working && (
								<motion.span key="send" layoutDependency={actionSet} {...actionMotion}>
									<Tooltip content={t("send.tip")} shortcut="↵">
										<button
											type="button"
											aria-label={t("send.label")}
											disabled={!canSend}
											onClick={() => submit(false)}
											className="inline-flex size-8 items-center justify-center rounded-sm bg-accent text-accent-fg shadow-(--shadow-primary) outline-none transition-[background-color,scale,opacity] duration-(--dur-fast) enabled:hover:bg-accent-hover enabled:active:scale-[0.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45"
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
			{/* The chat's settings: a quiet row under the card that wraps rather than crowd a narrow column. */}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-2">
				<div className="flex min-w-0 flex-wrap items-center gap-1">
					{leadTools.map(slot => (
						<slot.component key={slot.id} session={session} />
					))}
				</div>
				<div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
					{trailTools.map(slot => (
						<slot.component key={slot.id} session={session} />
					))}
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
