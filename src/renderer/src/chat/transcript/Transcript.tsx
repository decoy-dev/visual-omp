/**
 * The chat transcript (DESIGN §3.5, §4.6). Pairing and windowing follow omp's own collab-web
 * Transcript; tail-follow, pacing and presentation are visual-omp's.
 */
import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { FileRef } from "@shared/contracts/fileRefs";
import { ArrowDown, ArrowUUpLeft, CaretRight, Copy, GitFork, Warning, XCircle } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import {
	Component,
	Fragment,
	type KeyboardEvent,
	type MouseEvent,
	memo,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type { ActiveTool } from "../../collab/lib/client";
import { continuesAssistantModel, modelFallbacks, modelSetupVisible, providerFallback, type ModelFallback } from "../../collab/lib/modelFallback";
import { type Helper, type HelperStatus, helpersByCall, ompRunning, settleHelper, transcriptHelperStates } from "../../features/panes/derive";
import { unpinnedRuns, usePinnedHelpers } from "../../features/panes/pinnedHelpers";
import { openInFiles } from "../../features/panes/files-store";
import { useHomeDir } from "../../features/projects/folders/FolderBrowser";
import { getCommand } from "../../registry/commands";
import { chatSlots } from "../../registry/slots";
import { type CommandResultRecord, dismissCommandResult, placeResults, roomKey, useCommandResults } from "../../features/session-tools/results";
import { liveGuest, type SessionController, type SessionView } from "../../state/session";
import { useApp } from "../../state/app";
import { copyCode, StreamingMarkdown } from "../../transcript/Markdown";
import { Button, cn, duration, ease, Expand, IconButton, Mark, Rise, spring, toast, useScrollFollow } from "../../ui";
import { useDisplayedEntries } from "../branch";
import { isReplyWrite, replyWriteUndecided, toolResultReplies } from "../friendly";
import { useComposerDrafts } from "../composer/drafts";
import { FileRefContext, LinkedMarkdown, useFileRefs, writtenFolders } from "./FileLinks";
import { TargetContextMenu } from "../../ui/TargetContextMenu";
import { usePendingQuestion } from "./QuestionCard";
import { ReplyAnnouncer } from "./ReplyAnnouncer";
import { helperRunsSummary, TaskRuns, taskRowContextEqual, taskRuns } from "../../tool-render/tools/task";
import { TodoBoard, TodoChangeRow } from "../../tool-render/tools/todo";
import { detailsRecord, isRecord } from "../../tool-render/util";
import { ResultText } from "../../tool-render/parts";
import { CommandResultRow } from "./CommandResultRow";
import { NoticeRow } from "./NoticeRow";
import { ModelFallbackNotice } from "./ModelFallbackNotice";
import { contentText, noticeIsStep, noticeVisible, parseNotice } from "./notices";
import { ToolCard } from "./ToolCard";
import { ToolGroup } from "./ToolGroup";
import { TurnSummary } from "./TurnSummary";
import { thoughtKey, ThoughtChoices, thoughtOpen, writingThought } from "./thoughtChoices";
import { type BlockRef, type ContentBlock, type EntryLayout, replyText, STREAM_ENTRY, TAIL_ENTRY, type TranscriptLayout, transcriptLayout, liveLayoutEntries, unsavedToolsMessage } from "./turns";
import { anchorRow, tailStart, WINDOW, windowOnScroll } from "./window";
import {
	type PlayoutBlock,
	PlayoutPaused,
	PlayoutRegistry,
	type Playout,
	revealedPrefix,
	synchronizedStream as streamNeedsSync,
	usePlayout,
	useRevealed,
} from "./pace";
import "./transcript.css";

export type TranscriptMode = "normal" | "thinking" | "verbose";

/** How close to the top loads the previous window, once the reader has scrolled away from the bottom. */
const EARLIER_TRIGGER_PX = 240;
/** How close to the bottom still counts as pinned there, so the view keeps following new content. */
const PINNED_PX = 48;
const EMPTY_TOOLS: ReadonlyMap<string, ActiveTool> = new Map();

function timeOf(timestamp: string | undefined): string {
	if (!timestamp) return "";
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function Notice({ children }: { children: ReactNode }): ReactNode {
	return (
		<div className="flex items-center gap-3 py-1 text-xs text-fg-faint" role="note">
			<span className="h-px flex-1 bg-border" />
			<span>{children}</span>
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}

function UserContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	const { t } = useTranslation("chat");
	// Saved sessions keep image data in omp's blob store (`blob:sha256:…`), which this row does not load; such images
	// get no thumbnail, and a message holding only those gets no empty thumbnail row.
	const images = typeof content === "string" ? [] : content.filter((block): block is ImageContent => block.type === "image" && !block.data.startsWith("blob:"));
	const text = contentText(content);
	return (
		<>
			{images.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-2">
					{images.map((image, index) => (
						<img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={t("attachedImage", { number: index + 1 })} tabIndex={0} className="size-12 rounded-md border border-border object-cover" />
					))}
				</div>
			)}
			<p className="selectable text-base whitespace-pre-wrap text-fg">{text}</p>
		</>
	);
}

function UserMessage({ entry, session, from }: { entry: SessionEntry; session: SessionController; from?: string }): ReactNode {
	const { t } = useTranslation("chat");
	const content = entry.type === "message" && entry.message.role === "user" ? entry.message.content : entry.type === "custom_message" ? entry.content : "";
	const run = (id: string) => void getCommand(id)?.run({ session, projectPath: session.projectPath, entryId: entry.id });
	return (
		<div className="group flex flex-col items-end gap-1">
			<div className="flex items-center gap-2 text-xs text-fg-faint">
				<span className="opacity-0 transition-opacity duration-(--dur) group-hover:opacity-100">{timeOf(entry.timestamp)}</span>
				<span className="font-medium text-fg-muted">{from ? t("from", { name: from }) : t("you")}</span>
			</div>
			<div className="max-w-[85%] rounded-lg border border-border bg-inset px-4 py-3">
				<UserContent content={content} />
			</div>
			<div className="flex gap-0.5 opacity-0 transition-opacity duration-(--dur) group-focus-within:opacity-100 group-hover:opacity-100">
				{getCommand("chat.rewindTo") && <IconButton label={t("rewind")} icon={<ArrowUUpLeft />} size="sm" onClick={() => run("chat.rewindTo")} />}
				{getCommand("chat.forkFrom") && <IconButton label={t("fork")} icon={<GitFork />} size="sm" onClick={() => run("chat.forkFrom")} />}
				<IconButton
					label={t("copy")}
					icon={<Copy />}
					size="sm"
					onClick={() => void navigator.clipboard.writeText(contentText(content)).then(() => toast({ tone: "ok", message: t("copied") }))}
				/>
			</div>
		</div>
	);
}

function ThinkingBlock({
	text,
	playout = null,
	index = 0,
	redacted,
	open,
	onToggle,
}: {
	text: string;
	/** The reply's reveal; the thought's shown prefix follows it without re-rendering the rest of the reply. */
	playout?: Playout | null;
	index?: number;
	redacted?: boolean;
	open: boolean;
	onToggle?: () => void;
}): ReactNode {
	const { t } = useTranslation("chat");
	const shown = useRevealed(open ? playout : null, index, text.length);
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="-mx-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-fg-faint outline-none transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-ring"
			>
				<CaretRight className={cn("size-3.5 transition-[rotate] duration-(--dur) ease-(--ease-out)", open && "rotate-90")} aria-hidden />
				{redacted ? t("redactedThinking") : t("thoughts")}
			</button>
			<Expand open={open && !redacted} className="selectable pt-1 pb-2 pl-5 text-sm whitespace-pre-wrap text-fg-muted">
				{revealedPrefix(text, shown)}
			</Expand>
		</div>
	);
}

