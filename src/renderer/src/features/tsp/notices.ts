import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { TspNode, TspText } from "@shared/tsp";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { TSP_NOTICE_ROLES, TSP_ROLES } from "@shared/tsp/roles";
import { APP_GUEST_NAME, type Notice } from "../../collab/lib/client";
import { contentText } from "../../chat/transcript/notices";
import type { SavedParents } from "../../state/history";

/** omp's status toast for this app's own collab connection (`collab/host.ts` join and leave notices). */
const OWN_COLLAB_NOTICE = new RegExp(`^collab: ${APP_GUEST_NAME} (?:joined the collab session(?: \\(read-only\\))?|left the collab session)$`);

export interface TspNotice {
	id: string;
	anchor: string | null;
	/** Null until the current room's collab snapshot supplies its displayed branch. */
	turn: string | null;
	level: "info" | "warning" | "error";
	customType: "tsp-notice";
	content: string;
}
const text = (value: TspText | undefined): string => typeof value === "string" ? value : value?.filter(span => !span.s?.split(" ").includes("hide")).map(span => span.t).join("") ?? "";
const key = (turn: string, value: string) => JSON.stringify([turn, value.trim()]);
/** Arrival-time projection; collab remains the transcript authority. One instance belongs to one chat. */
export class TspNoticeProjection {
	#epoch: number | null = null;
	#generation: number | null = null;
	#rows = new Map<string, TspNotice>();
	#observed = new Map<string, string>();
	#collab = new Set<string>();
	#events = new Set<number>();
	#turn = "startup";
	#anchor: string | null = null;
	#authoritative = false;
	#snapshot: readonly TspNotice[] = [];
	getSnapshot = (): readonly TspNotice[] => this.#snapshot;

	reset(): void {
		this.#epoch = null; this.#generation = null; this.#rows.clear(); this.#observed.clear();
		this.#collab.clear(); this.#events.clear(); this.#turn = "startup"; this.#anchor = null; this.#snapshot = [];
		this.#authoritative = false;
	}

	/** A room/session change clears rows but remembers unchanged document nodes until omp replaces them. */
	rotate(): void {
		this.#rows.clear(); this.#collab.clear(); this.#events.clear(); this.#turn = "startup"; this.#anchor = null; this.#snapshot = [];
		this.#authoritative = false;
	}

	collab(entries: readonly SessionEntry[], notices: readonly Notice[], displayed: readonly SessionEntry[] = entries, saved?: SavedParents): void {
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		const turns = new Map<string, string>();
		for (const entry of entries) {
			if (entry.type !== "custom_message" || !entry.display || entry.customType === "collab-prompt") continue;
			let cursor: string | null = entry.id;
			const path: string[] = [];
			const visited = new Set<string>();
			let turn = "startup";
			while (cursor && !visited.has(cursor)) {
				visited.add(cursor); path.push(cursor);
				const cached = turns.get(cursor);
				if (cached) { turn = cached; break; }
				const ancestor = byId.get(cursor);
				if (ancestor && ((ancestor.type === "message" && ancestor.message.role === "user") || (ancestor.type === "custom_message" && ancestor.customType === "collab-prompt"))) { turn = ancestor.id; break; }
				if (ancestor) cursor = ancestor.parentId;
				else if (saved?.has(cursor)) cursor = saved.get(cursor) ?? null;
				else { turn = `unknown:${cursor}`; break; }
			}
			for (const id of path) turns.set(id, turn);
			this.#collab.add(key(turn, contentText(entry.content)));
		}
		this.#turn = displayed.findLast(entry => (entry.type === "message" && entry.message.role === "user") || (entry.type === "custom_message" && entry.customType === "collab-prompt"))?.id ?? "startup";
		this.#anchor = displayed.at(-1)?.id ?? null;
		this.#authoritative = true;
		for (const [id, row] of this.#rows) if (row.turn === null) this.#rows.set(id, { ...row, anchor: this.#anchor, turn: this.#turn });
		for (const notice of notices) if (!this.#events.has(notice.id)) {
			this.#events.add(notice.id);
			this.#collab.add(key(this.#turn, notice.message));
		}
		this.#publish();
	}

	apply(snapshot: TspHostSnapshot): void {
		if (this.#epoch !== snapshot.epoch) {
			this.#rows.clear(); this.#observed.clear(); this.#epoch = snapshot.epoch;
		}
		if (this.#generation !== null && this.#generation !== snapshot.generation) this.#rows.clear();
		this.#generation = snapshot.generation;
		if (snapshot.lifecycle !== "live" || !snapshot.negotiated) { this.#publish(); return; }
		for (const surface of snapshot.surfaces) {
			if (surface.closed || surface.suspended || surface.documentGeneration !== snapshot.generation) continue;
			const visit = (node: TspNode, region?: string) => {
				if (node.p?.hidden) return;
				region = node.id === "main" || node.id === "layer" || node.id === "dock" ? node.id : region;
				const level = node.p?.role ? TSP_NOTICE_ROLES[node.p.role] : undefined;
				if (level && (node.p?.role === TSP_ROLES.toastStatus || region === "main")) {
					let content = "";
					const collect = (part: TspNode) => {
						if (part.k === "text") content += text(part.p?.spans ?? part.p?.text);
						else if (part.k === "md" || part.k === "ansi" || part.k === "toast") content += part.p?.text ?? "";
						else if (part.k === "rows") content += part.p?.lines.join("\n") ?? "";
						part.c?.forEach(collect);
					};
					collect(node);
					const id = `tsp:${snapshot.epoch}:${surface.open.id}:${node.id}`;
					if (content.trim() && !(node.p?.role === TSP_ROLES.toastStatus && OWN_COLLAB_NOTICE.test(content.trim())) && this.#observed.get(id) !== content) {
						this.#observed.set(id, content);
						const previous = this.#rows.get(id);
						this.#rows.set(id, { id, anchor: previous && previous.turn !== null ? previous.anchor : this.#anchor, turn: this.#authoritative ? this.#turn : null, level, customType: "tsp-notice", content });
					}
					return;
				}
				node.c?.forEach(child => visit(child, region));
			};
			visit(surface.document);
		}
		this.#publish();
	}

	#publish(): void {
		const rows = [...this.#rows.values()].filter(row => row.turn !== null && !this.#collab.has(key(row.turn, row.content)));
		if (rows.length !== this.#snapshot.length || rows.some((row, index) => row !== this.#snapshot[index])) this.#snapshot = rows;
	}
}

/** Hidden anchors stay in their branch; anchors outside the displayed branch never become tail notices. */
export function placeTspNotices(entries: readonly SessionEntry[], start: number, notices: readonly TspNotice[]) {
	const indices = new Map(entries.map((entry, index) => [entry.id, index]));
	const top: TspNotice[] = [];
	const after = new Map<string, TspNotice[]>();
	for (const notice of notices) {
		if (notice.anchor === null) { if (start === 0) top.push(notice); continue; }
		const index = indices.get(notice.anchor);
		if (index === undefined || index < start) continue;
		const list = after.get(notice.anchor) ?? [];
		list.push(notice); after.set(notice.anchor, list);
	}
	return { top, after };
}
