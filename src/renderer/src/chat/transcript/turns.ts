/**
 * How the transcript lays out omp's work turn by turn: which runs of tool steps fold into one ToolGroup row, which
 * `todo` update shows the full board and which shrink to a one-line change, and the files each finished turn changed
 * for its TurnSummary. A step joins its group from the moment it appears, while it still runs too, so a run never
 * shows a step as its own row first and nothing changes shape when the turn ends. Pure, so the rules are tested apart
 * from the view.
 */
import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ActiveTool } from "../../collab/lib/client";
import { isModelFallback } from "../../collab/lib/modelFallback";
import { type EditTotals, editTotals, fileEdits, type OutputContext, type TodoUpdate, todoUpdates } from "../../features/panes/derive";
import { isRecord } from "../../tool-render/util";
import { resolveToolCall } from "../friendly";

export type ContentBlock = AssistantMessage["content"][number];

/** Visible assistant reply text, including provider narration encoded as thinking. */
export function replyText(block: ContentBlock): string | null {
	if (block.type === "text") return block.text;
	if (block.type === "thinking" && block.narration === true) return block.thinking;
	return null;
}

/** One content block of an assistant entry. */
export interface BlockRef {
	entryId: string;
	/** The message's own time, shared by a streamed reply and its saved entry. */
	messageTime: number;
	index: number;
	block: ContentBlock;
}

export interface ToolGroupPlan {
	/** The first call's id. */
	key: string;
	/** Tool calls and the thoughts between them, in order. */
	items: BlockRef[];
	calls: number;
	failed: number;
	/** The turn is still going and a call in the group has no result yet. */
	running: boolean;
	/** The first call's message time, when known: a running group counts its time from here. */
	startedAt: number | null;
	/** From the first call's message to the last result; null unless every timestamp is known and in order. */
	elapsedMs: number | null;
}

export interface EntryLayout {
	/** Block indices another row draws (inside a group led from an earlier block). */
	hidden: ReadonlySet<number>;
	/** Groups led from a block of this entry, by block index. */
	groups: ReadonlyMap<number, ToolGroupPlan>;
	/** Changes whenever what this entry draws changes; rows compare it to skip re-rendering. */
	sig: string;
}

export interface TodoRole {
	/** `board`: the turn's latest update, drawn as the full card. `change`: an earlier one, drawn as what it changed. */
	role: "board" | "change";
	update: TodoUpdate;
}

export interface TranscriptLayout {
	entries: ReadonlyMap<string, EntryLayout>;
	/** By `todo` call id. */
	todos: ReadonlyMap<string, TodoRole>;
	/** Edit totals of each finished turn that changed files, keyed by the turn's last assistant entry. */
	summaries: ReadonlyMap<string, EditTotals>;
}

export interface LayoutOptions {
	/** The last turn is still going (omp works or a reply streams in): its groups can run, and it gets no summary yet. */
	live: boolean;
	/** Fold runs of tool steps (Normal view). */
	group: boolean;
	/** Resolves relative paths, so one file edited by two names counts once. */
	context: OutputContext;
	/**
	 * Index in `entries` of the first entry the transcript draws (it windows long chats). Steps before it are not
	 * drawn, so no group reaches across that edge: a group whose first step lies above it would hide the rest.
	 */
	from?: number;
	/**
	 * Calls the reader is using (open, or focus inside), drawn as rows: one ends a run like a helper run does, so
	 * folding never takes it out from under them. Only rows outside a group report this.
	 */
	hold?: ReadonlySet<string>;
	/**
	 * Keys (first call ids) of groups the reader is using: each still starts its own group, so releasing a row before
	 * it never merges it into an earlier group and unmounts it.
	 */
	holdGroups?: ReadonlySet<string>;
}

/** Calls that always stay visible: helper runs and questions. The turn's latest board joins them. */
const PROMINENT: Record<string, true> = { task: true, ask: true };

interface Turn {
	slots: BlockRef[];
	/** Index in `entries` of each slot's entry. */
	positions: number[];
	callIds: string[];
	lastAssistant: string | null;
	/** A prompt follows it, so it is over even while omp works on the next one. */
	closed: boolean;
}

function isUserTurnStart(entry: SessionEntry): boolean {
	return (entry.type === "message" && entry.message.role === "user") || (entry.type === "custom_message" && entry.customType === "collab-prompt");
}