/**
 * One text block of a reply. While the reply reveals, only this component re-renders as its text grows; the
 * reply's tool rows and other blocks stay put.
 */
function ReplyText({
	text,
	playout,
	index,
	revealing,
	caret,
	refs,
}: {
	text: string;
	playout: Playout | null;
	index: number;
	revealing: boolean;
	/** The streaming caret follows this block's last character. */
	caret: boolean;
	refs: readonly (FileRef | null)[] | undefined;
}): ReactNode {
	const shown = useRevealed(playout, index, text.length);
	const visible = revealedPrefix(text, shown);
	return (
		<div className="py-2 first:pt-0 last:pb-0" data-streaming={caret ? "" : undefined}>
			{revealing ? <StreamingMarkdown text={visible} blockIn /> : <LinkedMarkdown text={visible} refs={refs} />}
		</div>
	);
}

/** Whether block `index` shows yet: -1 before the reveal reaches it, otherwise its shown length (any positive count once passed). */
function shownLength(playout: Playout | null, index: number, length: number): number {
	return playout ? Math.min(length, playout.visible(index)) : length;
}

/** Each shell reply is complete when emitted, even while its command keeps running. */
function ToolReply({ replyKey, text, live, synchronized }: { replyKey: string; text: string; live: boolean; synchronized: boolean }): ReactNode {
	const [arriving, setArriving] = useState(live && !synchronized);
	useEffect(() => {
		if (arriving) setArriving(false);
	}, [arriving]);
	const playout = usePlayout(replyKey, [{ length: text.length, timed: true }], { pending: arriving, showExisting: !live, synchronized });
	const refs = useFileRefs(playout ? null : replyKey, [text]);
	if (playout && shownLength(playout, 0, text.length) <= 0) return null;
	return <ReplyText text={text} playout={playout} index={0} revealing={playout !== null} caret={playout !== null} refs={refs?.[0]} />;
}

/** Ids the reader is using, with a stable toggle that leaves the set as it is when nothing changes. */
function useHeldSet(): [ReadonlySet<string>, (id: string, engaged: boolean) => void] {
	const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
	const toggle = useCallback((id: string, engaged: boolean) => {
		setHeld(current => {
			if (current.has(id) === engaged) return current;
			const next = new Set(current);
			if (engaged) next.add(id);
			else next.delete(id);
			return next;
		});
	}, []);
	return [held, toggle];
}

const NO_THOUGHT_CHOICES = new ThoughtChoices();

/** The reader's thought choices (`thoughtChoices.ts`); the component re-renders when one changes. */
function useThoughtChoices(store: ThoughtChoices | undefined): ReadonlyMap<string, boolean> {
	const source = store ?? NO_THOUGHT_CHOICES;
	return useSyncExternalStore(source.subscribe, source.snapshot);
}

/** What the turn layout tells a reply's tool blocks (see `turns.ts`). */
interface WorkView {
	layout: TranscriptLayout;
	/** Group keys forming while the chat is open (during a turn): they rise in like new rows. */
	arriving: ReadonlySet<string>;
	/** Open groups by key, so a group the reader opened stays open when its row remounts (`ToolGroup`). */
	openGroups: Map<string, boolean>;
	/** Thoughts the reader opened or closed, shared by reply rows and step groups. */
	thoughts: ThoughtChoices;
	/** Live helpers by the task call that started them (`helpersByCall`). */
	helpers: ReadonlyMap<string, readonly Helper[]>;
	/** Running helpers, pinned at the bottom of the chat (`pinnedHelpers`): their cards stay out from under their call. */
	pinned: ReadonlySet<string>;
	/** Each helper's last state the transcript records (`transcriptHelperStates`), for helpers read from their call. */
	recorded: ReadonlyMap<string, HelperStatus>;
	/** An omp process may still run this chat's helpers (`ompRunning`). */
	ompRunning: boolean;
	/** Reply frames present during initial load or reconnect show without replaying their reveal. */
	synchronizing: boolean;
	/** Marks a step the reader is using (open, or focus inside it), so it stays a row instead of folding (`turns.ts`). */
	hold: (callId: string, engaged: boolean) => void;
	/** Marks a group the reader is using, by key, so it keeps its own boundary and key (`turns.ts`). */
	holdGroup: (key: string, engaged: boolean) => void;
}

type ToolCallBlock = Extract<ContentBlock, { type: "toolCall" }>;

/**
 * One tool call: the turn's latest task board as the full card, an earlier board update as the line of what it
 * changed, a helper run as its row plus a card per helper, anything else as the quiet tool row.
 */
