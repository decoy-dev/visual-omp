import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { TspNode } from "@shared/tsp";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { isReplicatedRole, isUserRunNode, TSP_ROLES } from "@shared/tsp/roles";
import { region, walkNodes } from "@shared/tsp/view-state";
import type { PresentationTarget } from "../../state/tsp/presentation-claims";
import { stripAnsi } from "../../tool-render/util";
import { isExecutionMessage, type UserRun } from "./RunRow";

export interface NativeRun {
	target: PresentationTarget;
	node: Extract<TspNode, { k: "tool" }>;
	run: UserRun;
	/** An exact result occurrence in the displayed branch, when collab has delivered it. */
	entryId?: string;
}
interface RunOccurrence {
	/** Last saved execution already present when this node was first observed running. */
	afterEntryId?: string | null;
	entryId?: string;
}
export interface RunProjection {
	runs: readonly NativeRun[];
	scope: string | null;
	/** Retain assignments when nativeTail removes or reorders its nodes. */
	occurrences: ReadonlyMap<string, RunOccurrence>;
}
export function nativeRunOutput(node: TspNode): string {
	return [...walkNodes(node)].flatMap(child => child.k === "ansi" && child.p?.role?.endsWith(".output") ? [child.p.text ?? ""] : []).join("\n");
}

/** Native main includes deferred runs until collab can append them, plus retained copies after append. */
export function nativeRuns(snapshot: TspHostSnapshot | null, hostId: string | null, generation: number | undefined, entries: readonly SessionEntry[], previous?: RunProjection): RunProjection {
	const scope = snapshot ? JSON.stringify([snapshot.hostId, snapshot.generation, snapshot.epoch]) : null;
	const occurrences = new Map(previous?.scope === scope ? previous.occurrences : []);
	const runs: NativeRun[] = [];
	const projection: RunProjection = { runs, scope, occurrences };
	if (!snapshot || snapshot.hostId !== hostId || snapshot.generation !== generation || snapshot.documentGeneration !== generation || !snapshot.negotiated || snapshot.lifecycle !== "live") return projection;
	const saved = entries.flatMap(entry => entry.type === "message" && isExecutionMessage(entry.message) ? [{ entry, message: entry.message }] : []);
	const savedIndexes = new Map(saved.map(({ entry }, index) => [entry.id, index]));
	const reserved = new Set([...occurrences.values()].flatMap(item => item.entryId ? [item.entryId] : []));
	const candidates: { item: NativeRun; occurrence: RunOccurrence; entries: string[] }[] = [];
	const candidateCounts = new Map<string, number>();
	const visit = (node: TspNode, surfaceId: string) => {
		if (node.p?.hidden || isReplicatedRole(node.p?.role)) return;
		if (isUserRunNode(node)) {
			const p = node.p!;
			const kind = p.role === TSP_ROLES.userShell ? "shell" : "python";
			const excluded = p.badges?.some(badge => badge.text === "not sent") ?? false;
			const run: UserRun = { kind, source: p.command!, status: p.status as UserRun["status"], exitCode: p.exit ?? undefined, excluded };
			const key = JSON.stringify([surfaceId, node.id]);
			let occurrence = occurrences.get(key);
			if (!occurrence) {
				occurrence = run.status === "running" ? { afterEntryId: saved.at(-1)?.entry.id ?? null } : {};
				occurrences.set(key, occurrence);
			}
			const item: NativeRun = { target: { hostId: snapshot.hostId, epoch: snapshot.epoch, surfaceId, nodeId: node.id }, node, run };
			runs.push(item);
			if (occurrence.entryId) {
				// An established assignment remains reserved even if its saved row leaves this branch.
				if (savedIndexes.has(occurrence.entryId)) item.entryId = occurrence.entryId;
				return;
			}
			const output = stripAnsi(nativeRunOutput(node)).replace(/\n+$/, "");
			// If the boundary left the displayed branch, no entry here can prove it is newer.
			const boundary = occurrence.afterEntryId == null ? -1 : savedIndexes.get(occurrence.afterEntryId) ?? Number.POSITIVE_INFINITY;
			const eligible = saved.filter(({ entry, message }, index) => {
				if (reserved.has(entry.id) || index <= boundary || !!message.excludeFromContext !== excluded) return false;
				if (kind === "shell" ? message.role !== "bashExecution" || message.command !== run.source : message.role !== "pythonExecution" || message.code !== run.source) return false;
				// Collab may append the new occurrence before omp paints its final native frame.
				if (run.status === "running") return true;
				return stripAnsi(message.output).replace(/\n+$/, "") === output
					&& (message.cancelled ? "cancelled" : message.exitCode !== undefined && message.exitCode !== 0 ? "error" : "done") === run.status
					&& (run.exitCode === undefined || run.exitCode === message.exitCode);
			}).map(({ entry }) => entry.id);
			for (const id of eligible) candidateCounts.set(id, (candidateCounts.get(id) ?? 0) + 1);
			candidates.push({ item, occurrence, entries: eligible });
			return;
		}
		for (const child of node.c ?? []) visit(child, surfaceId);
	};
	for (const surface of snapshot.surfaces) {
		if (surface.documentGeneration !== generation || surface.closed || surface.suspended || surface.open.mode !== "inline") continue;
		for (const node of region(surface, "main")) visit(node, surface.open.id);
	}
	// Only a unique match in both directions establishes identity. Ambiguous output stays visible.
	for (const candidate of candidates) {
		const [id] = candidate.entries;
		if (id === undefined || candidate.entries.length !== 1 || candidateCounts.get(id) !== 1) continue;
		candidate.item.entryId = id;
		occurrences.set(JSON.stringify([candidate.item.target.surfaceId, candidate.item.target.nodeId]), { ...candidate.occurrence, entryId: id });
	}
	return projection;
}

/** Source and bounded output have shared run renderers; retain every other native detail. */
export function nativeRunBody(node: TspNode): TspNode[] {
	if (node.p?.role === "omp.tool.bash.command" || node.p?.role === "omp.tool.eval.input" || node.k === "ansi" && node.p?.role?.endsWith(".output")) return node.c?.flatMap(nativeRunBody) ?? [];
	return [{ ...node, ...(node.c ? { c: node.c.flatMap(nativeRunBody) } : {}) } as TspNode];
}
