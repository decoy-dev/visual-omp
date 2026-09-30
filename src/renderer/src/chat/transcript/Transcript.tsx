/**
 * The chat transcript (DESIGN §3.5, §4.6). Pairing, windowing and tail-follow follow omp's own
 * collab-web Transcript (transcript/Transcript.tsx); presentation is visual-omp's.
 */
import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ArrowDown, Bug, BookOpen, ChevronRight, Copy, GitFork, type LucideIcon, Paintbrush, Sparkles, Undo2 } from "lucide-react";
import { type MouseEvent, memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActiveTool } from "../../collab/lib/client";
import { getCommand } from "../../registry/commands";
import { chatSlots } from "../../registry/slots";
import type { SessionController, SessionView } from "../../state/session";
import { useApp } from "../../state/app";
import { Button, cn, IconButton, Mark, toast } from "../../ui";
import { useComposerDrafts } from "../composer/drafts";
import { QuestionCard } from "./QuestionCard";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export type TranscriptMode = "normal" | "thinking" | "verbose";

const WINDOW = 120;
const EARLIER_TRIGGER_PX = 240;
const EMPTY_TOOLS: ReadonlyMap<string, ActiveTool> = new Map();

function textOfContent(content: string | readonly (TextContent | ImageContent)[]): string {
	return typeof content === "string" ? content : content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

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
	const images = typeof content === "string" ? [] : content.filter((block): block is ImageContent => block.type === "image");
	const text = textOfContent(content);
	return (
		<>
			{images.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-2">
					{images.map((image, index) =>
						image.data.startsWith("blob:") ? null : (
							<img
								key={index}
								src={`data:${image.mimeType};base64,${image.data}`}
								alt=""
								className="size-12 rounded-md border border-border object-cover"
							/>
						),
					)}
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
				<span className="opacity-0 transition-opacity group-hover:opacity-100">{timeOf(entry.timestamp)}</span>
				<span className="font-medium text-fg-muted">{from ? t("from", { name: from }) : t("you")}</span>
			</div>
			<div className="max-w-[85%] rounded-lg rounded-br-sm border border-border-strong bg-inset px-4 py-3">
				<UserContent content={content} />
			</div>
			<div className="flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
				{getCommand("chat.rewindTo") && <IconButton label={t("rewind")} icon={<Undo2 />} size="sm" onClick={() => run("chat.rewindTo")} />}
				{getCommand("chat.forkFrom") && <IconButton label={t("fork")} icon={<GitFork />} size="sm" onClick={() => run("chat.forkFrom")} />}
				<IconButton
					label={t("copy")}
					icon={<Copy />}
					size="sm"
					onClick={() => void navigator.clipboard.writeText(textOfContent(content)).then(() => toast({ tone: "ok", message: t("copied") }))}
				/>
			</div>
		</div>
	);
}

function ThinkingBlock({ text, redacted, open: forcedOpen }: { text: string; redacted?: boolean; open: boolean }): ReactNode {
	const { t } = useTranslation("chat");
	const [open, setOpen] = useState(false);
	const visible = forcedOpen || open;
	return (
		<div>
			<button
				type="button"
				aria-expanded={visible}
				onClick={() => setOpen(value => !value)}
				className="flex items-center gap-1 rounded-sm text-sm text-fg-faint outline-none hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-ring"
			>
				<ChevronRight className={cn("size-3.5 transition-transform duration-(--dur-fast)", visible && "rotate-90")} aria-hidden />
				{redacted ? t("redactedThinking") : t("thoughtFor")}
			</button>
			{visible && !redacted && (
				<div className="selectable mt-1.5 rounded-md bg-inset py-2 pr-3 pl-3 text-sm whitespace-pre-wrap text-fg-muted shadow-[inset_2px_0_0_var(--agent)]">{text}</div>
			)}
		</div>
	);
}

function AssistantBlocks({
	message,
	results,
	active,
	pending,
	mode,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	pending: boolean;
	mode: TranscriptMode;
}): ReactNode {
	const { t } = useTranslation("chat");
	const lastText = message.content.reduce((last, block, index) => (block.type === "text" ? index : last), -1);
	const failed = !pending && (message.stopReason === "error" || message.stopReason === "aborted");
	return (
		<div className="flex flex-col gap-2.5">
			{message.content.map((block, index) => {
				switch (block.type) {
					case "thinking":
						return <ThinkingBlock key={index} text={block.thinking} open={mode !== "normal"} />;
					case "redactedThinking":
						return <ThinkingBlock key={index} text="" redacted open={false} />;
					case "text":
						return (
							<div key={index} className="relative">
								<Markdown text={block.text} />
								{pending && index === lastText && <span className="stream-caret" aria-hidden />}
							</div>
						);
					case "toolCall": {
						const live = active.get(block.id);
						const result = results.get(block.id);
						return (
							<ToolCard
								key={block.id}
								name={block.name}
								args={live?.args ?? block.arguments}
								intent={block.intent ?? live?.intent}
								result={result}
								running={!result && (live !== undefined || pending)}
								partialResult={live?.partialResult}
								verbose={mode === "verbose"}
							/>
						);
					}
					default:
						return null;
				}
			})}
			{failed && (
				<div className={cn("rounded-md px-3 py-2 text-md", message.stopReason === "error" ? "bg-err-bg text-err" : "bg-warn-bg text-warn")} role="status">
					<span className="font-medium">{message.stopReason === "error" ? `✕ ${t("stopped.error")}` : `▲ ${t("stopped.aborted")}`}</span>
					{message.errorMessage && <span className="selectable ml-2 text-fg-muted">{message.errorMessage}</span>}
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
}

function rowEqual(prev: RowProps, next: RowProps): boolean {
	if (prev.entry !== next.entry || prev.mode !== next.mode || prev.continuesTurn !== next.continuesTurn || prev.afterFirstPrompt !== next.afterFirstPrompt) return false;
	const entry = next.entry;
	if (entry.type !== "message" || entry.message.role !== "assistant") return true;
	for (const block of entry.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id) || prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const Row = memo(function Row({ entry, continuesTurn, afterFirstPrompt, results, active, mode, session }: RowProps): ReactNode {
	const { t } = useTranslation("chat");
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "user") return <UserMessage entry={entry} session={session} />;
			if (message.role !== "assistant") return null;
			return (
				<div className="flex flex-col gap-2">
					{!continuesTurn && <AssistantHeader model={message.model} timestamp={entry.timestamp} />}
					<AssistantBlocks message={message} results={results} active={active} pending={false} mode={mode} />
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
			return (
				<div className="rounded-md border border-border bg-inset px-3 py-2 text-sm text-fg-muted">
					<UserContent content={entry.content} />
				</div>
			);
		}
		case "compaction":
			return <Notice>{t("compacted")}</Notice>;
		case "branch_summary":
			return <Notice>{t("branchSummary")}</Notice>;
		case "model_change":
			return afterFirstPrompt || mode === "verbose" ? <Notice>{t("modelChanged", { model: entry.model })}</Notice> : null;
		case "thinking_level_change":
			return mode === "verbose" ? <Notice>{t("thinkingChanged", { level: entry.thinkingLevel ?? "off" })}</Notice> : null;
		default:
			return null;
	}
}, rowEqual);

const PROMPT_ICONS: Record<string, LucideIcon> = { bug: Bug, sparkles: Sparkles, book: BookOpen, broom: Paintbrush };

function EmptyChat({ session }: { session: SessionController }): ReactNode {
	const { t } = useTranslation("chat");
	// `returnObjects` yields the JSON array as authored in i18n/en/chat.json.
	const prompts = t("empty.prompts", { returnObjects: true }) as { icon: string; title: string; text: string }[];
	const returning = useApp(state => state.projects.some(project => project.sessionCount > 1));
	return (
		<div className="m-auto flex w-full max-w-[520px] flex-col items-center gap-5 py-16 text-center">
			<Mark size={44} />
			<div>
				<h2 className="text-2xl font-bold tracking-[-0.02em] text-fg">{returning ? t("empty.returning") : t("empty.first")}</h2>
				{!returning && <p className="mt-1 text-md text-fg-muted">{t("empty.tip")}</p>}
			</div>
			<div className="grid w-full grid-cols-2 gap-3">
				{prompts.map(prompt => {
					const Icon = PROMPT_ICONS[prompt.icon] ?? Sparkles;
					return (
						<button
							key={prompt.title}
							type="button"
							onClick={() => {
								useComposerDrafts.getState().setDraft(session.tabId, prompt.text);
								useComposerDrafts.getState().focus(session.tabId);
							}}
							className="flex h-[88px] flex-col items-start gap-1.5 rounded-lg border border-border bg-panel p-3 text-left transition-[translate,box-shadow] duration-(--dur-fast) outline-none hover:-translate-y-0.5 hover:shadow-(--shadow-card) focus-visible:outline-2 focus-visible:outline-ring"
						>
							<Icon className="size-5 text-accent" aria-hidden />
							<span className="text-md font-semibold text-fg">{prompt.title}</span>
							<span className="line-clamp-1 text-sm text-fg-muted">{prompt.text}</span>
						</button>
					);
				})}
			</div>
			<p className="text-sm text-fg-faint">{t("empty.hints")}</p>
		</div>
	);
}

export interface TranscriptProps {
	session: SessionController;
	view: SessionView;
	mode: TranscriptMode;
}

export function Transcript({ session, view, mode }: TranscriptProps): ReactNode {
	const { t } = useTranslation("chat");
	const slots = chatSlots.use().filter(slot => slot.placement === "transcriptEnd");
	const guest = view.guest;
	const live = guest !== null && guest.phase !== "connecting";
	const entries = live ? guest.entries : (view.history?.entries ?? []);
	const stream = live ? guest.stream : null;
	const streamDone = guest?.streamDone ?? true;
	const activeTools = live ? guest.activeTools : EMPTY_TOOLS;
	const uiRequest = live ? guest.uiRequest : null;

	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	const tailStart = Math.max(0, entries.length - WINDOW);
	const start = pinnedStart === null ? tailStart : Math.min(pinnedStart, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);
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
	const tailTools = useMemo(
		() =>
			[...activeTools.values()].filter(
				tool => !committedToolIds.has(tool.toolCallId) && !stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId),
			),
		[activeTools, committedToolIds, stream],
	);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	const [unseen, setUnseen] = useState(false);
	const prependRef = useRef<{ anchor: Element; offset: number } | null>(null);

	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		if (lockRef.current) el.scrollTop = el.scrollHeight;
		else setUnseen(true);
	}, [entries, stream, activeTools, uiRequest, view.working]);

	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (!el || !before) return;
		prependRef.current = null;
		if (before.anchor.isConnected) el.scrollTop += before.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
	}, [start]);

	const showEarlier = () => {
		const el = rootRef.current;
		if (!el || start === 0 || prependRef.current) return;
		const top = el.getBoundingClientRect().top;
		const first = el.querySelector("[data-row]");
		if (first) prependRef.current = { anchor: first, offset: first.getBoundingClientRect().top - top };
		setPinnedStart(Math.max(0, start - WINDOW));
	};

	const jumpToEnd = () => {
		const el = rootRef.current;
		if (!el) return;
		lockRef.current = true;
		setUnseen(false);
		setPinnedStart(null);
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	};

	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
		if (!anchor) return;
		event.preventDefault();
		const href = anchor.getAttribute("href");
		if (href) void window.vomp.invoke("app:openExternal", href);
	};

	const empty = entries.length === 0 && stream === null && !view.working && !uiRequest && (view.mode === "live" || (view.mode === "starting" && !view.history));
	let seenUser = false;
	let previousAssistant = false;

	return (
		<div className="relative min-h-0 flex-1">
			<div
				ref={rootRef}
				onClick={onClick}
				onScroll={() => {
					const el = rootRef.current;
					if (!el) return;
					lockRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
					if (lockRef.current) {
						setUnseen(false);
						if (pinnedStart !== null) setPinnedStart(null);
					} else if (pinnedStart === null) setPinnedStart(start);
					if (el.scrollTop <= EARLIER_TRIGGER_PX) showEarlier();
				}}
				className="absolute inset-0 overflow-y-auto"
				role="log"
				aria-live="polite"
				aria-relevant="additions"
			>
				<div className="mx-auto flex min-h-full w-full max-w-(--chat-max) flex-col gap-6 px-6 pt-6 pb-4">
					{empty && <EmptyChat session={session} />}
					{start > 0 && (
						<Button variant="ghost" size="sm" className="self-center" onClick={showEarlier}>
							{t("showEarlier", { count: start })}
						</Button>
					)}
					{visible.map(entry => {
						const isUser = (entry.type === "message" && entry.message.role === "user") || (entry.type === "custom_message" && entry.customType === "collab-prompt");
						const isAssistant = entry.type === "message" && entry.message.role === "assistant";
						const isResult = entry.type === "message" && entry.message.role === "toolResult";
						const continuesTurn = isAssistant && previousAssistant;
						if (isUser) seenUser = true;
						if (!isResult) previousAssistant = isAssistant;
						if (isResult) return null;
						return (
							<div key={entry.id} data-row>
								<Row
									entry={entry}
									continuesTurn={continuesTurn}
									afterFirstPrompt={seenUser}
									results={results}
									active={activeTools}
									mode={mode}
									session={session}
								/>
							</div>
						);
					})}
					{stream && (
						<div data-row className="flex flex-col gap-2">
							{!previousAssistant && <AssistantHeader model={stream.model} />}
							<AssistantBlocks message={stream} results={results} active={activeTools} pending={!streamDone} mode={mode} />
						</div>
					)}
					{tailTools.length > 0 && (
						<div data-row className="flex flex-col gap-2.5">
							{tailTools.map(tool => (
								<ToolCard
									key={tool.toolCallId}
									name={tool.toolName}
									args={tool.args}
									intent={tool.intent}
									running
									partialResult={tool.partialResult}
									verbose={mode === "verbose"}
								/>
							))}
						</div>
					)}
					{uiRequest && <QuestionCard key={uiRequest.reqId} session={session} request={uiRequest} />}
					{slots.map(slot => (
						<slot.component key={slot.id} session={session} />
					))}
				</div>
			</div>
			{unseen && (
				<Button variant="primary" size="sm" icon={<ArrowDown />} className="absolute right-6 bottom-3 shadow-(--shadow-pop)" onClick={jumpToEnd}>
					{t("newActivity")}
				</Button>
			)}
		</div>
	);
}