function ToolStep({
	block,
	results,
	active,
	pending,
	mode,
	arriving,
	work,
	grouped = false,
}: {
	block: ToolCallBlock;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	pending: boolean;
	mode: TranscriptMode;
	arriving: boolean;
	work: WorkView | undefined;
	/** Drawn inside a step group, which already holds it: using it there never reshapes the groups. */
	grouped?: boolean;
}): ReactNode {
	const { t } = useTranslation("tools");
	const live = active.get(block.id);
	const result = results.get(block.id);
	const running = !result && (live !== undefined || pending);
	const todo = work?.layout.todos.get(block.id);
	if (todo?.role === "board") {
		return (
			<Rise play={arriving} distance={6} tempo="snappy" className="py-2">
				<TodoBoard phases={todo.update.phases} />
			</Rise>
		);
	}
	if (todo?.role === "change") return <TodoChangeRow update={todo.update} />;
	const args = live?.args ?? block.arguments;
	// A task call's helpers can outlive it (a background spawn returns at once), so its row and cards follow the
	// helpers' live state when omp reports it, else what the call's own result or progress says, updated by what the
	// transcript later records. Without a running omp, nothing still works.
	let runs: readonly Helper[] = [];
	if (block.name === "task") {
		const liveRuns = work?.helpers.get(block.id);
		const partial = isRecord(live?.partialResult) && isRecord(live.partialResult.details) ? live.partialResult.details : null;
		runs =
			liveRuns && liveRuns.length > 0
				? liveRuns
				: taskRuns(isRecord(args) ? args : {}, detailsRecord(result) ?? partial, running).map(run => settleHelper(run, work?.recorded ?? null, work?.ompRunning ?? true));
	}
	const card = (
		<ToolCard
			name={block.name}
			args={args}
			intent={block.intent ?? live?.intent}
			result={result}
			running={running}
			partialResult={live?.partialResult}
			verbose={mode === "verbose"}
			arriving={arriving}
			summary={helperRunsSummary(runs, (status, count) => t(`task.states.${status}`, { count })) ?? undefined}
			onEngage={grouped || mode !== "normal" ? undefined : work?.hold}
			engageId={block.id}
		/>
	);
	// A helper pinned at the bottom of the chat while it runs has no card here; the row still counts it.
	const cards = work ? unpinnedRuns(runs, work.pinned) : runs;
	const replies = toolResultReplies(result?.details ?? (isRecord(live?.partialResult) ? live.partialResult.details : undefined));
	if (runs.length === 0) return (
		<>
			{card}
			{replies.map((text, index) => (
				<ToolReply key={index} replyKey={`tool-replies:${block.id}:${index}`} text={text} live={live !== undefined} synchronized={work?.synchronizing ?? false} />
			))}
		</>
	);
	return (
		<div>
			{card}
			<Expand open={cards.length > 0} className="pt-1 pb-2 pl-6.5">
				<TaskRuns runs={cards} />
			</Expand>
		</div>
	);
}

/** A thought folded into a step group (Normal view): closed unless the reader opened it, here or before it moved in. */
function GroupThought({ item, thoughts }: { item: BlockRef; thoughts: ThoughtChoices | undefined }): ReactNode {
	const choices = useThoughtChoices(thoughts);
	const block = item.block;
	if (block.type === "redactedThinking") return <ThinkingBlock text="" redacted open={false} />;
	if (block.type !== "thinking" || block.narration === true) return null;
	const key = thoughtKey(item.messageTime, item.index);
	const open = thoughtOpen("normal", choices.get(key), false);
	return <ThinkingBlock text={block.thinking} open={open} onToggle={() => thoughts?.toggle("normal", key, open)} />;
}

export function AssistantBlocks({
	message,
	results,
	active,
	pending,
	mode,
	revealFromStart = false,
	synchronized = false,
	liveThinking = false,
	layout,
	work,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	pending: boolean;
	mode: TranscriptMode;
	/** A reply that starts streaming while the chat is open reveals from its first character (see `usePlayout`). */
	revealFromStart?: boolean;
	/** The live mirror is synchronizing with an existing stream, rather than receiving new text. */
	synchronized?: boolean;
	/**
	 * Normal view shows the thought omp is writing (the last block while the reply still streams) open as it grows,
	 * and folds it once omp moves on (the "Show thinking as omp thinks" setting).
	 */
	liveThinking?: boolean;
	/** Blocks this reply hides (drawn in an earlier group) and the step groups it leads. */
	layout?: EntryLayout;
	work?: WorkView;
}): ReactNode {
	const { t } = useTranslation("chat");
	const choices = useThoughtChoices(work?.thoughts);
	const writing = writingThought(message, pending, liveThinking);
	const isOpen = (index: number) => thoughtOpen(mode, choices.get(thoughtKey(message.timestamp, index)), index === writing);
	const toggleThought = (index: number) => work?.thoughts.toggle(mode, thoughtKey(message.timestamp, index), isOpen(index));
	const blockTexts = message.content.map(block => {
		if (block.type !== "toolCall") return replyText(block);
		const live = active.get(block.id);
		const args = live?.args ?? block.arguments;
		if (pending && replyWriteUndecided(block.name, args)) return "";
		if (isReplyWrite(block.name, args)) return isRecord(args) && typeof args.content === "string" ? args.content : "";
		return null;
	});
	// Visible text and open thoughts take time to reveal; collapsed thoughts and tool calls show when reached.
	const timeline: PlayoutBlock[] = message.content.map((block, index) => {
		const text = blockTexts[index];
		if (text !== null) return { length: text.length, timed: true };
		if (block.type === "thinking") return { length: block.thinking.length, timed: isOpen(index) };
		return { length: 0, timed: false };
	});
	const playout = usePlayout(message.timestamp, timeline, { pending, showExisting: !revealFromStart, synchronized });
	// The saved entry that replaces the stream row keeps revealing until the reveal catches up.
	const revealing = pending || playout !== null;
	let lastText = -1;
	// A finished reply's file names become links; a growing stream is left alone until it ends.
	const texts = blockTexts.filter((text): text is string => text !== null);
	const refs = useFileRefs(revealing ? null : message.timestamp, texts);
	let textOrdinal = 0;
	const textOrdinals = blockTexts.map(text => (text !== null ? textOrdinal++ : -1));
	for (const [index, block] of message.content.entries()) {
		const text = blockTexts[index];
		if (text !== null && shownLength(playout, index, text.length) > 0) lastText = index;
	}
	const failed = !revealing && (message.stopReason === "error" || message.stopReason === "aborted");
	return (
		<div className="flex flex-col">
			{message.content.map((block, index) => {
				if (layout?.hidden.has(index)) return null;
				const text = blockTexts[index];
				if (text !== null) {
					if (shownLength(playout, index, text.length) <= 0 && playout) return null;
					return (
						<Fragment key={block.type === "toolCall" ? block.id : index}>
							<ReplyText
								text={text}
								playout={playout}
								index={index}
								revealing={revealing}
								caret={revealing && index === lastText}
								refs={refs?.[textOrdinals[index]]}
							/>
							{block.type === "toolCall" && isReplyWrite(block.name, block.arguments) && results.get(block.id)?.isError && <ResultText result={results.get(block.id)} />}
						</Fragment>
					);
				}
				switch (block.type) {
					case "thinking":
						if (shownLength(playout, index, block.thinking.length) < 0) return null;
						return (
							<ThinkingBlock
								key={index}
								text={block.thinking}
								playout={playout}
								index={index}
								open={isOpen(index)}
								onToggle={() => toggleThought(index)}
							/>
						);
					case "redactedThinking":
						return shownLength(playout, index, 0) < 0 ? null : <ThinkingBlock key={index} text="" redacted open={false} />;
					case "fallback": {
						const fallback = providerFallback(block);
						return fallback ? <ModelFallbackNotice key={index} fallback={fallback} /> : null;
					}
					case "toolCall": {
						if (shownLength(playout, index, 0) < 0) return null;
						const group = layout?.groups.get(index);
						if (group) {
							return (
								<ToolGroup
									key={block.id}
									plan={group}
									arriving={work?.arriving.has(group.key)}
									openState={work?.openGroups}
									onEngage={mode === "normal" ? work?.holdGroup : undefined}
								>
									{group.items.map(item =>
										item.block.type === "toolCall" ? (
											<ToolStep key={item.block.id} block={item.block} results={results} active={active} pending={group.running} mode={mode} arriving={false} work={work} grouped />
										) : (
											<GroupThought key={`${item.entryId}:${item.index}`} item={item} thoughts={work?.thoughts} />
										),
									)}
								</ToolGroup>
							);
						}
						return <ToolStep key={block.id} block={block} results={results} active={active} pending={pending} mode={mode} arriving={revealing} work={work} />;
					}
					default:
						return null;
				}
			})}
			{failed && (
				<div
					className={cn(
						"mt-2 flex items-start gap-2 rounded-md px-3 py-2 text-md",
						message.stopReason === "error" ? "bg-err-bg text-err" : "bg-warn-bg text-warn",
					)}
				>
					{message.stopReason === "error" ? (
						<XCircle weight="fill" className="mt-0.5 size-4 shrink-0" aria-hidden />
					) : (
						<Warning weight="fill" className="mt-0.5 size-4 shrink-0" aria-hidden />
					)}
					<span>
						<span className="font-medium">{message.stopReason === "error" ? t("stopped.error") : t("stopped.aborted")}</span>
						{message.errorMessage && <span className="selectable ml-2 text-fg-muted">{message.errorMessage}</span>}
					</span>
				</div>
			)}
		</div>
	);
}