/** Layout ids of the reply streaming in and of tools omp started before their call was saved (`liveLayoutEntries`). */
export const STREAM_ENTRY = "live:stream";
export const TAIL_ENTRY = "live:tail";

/**
 * Tools omp started whose call is neither saved (`committed` call ids) nor in the reply streaming in, as one reply of
 * their own, so the layout groups them like any other call. Null when there are none.
 */
export function unsavedToolsMessage(active: Iterable<ActiveTool>, committed: ReadonlySet<string>, stream: AssistantMessage | null): AssistantMessage | null {
	const tools = [...active].filter(tool => !committed.has(tool.toolCallId) && !stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId));
	if (tools.length === 0) return null;
	return {
		role: "assistant",
		content: tools.map(tool => ({ type: "toolCall", id: tool.toolCallId, name: tool.toolName, arguments: isRecord(tool.args) ? tool.args : {}, intent: tool.intent })),
		model: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "toolUse",
		timestamp: tools[0]?.startedAt ?? 0,
	};
}

/**
 * What `transcriptLayout` reads in Normal view (`group`): the saved entries, then the reply streaming in
 * (`STREAM_ENTRY`) and the unsaved tools (`TAIL_ENTRY`), so a call joins its group as soon as omp starts writing or
 * running it, and keeps its group's key once saved. A reply without calls cannot change a group, so without calls or
 * unsaved tools the saved entries come back as they are (and the layout is not redone for each burst of text).
 */
export function liveLayoutEntries(
	entries: readonly SessionEntry[],
	stream: AssistantMessage | null,
	unsaved: AssistantMessage | null,
	group: boolean,
): readonly SessionEntry[] {
	if (!group || (!unsaved && !stream?.content.some(block => block.type === "toolCall"))) return entries;
	const extra: SessionEntry[] = [];
	if (stream) extra.push({ type: "message", id: STREAM_ENTRY, parentId: null, timestamp: "", message: stream });
	if (unsaved) extra.push({ type: "message", id: TAIL_ENTRY, parentId: null, timestamp: "", message: unsaved });
	return [...entries, ...extra];
}

