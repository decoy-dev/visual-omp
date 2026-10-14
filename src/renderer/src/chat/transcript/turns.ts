/**
 * How the transcript lays out omp's work turn by turn: which run of tool steps in a finished turn folds into one
 * ToolGroup row, which `todo` update shows the full board and which shrink to a one-line change, and the files each
 * finished turn changed for its TurnSummary. Pure, so the rules are tested apart from the view.
 */
import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { type EditTotals, editTotals, fileEdits, type OutputContext, type TodoUpdate, todoUpdates } from "../../features/panes/derive";
import { resolveToolCall } from "../friendly";

export type ContentBlock = AssistantMessage["content"][number];

/** One content block of an assistant entry. */
export interface BlockRef {
	entryId: string;
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
	/** The last turn is still going (omp works or a reply streams in), so it stays as it is. */
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
}

/** Calls that always stay visible: helper runs and questions. The turn's latest board joins them. */
const PROMINENT: Record<string, true> = { task: true, ask: true };

interface Turn {
	slots: BlockRef[];
	/** Index in `entries` of each slot's entry. */
	positions: number[];
	callIds: string[];
	lastAssistant: string | null;
}

function isUserTurnStart(entry: SessionEntry): boolean {
	return (entry.type === "message" && entry.message.role === "user") || (entry.type === "custom_message" && entry.customType === "collab-prompt");
}

export function transcriptLayout(entries: readonly SessionEntry[], options: LayoutOptions): TranscriptLayout {
	const results = new Map<string, ToolResultMessage>();
	const messageTime = new Map<string, number>();
	const turns: Turn[] = [];
	let turn: Turn | null = null;
	for (const [position, entry] of entries.entries()) {
		if (isUserTurnStart(entry)) {
			turn = null;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (!results.has(message.toolCallId)) results.set(message.toolCallId, message);
			continue;
		}
		if (message.role !== "assistant") continue;
		if (!turn) {
			turn = { slots: [], positions: [], callIds: [], lastAssistant: null };
			turns.push(turn);
		}
		turn.lastAssistant = entry.id;
		for (const [index, block] of message.content.entries()) {
			turn.slots.push({ entryId: entry.id, index, block });
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

	for (const [turnIndex, current] of turns.entries()) {
		const boards = current.callIds.filter(id => updates.has(id));
		for (const [n, id] of boards.entries()) {
			const update = updates.get(id);
			if (update) todos.set(id, { role: n === boards.length - 1 ? "board" : "change", update });
		}
		const finished = turnIndex < turns.length - 1 || !options.live;
		if (finished && current.lastAssistant) {
			const totals = editTotals(edits, current.callIds);
			if (totals.files.length > 0) summaries.set(current.lastAssistant, totals);
		}
		if (!finished || !options.group) continue;

		let run: BlockRef[] = [];
		let between: BlockRef[] = [];
		const flush = () => {
			const calls = run.filter(ref => ref.block.type === "toolCall");
			if (calls.length >= 2) {
				const ids = calls.map(ref => (ref.block.type === "toolCall" ? ref.block.id : ""));
				const leader = run[0];
				const plan: ToolGroupPlan = {
					key: ids[0] ?? leader.entryId,
					items: run,
					calls: calls.length,
					failed: ids.filter(id => results.get(id)?.isError === true).length,
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
			const block = ref.block;
			if (block.type === "toolCall") {
				const name = nameOf(block);
				if (PROMINENT[name] || todos.get(block.id)?.role === "board") {
					flush();
					continue;
				}
				run.push(...between, ref);
				between = [];
			} else if (block.type === "text" && block.text.trim() !== "") {
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
			...[...groupMap].map(([index, plan]) => `g${index}:${plan.key}:${plan.items.length}`),
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