function AssistantHeader({ model, timestamp }: { model?: string; timestamp?: string }): ReactNode {
	const { t } = useTranslation("chat");
	return (
		<div className="flex items-center gap-2 text-sm text-fg-faint">
			<Mark size={18} />
			<span>{[model ?? t("assistant"), timeOf(timestamp)].filter(Boolean).join(" · ")}</span>
		</div>
	);
}

interface RowProps {
	entry: SessionEntry;
	/** The previous visible row was already part of this assistant turn. */
	continuesTurn: boolean;
	/** A user message appeared before this entry (session-start model/thinking entries stay hidden). */
	afterFirstPrompt: boolean;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	mode: TranscriptMode;
	session: SessionController;
	/** Hidden blocks and step groups of this entry; compared by `sig`, so a row re-renders only when its layout does. */
	layout: EntryLayout | undefined;
	work: WorkView;
	fallback?: ModelFallback;
}

function rowEqual(prev: RowProps, next: RowProps): boolean {
	if (prev.entry !== next.entry || prev.mode !== next.mode || prev.continuesTurn !== next.continuesTurn || prev.afterFirstPrompt !== next.afterFirstPrompt) return false;
	if (prev.layout?.sig !== next.layout?.sig) return false;
	if (prev.fallback !== next.fallback) return false;
	const entry = next.entry;
	if (entry.type !== "message" || entry.message.role !== "assistant") return true;
	// A group this row leads draws steps of later entries and of the reply still streaming in, which keep changing.
	const calls: ContentBlock[] = [...entry.message.content];
	for (const [index, plan] of next.layout?.groups ?? []) {
		const before = prev.layout?.groups.get(index)?.items;
		for (const [n, item] of plan.items.entries()) {
			if (before?.[n]?.block !== item.block) return false;
			calls.push(item.block);
		}
	}
	for (const block of calls) {
		if (block.type !== "toolCall") continue;
		const live = next.active.get(block.id);
		const result = next.results.get(block.id);
		if (prev.results.get(block.id) !== result || prev.active.get(block.id) !== live) return false;
		if (block.name !== "task") continue;
		// A task call's helpers report progress after the call itself returned, and leave its cards while pinned.
		if (prev.work.pinned !== next.work.pinned) return false;
		const liveRuns = next.work.helpers.get(block.id);
		if (prev.work.helpers.get(block.id) !== liveRuns) return false;
		if (liveRuns && liveRuns.length > 0) continue;
		// Helpers read from the call: later wait results, deliveries and omp's exit change them (see ToolStep).
		const args = live?.args ?? block.arguments;
		const partial = isRecord(live?.partialResult) && isRecord(live.partialResult.details) ? live.partialResult.details : null;
		if (!taskRowContextEqual(isRecord(args) ? args : {}, detailsRecord(result) ?? partial, prev.work, next.work)) return false;
	}
	return true;
}

/**
 * Whether {@link Row} draws anything for `entry`. Hidden entries (tool results, omp's `custom`
 * bookkeeping such as `tool_execution_start`, setup changes) get no row wrapper: an empty wrapper
 * still takes a flex gap, and a run of them opened blank space between tool rounds.
 */
function rowShown(entry: SessionEntry, mode: TranscriptMode, afterFirstPrompt: boolean): boolean {
	switch (entry.type) {
		case "message":
			return entry.message.role === "user" || entry.message.role === "assistant";
		case "custom_message":
			return entry.customType === "collab-prompt" || (entry.display && noticeVisible(parseNotice(entry)));
		case "compaction":
		case "branch_summary":
			return true;
		case "model_change":
		case "thinking_level_change":
			return modelSetupVisible(entry, mode === "verbose", afterFirstPrompt);
		default:
			return false;
	}
}