export function transcriptLayout(entries: readonly SessionEntry[], options: LayoutOptions): TranscriptLayout {
	const results = new Map<string, ToolResultMessage>();
	const messageTime = new Map<string, number>();
	const turns: Turn[] = [];
	const groupBreaks = new Set<string>();
	let modelChanged = false;
	let turn: Turn | null = null;
	for (const [position, entry] of entries.entries()) {
		if (isUserTurnStart(entry)) {
			if (turn) turn.closed = true;
			turn = null;
			continue;
		}
		if (isModelFallback(entry)) modelChanged = true;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (!results.has(message.toolCallId)) results.set(message.toolCallId, message);
			continue;
		}
		if (message.role !== "assistant") continue;
		if (modelChanged && message.content.length > 0) {
			groupBreaks.add(entry.id);
			modelChanged = false;
		}
		if (!turn) {
			turn = { slots: [], positions: [], callIds: [], lastAssistant: null, closed: false };
			turns.push(turn);
		}
		turn.lastAssistant = entry.id;
		for (const [index, block] of message.content.entries()) {
			turn.slots.push({ entryId: entry.id, messageTime: message.timestamp, index, block });
			turn.positions.push(position);
			if (block.type === "toolCall") {
				turn.callIds.push(block.id);
				messageTime.set(block.id, message.timestamp);
			}
		}
	}

	const updates = new Map<string, TodoUpdate>();
	for (const update of todoUpdates(entries)) updates.set(update.callId, update);
	const edits = fileEdits(entries, options.context);
	const nameOf = (block: Extract<ContentBlock, { type: "toolCall" }>) => {
		const result = results.get(block.id);
		return resolveToolCall({
			name: block.name,
			args: block.arguments,
			result: result && { content: result.content, details: result.details, isError: result.isError },
			running: false,
		}).name;
	};

	const todos = new Map<string, TodoRole>();
	const hidden = new Map<string, Set<number>>();
	const groups = new Map<string, Map<number, ToolGroupPlan>>();
	const summaries = new Map<string, EditTotals>();

	for (const current of turns) {
		const boards = current.callIds.filter(id => updates.has(id));
		for (const [n, id] of boards.entries()) {
			const update = updates.get(id);
			if (update) todos.set(id, { role: n === boards.length - 1 ? "board" : "change", update });
		}
		const finished = current.closed || !options.live;
		if (finished && current.lastAssistant) {
			const totals = editTotals(edits, current.callIds);
			if (totals.files.length > 0) summaries.set(current.lastAssistant, totals);
		}
		if (!options.group) continue;

		let run: BlockRef[] = [];
		let between: BlockRef[] = [];
		const flush = () => {
			const calls = run.filter(ref => ref.block.type === "toolCall");
			if (calls.length > 0) {
				const ids = calls.map(ref => (ref.block.type === "toolCall" ? ref.block.id : ""));
				const leader = run[0];
				const start = messageTime.get(ids[0] ?? "");
				const plan: ToolGroupPlan = {
					key: ids[0] ?? leader.entryId,
					items: run,
					calls: calls.length,
					failed: ids.filter(id => results.get(id)?.isError === true).length,
					running: !finished && ids.some(id => !results.has(id)),
					startedAt: start !== undefined && Number.isFinite(start) && start > 0 ? start : null,
					elapsedMs: elapsedOf(ids, messageTime, results),
				};
				const leading = groups.get(leader.entryId) ?? new Map<number, ToolGroupPlan>();
				leading.set(leader.index, plan);
				groups.set(leader.entryId, leading);
				for (const ref of run.slice(1)) {
					const set = hidden.get(ref.entryId) ?? new Set<number>();
					set.add(ref.index);
					hidden.set(ref.entryId, set);
				}
			}
			run = [];
			between = [];
		};
		for (const [slot, ref] of current.slots.entries()) {
			if ((current.positions[slot] ?? 0) < (options.from ?? 0)) continue;
			if (ref.index === 0 && groupBreaks.has(ref.entryId)) flush();
			const block = ref.block;
			if (block.type === "toolCall") {
				const name = nameOf(block);
				if (PROMINENT[name] || todos.get(block.id)?.role === "board" || options.hold?.has(block.id)) {
					flush();
					continue;
				}
				// A group the reader is using keeps its first step, and so its key: the run before it ends there.
				if (options.holdGroups?.has(block.id)) flush();
				run.push(...between, ref);
				between = [];
			} else if (block.type === "fallback" || (replyText(block)?.trim() ?? "") !== "") {
				flush();
			} else if (run.length > 0) {
				// Thoughts and blank text between two calls fold in with them; trailing ones stay outside.
				between.push(ref);
			}
		}
		flush();
	}

	const todoMarks = new Map<string, string[]>();
	for (const current of turns) {
		for (const ref of current.slots) {
			const role = ref.block.type === "toolCall" ? todos.get(ref.block.id)?.role : undefined;
			if (role) todoMarks.set(ref.entryId, [...(todoMarks.get(ref.entryId) ?? []), `t${ref.index}:${role}`]);
		}
	}
	const layouts = new Map<string, EntryLayout>();
	for (const id of new Set([...hidden.keys(), ...groups.keys(), ...todoMarks.keys()])) {
		const hiddenSet = hidden.get(id) ?? new Set<number>();
		const groupMap = groups.get(id) ?? new Map<number, ToolGroupPlan>();
		const sig = [
			...[...hiddenSet].map(index => `h${index}`),
			...[...groupMap].map(
				([index, plan]) => `g${index}:${plan.key}:${plan.items.length}:${plan.failed}:${plan.running ? "r" : ""}:${plan.startedAt ?? ""}:${plan.elapsedMs ?? ""}`,
			),
			...(todoMarks.get(id) ?? []),
		].join(",");
		layouts.set(id, { hidden: hiddenSet, groups: groupMap, sig });
	}
	return { entries: layouts, todos, summaries };
}

/** Wall time of a group when every call has a result and the times run forward; otherwise unknown. */
function elapsedOf(ids: readonly string[], messageTime: ReadonlyMap<string, number>, results: ReadonlyMap<string, ToolResultMessage>): number | null {
	const start = messageTime.get(ids[0] ?? "");
	let end = 0;
	for (const id of ids) {
		const time = results.get(id)?.timestamp;
		if (time === undefined || !Number.isFinite(time) || time <= 0) return null;
		end = Math.max(end, time);
	}
	if (start === undefined || !Number.isFinite(start) || start <= 0 || end < start) return null;
	return end - start;
}
