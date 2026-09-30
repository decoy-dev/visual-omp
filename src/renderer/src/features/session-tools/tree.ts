/**
 * The full entry tree of a saved omp session file (every branch, not just the active path), plus
 * the two projections the app needs:
 * - `selectorRows`: the row order of omp's `/tree` selector, so the app can move its cursor to an
 *   entry with Home + Down×n (tui `TreeSelectorComponent` + `TreeView`: DFS pre-order, children by
 *   timestamp with the branch holding the current leaf first, rows filtered flat).
 * - `layoutTree`: a horizontal map of the conversation for the navigator sheet.
 */
import { z } from "zod";
import { parseJsonl } from "../../collab/lib/jsonl";

export interface TreeEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	/** `user` / `assistant` / `toolResult` / … for `message` entries, else null. */
	role: string | null;
	/** Plain text of the entry (message text, compaction summary), trimmed; "" when none. */
	text: string;
	/** A user-authored turn (omp `isUserRequestEntry`): plain prompts, user skill or collab prompts. */
	userTurn: boolean;
	/** Assistant message that stopped with an error or abort (kept visible in `/tree`). */
	failed: boolean;
}

export interface SessionTree {
	entries: Map<string, TreeEntry>;
	children: Map<string | null, TreeEntry[]>;
	roots: TreeEntry[];
	/** omp's load rule: the leaf is the last entry in the file. */
	leafId: string | null;
}

const USER_CUSTOM_TYPES: Record<string, true> = { "collab-prompt": true, "skill-prompt": true };

const Content = z.union([
	z.string(),
	z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
]);
const RawEntry = z.looseObject({
	id: z.string(),
	parentId: z.string().nullish(),
	type: z.string(),
	timestamp: z.string().optional(),
	customType: z.string().optional(),
	attribution: z.string().optional(),
	content: Content.optional().catch(undefined),
	summary: z.string().optional().catch(undefined),
	message: z
		.looseObject({
			role: z.string(),
			content: Content.optional().catch(undefined),
			stopReason: z.string().optional().catch(undefined),
			customType: z.string().optional(),
			attribution: z.string().optional(),
		})
		.optional()
		.catch(undefined),
});