const Row = memo(function Row({ entry, continuesTurn, afterFirstPrompt, results, active, mode, session, layout, work, fallback }: RowProps): ReactNode {
	const { t } = useTranslation("chat");
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "user") return <UserMessage entry={entry} session={session} />;
			if (message.role !== "assistant") return null;
			return (
				<div className="flex flex-col gap-2">
					{!continuesTurn && <AssistantHeader model={message.model} timestamp={entry.timestamp} />}
					<AssistantBlocks message={message} results={results} active={active} pending={false} mode={mode} layout={layout} work={work} />
				</div>
			);
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from = details && typeof details === "object" && "from" in details && typeof details.from === "string" ? details.from : undefined;
				return <UserMessage entry={entry} session={session} from={from} />;
			}
			if (!entry.display) return null;
			return <NoticeRow entry={entry} mode={mode} />;
		}
		case "compaction":
			return <Notice>{t("compacted")}</Notice>;
		case "branch_summary":
			return <Notice>{t("branchSummary")}</Notice>;
		case "model_change":
			return fallback ? <ModelFallbackNotice fallback={fallback} /> : modelSetupVisible(entry, mode === "verbose", afterFirstPrompt) ? <Notice>{t("modelChanged", { model: entry.model })}</Notice> : null;
		case "thinking_level_change":
			return modelSetupVisible(entry, mode === "verbose", afterFirstPrompt) ? <Notice>{t("thinkingChanged", { level: entry.thinkingLevel ?? "off" })}</Notice> : null;
		default:
			return null;
	}
}, rowEqual);

function EmptyChat({ session }: { session: SessionController }): ReactNode {
	const { t } = useTranslation("chat");
	// `returnObjects` yields the JSON array as authored in i18n/en/chat.json.
	const prompts = t("empty.prompts", { returnObjects: true }) as { title: string; text: string }[];
	const returning = useApp(state => state.projects.some(project => project.sessionCount > 1));
	return (
		<div className="m-auto flex w-full max-w-130 flex-col gap-6 py-16">
			<div className="flex flex-col items-center gap-4 text-center">
				<Mark size={40} />
				<div>
					<h2 className="text-2xl font-bold tracking-[-0.02em] text-fg">{returning ? t("empty.returning") : t("empty.first")}</h2>
					{!returning && <p className="mt-1 text-md text-fg-muted">{t("empty.tip")}</p>}
				</div>
			</div>
			<ul aria-label={t("empty.promptsLabel")} className="flex flex-col">
				{prompts.map(prompt => (
					<li key={prompt.title}>
						<button
							type="button"
							onClick={() => {
								useComposerDrafts.getState().setDraft(session.tabId, prompt.text);
								useComposerDrafts.getState().focus(session.tabId);
							}}
							className="group/prompt flex w-full items-baseline gap-3 rounded-md px-3 py-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
						>
							<span className="shrink-0 text-md font-medium text-fg">{prompt.title}</span>
							<span className="min-w-0 flex-1 truncate text-sm text-fg-faint transition-colors duration-(--dur-fast) group-hover/prompt:text-fg-muted">
								{prompt.text}
							</span>
						</button>
					</li>
				))}
			</ul>
			<p className="text-center text-sm text-fg-faint">{t("empty.hints")}</p>
		</div>
	);
}

export interface TranscriptProps {
	session: SessionController;
	view: SessionView;
	mode: TranscriptMode;
}

interface WindowEdgeProps {
	start: number;
	/** Records where the view is; called just before React changes the DOM for a new `start`. */
	onBefore: () => void;
}

/**
 * Calls `onBefore` just before a commit that moves the window's start changes the DOM. `getSnapshotBeforeUpdate` is
 * React's only hook between a render and its DOM changes, and it exists only on class components. The transcript's
 * layout effect compares the view after the commit with that record.
 */
class WindowEdge extends Component<WindowEdgeProps> {
	getSnapshotBeforeUpdate(previous: Readonly<WindowEdgeProps>): null {
		if (previous.start !== this.props.start) this.props.onBefore();
		return null;
	}

	/** React requires it beside `getSnapshotBeforeUpdate`; the transcript's layout effect does the work. */
	componentDidUpdate(): void {}

	render(): null {
		return null;
	}
}

/** What the previous commit showed, so a render can tell newly arrived rows from history. */
interface Arrivals {
	/** The transcript had loaded (messages or the empty state) at the previous commit. Until then nothing rises. */
	armed: boolean;
	seen: ReadonlySet<string>;
	/** A reply was streaming at the previous commit; its saved entry replaces the stream row in place. */
	streamed: boolean;
}

/**
 * True while the chat is out of sight: under a page it opened or the hidden half of a narrow split (both make an
 * ancestor `inert`), or in a hidden window. Presentation animation pauses then; state keeps arriving.
 */
function useOutOfSight(ref: RefObject<HTMLElement | null>): boolean {
	const [hidden, setHidden] = useState(false);
	useEffect(() => {
		const check = () => setHidden(document.hidden || ref.current?.closest("[inert]") != null);
		check();
		const observer = new MutationObserver(check);
		observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert"] });
		document.addEventListener("visibilitychange", check);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", check);
		};
	}, [ref]);
	return hidden;
}

export function Transcript({ session, view, mode }: TranscriptProps): ReactNode {
	const { t } = useTranslation("chat");
	const slots = chatSlots.use().filter(slot => slot.placement === "transcriptEnd");
	const guest = liveGuest(view);
	// The live stream carries every branch; show the one ending at the leaf (after a rewind, the displayed leaf).
	const entries = useDisplayedEntries(view);
	const fallbacks = useMemo(() => modelFallbacks(entries), [entries]);
	const stream = guest?.stream ?? null;
	const streamDone = view.guest?.streamDone ?? true;
	const activeTools = guest?.activeTools ?? EMPTY_TOOLS;
	const uiRequest = guest?.uiRequest ?? null;
	const pendingQuestion = usePendingQuestion(session, uiRequest);

	// A stream present at first synchronization, or while reconnecting, is already in progress.
	// Keep its current text visible, then pace updates once the mirror is live.
	const previousGuestPhase = useRef<string | null>(null);
	const synchronized = stream !== null && streamNeedsSync(view.guest?.phase ?? null, previousGuestPhase.current);
	useEffect(() => {
		previousGuestPhase.current = view.guest?.phase ?? null;
	}, [view.guest?.phase]);

	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	const tail = tailStart(entries.length);
	const start = pinnedStart === null ? tail : Math.min(pinnedStart, tail);
	const visible = useMemo(() => entries.slice(start), [entries, start]);
	// What omp printed for typed slash commands, each after the entry that was last on screen when it was typed.
	const commandResults = useCommandResults(session);
	const room = roomKey(view);
	const placedResults = useMemo(
		() => placeResults(entries.map(entry => entry.id), start, commandResults, room),
		[entries, start, commandResults, room],
	);
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) if (entry.type === "message" && entry.message.role === "toolResult") map.set(entry.message.toolCallId, entry.message);
		return map;
	}, [visible]);
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) if (block.type === "toolCall") ids.add(block.id);
		}
		return ids;
	}, [entries]);
	// Tools omp started before their call was saved, as a reply of their own, so they group like any other call.
	const tailMessage = useMemo(() => unsavedToolsMessage(activeTools.values(), committedToolIds, stream), [activeTools, committedToolIds, stream]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const pinnedRef = useRef(true);
	const [unseen, setUnseen] = useState(false);
	/**
	 * The view just before a commit that moved the window's start: its `scrollTop`, and the row kept in place through
	 * the change (`anchorRow`) with its offset from the top of the view.
	 */
	const edgeRef = useRef<{ top: number; anchor: Element | undefined; offset: number } | null>(null);
	// Reveal state by message, so a streamed reply's saved entry continues the same reveal (`usePlayout`).
	const [playouts] = useState(() => new Map<number | string, Playout>());
	const outOfSight = useOutOfSight(rootRef);
	// Pinned to the bottom, the view follows new rows and the content column's own growth (a paced reply, an opening
	// card) in one eased write per frame. Scrolled up, it stays put.
	const follow = useScrollFollow(rootRef, pinnedRef, { content: contentRef, threshold: PINNED_PX, paused: outOfSight });

	const recordEdge = () => {
		const el = rootRef.current;
		if (!el) return;
		const view = el.getBoundingClientRect();
		const rows = [...el.querySelectorAll("[data-row]")];
		const anchor = rows[anchorRow(rows.map(row => row.getBoundingClientRect()), view.top, view.bottom)];
		edgeRef.current = { top: el.scrollTop, anchor, offset: anchor ? anchor.getBoundingClientRect().top - view.top : 0 };
	};

	// Every window change mounts or drops rows above the view. The row recorded before the commit goes back to where it
	// was; when rows drop, the browser's scroll anchoring usually has it there already, and then nothing is written. No
	// input is handled during a commit, so all the view moved since the record is the window's doing. The follow counts
	// that as layout, and a move up the reader made before the commit still unpins.
	useLayoutEffect(() => {
		const el = rootRef.current;
		const edge = edgeRef.current;
		edgeRef.current = null;
		if (!el || !edge) return;
		const drift = edge.anchor?.isConnected ? edge.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - edge.offset : 0;
		if (Math.abs(drift) >= 0.5) el.scrollTop += drift;
		follow.shift(el.scrollTop - edge.top);
	}, [follow, start]);

	const showEarlier = () => {
		if (start > 0) setPinnedStart(Math.max(0, start - WINDOW));
	};

	/** Jumps to the end asked for so far; each runs after the commit that brings the window back to the latest entries. */
	const [jumps, setJumps] = useState(0);
	const jumpToEnd = useCallback(() => {
		setUnseen(false);
		setPinnedStart(null);
		setJumps(count => count + 1);
	}, []);
	// After the window effect above, so the jump measures the rows the tail window draws and the follow has counted the
	// window change as layout.
	useLayoutEffect(() => {
		if (jumps > 0) follow.jumpToEnd();
	}, [follow, jumps]);
	// Something the user sent from this window that goes to omp at once (the composer, Send now, a slash or shell line;
	// `SessionController.noteSent`) brings the chat to its end, even from far up, and the reply that follows stays in
	// view. A message that only joins the queue, a queued one omp takes later and entries from anywhere else leave
	// the view where the reader put it.
	useEffect(
		() =>
			session.onEvent(event => {
				if (event.kind === "sent") jumpToEnd();
			}),
		[session, jumpToEnd],
	);

	// File and folder links in replies (`FileLinks`) open in the Files pane, unless the click ended a text selection in them.
	const openFileLink = (target: EventTarget) => {
		const link = target instanceof Element ? target.closest<HTMLElement>("[data-file-path]") : null;
		const path = link?.dataset.filePath;
		if (!link || !path) return false;
		const selection = window.getSelection();
		if (!selection?.isCollapsed && selection?.containsNode(link, true)) return true;
		openInFiles(session.projectPath, path, { focus: true, tabId: session.tabId });
		return true;
	};

	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		if (copyCode(event)) return;
		if (openFileLink(event.target)) {
			event.preventDefault();
			return;
		}
		const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
		if (!anchor) return;
		event.preventDefault();
		const href = anchor.getAttribute("href");
		if (href) void window.vomp.invoke("app:openExternal", href);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if ((event.key !== "Enter" && event.key !== " ") || !(event.target instanceof HTMLElement) || !event.target.dataset.filePath) return;
		event.preventDefault();
		openFileLink(event.target);
	};

	// Relative names in replies are looked up in the chat's folder, then in folders omp wrote or edited files in.
	const written = useMemo(() => writtenFolders(entries, session.projectPath).join("\0"), [entries, session.projectPath]);
	const home = useHomeDir();
	const fileRefScope = useMemo(
		() => ({ chat: session.tabId, bases: [session.projectPath, ...(written ? written.split("\0") : [])], home }),
		[session.tabId, session.projectPath, written, home],
	);

	// omp's first entries are session setup (model / thinking level); a chat is empty until someone talks.
	const hasMessages = entries.some(
		entry => (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) || entry.type === "custom_message",
	);
	const empty =
		!hasMessages &&
		fallbacks.size === 0 &&
		stream === null &&
		!view.working &&
		!uiRequest &&
		placedResults.top.length === 0 &&
		placedResults.after.size === 0 &&
		placedResults.end.length === 0 &&
		(view.mode === "live" || (view.mode === "starting" && !view.history));

	// Rows that arrive while the chat is open rise in. History (first render, a tab switch, an async load, an
	// earlier window mounting above) and a streamed reply turning into its saved entry stay at rest.
	const arrivalsRef = useRef<Arrivals>({ armed: false, seen: new Set(), streamed: false });
	const streaming = stream !== null;
	const loaded = hasMessages || empty;
	useEffect(() => {
		arrivalsRef.current = { armed: loaded, seen: new Set(visible.map(entry => entry.id)), streamed: streaming };
	}, [visible, loaded, streaming]);
	const arrivals = arrivalsRef.current;

	// How omp's work lays out turn by turn: step groups (Normal view; a step joins its group the moment it appears),
	// the board per turn, and the files each finished turn changed. Groups and summaries that appear while the chat is
	// open rise in; history renders at rest.
	const live = view.working || stream !== null;
	const grouped = mode === "normal";
	const laidOut = useMemo(() => liveLayoutEntries(entries, stream, tailMessage, grouped), [entries, stream, tailMessage, grouped]);
	// Rows and groups the reader is using keep their place until they let go, so a fold never takes one out from under
	// focus or an open output (`ToolCard` and `ToolGroup` report it).
	const [heldRows, hold] = useHeldSet();
	const [heldGroups, holdGroup] = useHeldSet();
	const [openGroups] = useState(() => new Map<string, boolean>());
	const [thoughts] = useState(() => new ThoughtChoices());
	const layout = useMemo(
		() =>
			transcriptLayout(laidOut, {
				live,
				group: grouped,
				context: { cwd: session.projectPath, home },
				active: activeTools,
				from: start,
				hold: heldRows,
				holdGroups: heldGroups,
			}),
		[laidOut, live, grouped, session.projectPath, home, start, heldRows, heldGroups, activeTools],
	);
	const shownWorkRef = useRef<{ live: boolean; grouped: boolean; start: number; keys: ReadonlySet<string> } | null>(null);
	const shownWork = shownWorkRef.current;
	const workKeys = useMemo(() => {
		const keys = new Set<string>();
		for (const entryLayout of layout.entries.values()) for (const plan of entryLayout.groups.values()) keys.add(plan.key);
		for (const id of layout.summaries.keys()) keys.add(`summary:${id}`);
		return keys;
	}, [layout]);
	// New work covers groups forming during a turn and summaries as it finishes. A window edge moving or the view
	// switching to Normal re-keys groups that were already there, so those commits render at rest.
	const forming = useMemo(() => {
		const keys = new Set<string>();
		const sameView = shownWork !== null && shownWork.grouped === grouped && shownWork.start === start;
		if (sameView && (shownWork.live || live) && arrivals.armed) for (const key of workKeys) if (!shownWork.keys.has(key)) keys.add(key);
		return keys;
	}, [workKeys, shownWork, live, grouped, start, arrivals.armed]);
	useEffect(() => {
		shownWorkRef.current = { live, grouped, start, keys: workKeys };
	}, [live, grouped, start, workKeys]);
	const liveThinking = useApp(state => state.prefs?.liveThinking ?? true);
	const agents = guest?.agents;
	const progress = guest?.progress;
	const lifecycle = guest?.lifecycle;
	const helpersMayRun = ompRunning(view);
	const helpers = useMemo(
		() => helpersByCall(agents && progress && lifecycle ? { agents, progress, lifecycle } : null, helpersMayRun),
		[agents, progress, lifecycle, helpersMayRun],
	);
	const recorded = useMemo(() => transcriptHelperStates(entries), [entries]);
	const pinned = usePinnedHelpers(view).ids;
	const synchronizingReplies = !arrivals.armed || Boolean(view.guest && streamNeedsSync(view.guest.phase, previousGuestPhase.current));
	const work = useMemo(
		(): WorkView => ({ layout, arriving: forming, openGroups, thoughts, helpers, pinned, recorded, ompRunning: helpersMayRun, hold, holdGroup, synchronizing: synchronizingReplies }),
		[layout, forming, openGroups, thoughts, helpers, pinned, recorded, helpersMayRun, hold, holdGroup, synchronizingReplies],
	);
	const openFile = (path: string) => openInFiles(session.projectPath, path, { focus: true, tabId: session.tabId });

	// New rows, stream updates and questions: follow when pinned, otherwise offer the jump. Until the chat has loaded
	// (and on that first loaded commit) the view goes straight to the bottom instead of gliding there.
	const settledRef = useRef(false);
	useEffect(() => {
		const el = rootRef.current;
		// A view exactly at the bottom (the content shrank, or never overflowed) is pinned whatever unpinned it earlier,
		// so "Show new activity" never offers a jump to where the reader already is, and the window follows the tail
		// again. A reader who scrolled up even a little stays where they are.
		if (!pinnedRef.current && el && el.scrollHeight - el.scrollTop - el.clientHeight <= 1) {
			pinnedRef.current = true;
			setPinnedStart(null);
		}
		if (!pinnedRef.current) {
			setUnseen(true);
			return;
		}
		setUnseen(false);
		if (settledRef.current) follow.follow();
		else {
			follow.snap();
			settledRef.current = loaded;
		}
	}, [follow, loaded, entries, stream, activeTools, uiRequest, view.working]);
	let lastSeen = -1;
	for (let index = visible.length - 1; index >= 0; index--) {
		if (arrivals.seen.has(visible[index]?.id ?? "")) {
			lastSeen = index;
			break;
		}
	}

	let seenUser = false;
	let previousAssistant: AssistantMessage | null = null;
	const rows: ReactNode[] = [];
	// Consecutive step-style notices share one flex child, so they stack like a tool group's rows instead of taking
	// the turn gap between each. Keyed by the run's first entry, so a notice joining the run keeps the others mounted.
	let run: { key: string; rows: ReactNode[] } | null = null;
	const endRun = () => {
		if (!run) return;
		rows.push(
			<div key={`run:${run.key}`} className="flex flex-col">
				{run.rows}
			</div>,
		);
		run = null;
	};
	// A result rises in only when it was just recorded, not when the chat remounts.
	const resultRows = (list: readonly CommandResultRecord[] | undefined) =>
		(list ?? []).map(result => (
			<Rise key={`result:${result.id}`} data-row play={Date.now() - result.createdAt < 1000} distance={6} tempo="snappy">
				<CommandResultRow result={result} onDismiss={() => dismissCommandResult(session, result.id)} />
			</Rise>
		));
	const pushResults = (list: readonly CommandResultRecord[] | undefined) => {
		if (!list?.length) return;
		endRun();
		rows.push(...resultRows(list));
		previousAssistant = null;
	};
	visible.forEach((entry, index) => {
		const isUser = (entry.type === "message" && entry.message.role === "user") || (entry.type === "custom_message" && entry.customType === "collab-prompt");
		if (isUser) seenUser = true;
		if (!rowShown(entry, mode, seenUser)) {
			pushResults(placedResults.after.get(entry.id));
			return;
		}
		const isAssistant = entry.type === "message" && entry.message.role === "assistant";
		const message = entry.type === "message" && entry.message.role === "assistant" ? entry.message : null;
		const continuesTurn = continuesAssistantModel(previousAssistant, message);
		previousAssistant = message;
		const arrived = arrivals.armed && index > lastSeen && !arrivals.seen.has(entry.id) && !(isAssistant && arrivals.streamed);
		const summary = layout.summaries.get(entry.id);
		const row = (
			<Rise key={entry.id} data-row play={arrived} distance={6} tempo="snappy" className={cn(continuesTurn && "-mt-6")}>
				<Row
					entry={entry}
					continuesTurn={continuesTurn}
					afterFirstPrompt={seenUser}
					results={results}
					active={activeTools}
					mode={mode}
					session={session}
					layout={layout.entries.get(entry.id)}
					work={work}
					fallback={fallbacks.get(entry.id)}
				/>
			</Rise>
		);
		if (entry.type === "custom_message" && entry.customType !== "collab-prompt" && noticeIsStep(parseNotice(entry))) {
			run ??= { key: entry.id, rows: [] };
			run.rows.push(row);
		} else {
			endRun();
			// Rows of one turn stack without the turn gap, so a run of tool calls reads as one list.
			rows.push(row);
		}
		if (summary) {
			endRun();
			rows.push(
				<Rise key={`summary:${entry.id}`} play={forming.has(`summary:${entry.id}`)} distance={6} tempo="snappy" className="-mt-4">
					<TurnSummary totals={summary} projectPath={session.projectPath} tabId={session.tabId} onOpen={openFile} />
				</Rise>,
			);
		}
		pushResults(placedResults.after.get(entry.id));
	});
	pushResults(placedResults.end);
	endRun();

	return (
		<TargetContextMenu projectPath={session.projectPath} tabId={session.tabId}>
		<div className="relative min-h-0 flex-1">
			<div
				ref={rootRef}
				onClick={onClick}
				onKeyDown={onKeyDown}
				onScroll={() => {
					const el = rootRef.current;
					if (!el) return;
					const wasPinned = pinnedRef.current;
					follow.onScroll();
					if (pinnedRef.current) setUnseen(false);
					const move = windowOnScroll({
						wasPinned,
						pinned: pinnedRef.current,
						held: pinnedStart !== null,
						nearTop: el.scrollTop <= EARLIER_TRIGGER_PX,
					});
					if (move.release) setPinnedStart(null);
					else if (move.hold) setPinnedStart(start);
					if (move.earlier) showEarlier();
				}}
				// Both gutters stay reserved, so the column keeps its width and stays centered over the composer as it overflows.
				className="absolute inset-0 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
				// Not live: the paced reveal would reach screen readers in fragments. `ReplyAnnouncer` speaks each finished reply once.
				role="log"
				aria-live="off"
			>
				<WindowEdge start={start} onBefore={recordEdge} />
				<PlayoutRegistry.Provider value={playouts}>
					<PlayoutPaused.Provider value={outOfSight}>
						<FileRefContext.Provider value={fileRefScope}>
							<div ref={contentRef} className="mx-auto flex min-h-full w-full max-w-(--chat-max) flex-col gap-6 px-6 pt-6 pb-4">
								{empty && <EmptyChat session={session} />}
								{start > 0 && (
									<Button variant="ghost" size="sm" className="self-center" onClick={showEarlier}>
										{t("showEarlier", { count: start })}
									</Button>
								)}
								{resultRows(placedResults.top)}
								{rows}
								{stream && (
									<Rise
										data-row
										play={arrivals.armed && !arrivals.streamed}
										distance={6}
										tempo="snappy"
										className={cn("flex flex-col gap-2", continuesAssistantModel(previousAssistant, stream) && "-mt-6")}
									>
										{!continuesAssistantModel(previousAssistant, stream) && <AssistantHeader model={stream.model} />}
										<AssistantBlocks
											message={stream}
											results={results}
											active={activeTools}
											pending={!streamDone}
											mode={mode}
											revealFromStart={arrivals.armed}
											synchronized={synchronized}
											liveThinking={liveThinking}
											layout={layout.entries.get(STREAM_ENTRY)}
											work={work}
										/>
									</Rise>
								)}
								{tailMessage && (
									<Rise data-row play={arrivals.armed} distance={4} tempo="snappy" className="-mt-6 flex flex-col">
										<AssistantBlocks
											message={tailMessage}
											results={results}
											active={activeTools}
											pending={false}
											mode={mode}
											layout={layout.entries.get(TAIL_ENTRY)}
											work={work}
										/>
									</Rise>
								)}
								<AnimatePresence initial={false} mode="wait">
									{pendingQuestion && (
										<motion.div
											key={pendingQuestion.key}
											initial={{ opacity: 0, y: 8 }}
											animate={{ opacity: 1, y: 0, transition: { y: spring.gentle, opacity: { duration: duration.base, ease: ease.outQuart } } }}
											exit={{ opacity: 0, y: -4, transition: { duration: duration.fast, ease: "easeIn" } }}
										>
											{pendingQuestion.node}
										</motion.div>
									)}
								</AnimatePresence>
								{slots.map(slot => (
									<slot.component key={slot.id} session={session} />
								))}
							</div>
						</FileRefContext.Provider>
					</PlayoutPaused.Provider>
				</PlayoutRegistry.Provider>
			</div>
			<ReplyAnnouncer
				entries={entries}
				stream={stream}
				active={activeTools}
				ready={view.guest ? view.guest.phase === "live" && view.guest.loading === null : view.history !== null}
				session={`${view.guest?.header?.id ?? view.history?.header?.id ?? session.tabId}:${view.displayLeaf ?? ""}`}
			/>
			<AnimatePresence initial={false}>
				{unseen && (
					<motion.div
						key="new-activity"
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 8 }}
						transition={spring.snappy}
						// Centered over the reading column, just above the composer, so it stays next to the text it refers to at any width.
						className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center"
					>
						<Button variant="primary" size="sm" icon={<ArrowDown />} className="pointer-events-auto shadow-(--shadow-pop)" onClick={jumpToEnd}>
							{t("newActivity")}
						</Button>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
		</TargetContextMenu>
	);
}