function textOf(content: z.infer<typeof Content> | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

export function parseSessionTree(jsonl: string): SessionTree {
	const { items } = parseJsonl(`${jsonl}\n`, "");
	const entries = new Map<string, TreeEntry>();
	const order: TreeEntry[] = [];
	for (const item of items) {
		const parsed = RawEntry.safeParse(item);
		if (!parsed.success || parsed.data.type === "session") continue;
		const raw = parsed.data;
		const message = raw.type === "message" ? raw.message : undefined;
		const role = message?.role ?? null;
		const customType = raw.type === "custom_message" ? raw.customType : message?.customType;
		const userCustom =
			(raw.type === "custom_message" || role === "custom") &&
			customType !== undefined &&
			USER_CUSTOM_TYPES[customType] === true &&
			(raw.attribution ?? message?.attribution) === "user";
		const stopReason = message?.stopReason;
		const text = message ? textOf(message.content) : raw.type === "custom_message" ? textOf(raw.content) : (raw.summary ?? "");
		const entry: TreeEntry = {
			id: raw.id,
			parentId: raw.parentId ?? null,
			type: raw.type,
			timestamp: raw.timestamp ?? "",
			role,
			text: text.trim(),
			userTurn: role === "user" || userCustom,
			failed: role === "assistant" && stopReason !== undefined && stopReason !== "stop" && stopReason !== "toolUse",
		};
		entries.set(entry.id, entry);
		order.push(entry);
	}
	const children = new Map<string | null, TreeEntry[]>();
	const roots: TreeEntry[] = [];
	for (const entry of order) {
		const parent = entry.parentId !== null && entry.parentId !== entry.id ? entries.get(entry.parentId) : undefined;
		if (!parent) {
			roots.push(entry);
			continue;
		}
		const siblings = children.get(parent.id);
		if (siblings) siblings.push(entry);
		else children.set(parent.id, [entry]);
	}
	for (const siblings of children.values()) siblings.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
	return { entries, children, roots, leafId: order.at(-1)?.id ?? null };
}

/** Entries from the root to `id`, root first. */
export function pathTo(tree: SessionTree, id: string | null): TreeEntry[] {
	const path: TreeEntry[] = [];
	const seen = new Set<string>();
	let cursor = id ? tree.entries.get(id) : undefined;
	while (cursor && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		path.push(cursor);
		cursor = cursor.parentId ? tree.entries.get(cursor.parentId) : undefined;
	}
	return path.reverse();
}

/** Children of `id` with the branch that contains `activePath` first (stable otherwise). */
function orderedChildren(tree: SessionTree, parent: TreeEntry | null, activePath: ReadonlySet<string>): TreeEntry[] {
	const list = parent ? (tree.children.get(parent.id) ?? []) : tree.roots;
	return [...list].sort((a, b) => Number(activePath.has(b.id)) - Number(activePath.has(a.id)));
}

/** `/tree` filter modes the app drives: `user` = Alt+U (user-only), `all` = Alt+A. */
export type SelectorMode = "user" | "all";

/** omp `/tree` rows in navigation order for a filter mode (see file header). */
export function selectorRows(tree: SessionTree, mode: SelectorMode, leafId: string | null = tree.leafId): TreeEntry[] {
	const active = new Set(pathTo(tree, leafId).map(entry => entry.id));
	const rows: TreeEntry[] = [];
	const stack = orderedChildren(tree, null, active).reverse();
	while (stack.length > 0) {
		const entry = stack.pop();
		if (!entry) break;
		// Assistant turns that only called tools are hidden in every mode unless they are the leaf.
		const hiddenAssistant = entry.role === "assistant" && entry.text === "" && !entry.failed && entry.id !== leafId;
		if (!hiddenAssistant && (mode === "all" || entry.userTurn)) rows.push(entry);
		stack.push(...orderedChildren(tree, entry, active).reverse());
	}
	return rows;
}

/** Leading text omp paints for an entry's `/tree` row, used to confirm the cursor landed on it. */
export function rowProbe(entry: TreeEntry): string | null {
	const firstLine = entry.text.split("\n").find(line => line.trim() !== "")?.replace(/\s+/g, " ").trim() ?? "";
	if (!firstLine || !entry.role) return null;
	return `${entry.role}: ${firstLine.slice(0, 24)}`;
}

// ─── Visual map ────────────────────────────────────────────────────────────

export type MapNodeKind = "user" | "assistant" | "summary";

export interface MapNode {
	id: string;
	kind: MapNodeKind;
	/** First words of the message. */
	label: string;
	text: string;
	timestamp: string;
	/** Column (conversation step) and lane (branch row). */
	column: number;
	lane: number;
	parentId: string | null;
	/** On the path to the current leaf. */
	active: boolean;
	/** The newest node on the active path (where the chat currently stands). */
	current: boolean;
	/** Entry id omp navigates to for this node (the message itself). */
	entryId: string;
}

export interface TreeMap {
	nodes: MapNode[];
	columns: number;
	lanes: number;
	/** More than one branch exists. */
	branched: boolean;
}

function mapKind(entry: TreeEntry): MapNodeKind | null {
	if (entry.userTurn) return "user";
	if (entry.role === "assistant" && (entry.text !== "" || entry.failed)) return "assistant";
	if (entry.type === "compaction" || entry.type === "branch_summary") return "summary";
	return null;
}

function firstWords(text: string, count: number): string {
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	return words.length > count ? `${words.slice(0, count).join(" ")}…` : words.join(" ");
}

/**
 * Collapse the entry tree to conversation nodes (user turns, assistant replies with text, summaries),
 * each hanging off its nearest shown ancestor, then lay it out left→right: the active branch runs
 * along lane 0 and every other branch drops to its own lane below its fork point.
 */
export function layoutTree(tree: SessionTree): TreeMap {
	const activePath = pathTo(tree, tree.leafId);
	const active = new Set(activePath.map(entry => entry.id));
	const shownChildren = new Map<string | null, TreeEntry[]>();
	const shownParent = new Map<string, string | null>();
	const visit = (entry: TreeEntry, shownAncestor: string | null): void => {
		const shown = mapKind(entry) !== null;
		if (shown) {
			shownParent.set(entry.id, shownAncestor);
			const list = shownChildren.get(shownAncestor);
			if (list) list.push(entry);
			else shownChildren.set(shownAncestor, [entry]);
		}
		for (const child of orderedChildren(tree, entry, active)) visit(child, shown ? entry.id : shownAncestor);
	};
	// Iterative-safe for deep chats: recursion depth equals conversation length, fine up to thousands.
	for (const root of orderedChildren(tree, null, active)) visit(root, null);

	const current = activePath.findLast(entry => mapKind(entry) !== null)?.id ?? null;
	const nodes: MapNode[] = [];
	let nextLane = 0;
	let columns = 0;
	const place = (entry: TreeEntry, column: number, lane: number): void => {
		const kind = mapKind(entry);
		if (!kind) return;
		columns = Math.max(columns, column + 1);
		nodes.push({
			id: entry.id,
			kind,
			label: kind === "summary" ? "" : firstWords(entry.text, 6),
			text: entry.text,
			timestamp: entry.timestamp,
			column,
			lane,
			parentId: shownParent.get(entry.id) ?? null,
			active: active.has(entry.id),
			current: entry.id === current,
			entryId: entry.id,
		});
		const kids = shownChildren.get(entry.id) ?? [];
		kids.forEach((child, index) => {
			if (index === 0) place(child, column + 1, lane);
			else place(child, column + 1, ++nextLane);
		});
	};
	const roots = shownChildren.get(null) ?? [];
	roots.forEach((root, index) => place(root, 0, index === 0 ? 0 : ++nextLane));
	return { nodes, columns, lanes: nextLane + 1, branched: nextLane > 0 };
}
