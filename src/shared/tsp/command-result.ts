import type { TspNode, TspText } from "../tsp";
import type { TspHostSnapshot } from "../tsp-host";
import { TSP_ROLES } from "./roles";

export interface CommandOutcomeSpec {
	success?: RegExp;
	errors?: readonly RegExp[];
	cancelled?: RegExp;
	/** A settled summary section with this completed heading is replicated by collab. */
	compaction?: RegExp;
	/** Status toasts that only restate a successful outcome; they are delivered with it, so no separate notice repeats them. */
	restates?: RegExp;
	quietMs?: number;
	elapsedMs?: number;
}
export interface CommandOutcome {
	status: "success" | "error" | "cancelled";
	lines: string[];
	nodes: { sf: string; id: string; text: string }[];
}

/** BTW starts and submissions are confirmed by their document, never by a quiet editor. */
export const BTW_COMMAND_OUTCOME: CommandOutcomeSpec = {
	errors: [/^(?:Cannot open \/btw history:|Could not save \/btw history:|Cannot inject \/btw prompt:|\/btw prompt not sent|No active model available for \/btw\.|A \/btw (?:question|action) is|This side conversation is unavailable|Wait for the current \/btw)/i],
};
const spans = (value: TspText | undefined): string => typeof value === "string" ? value : value?.filter(span => !span.s?.split(" ").includes("hide")).map(span => span.t).join("") ?? "";
/** Literal omp feedback, excluding icons and presentation properties. */
export function commandNodeText(node: TspNode): string {
	if (node.p?.hidden) return "";
	const own = node.k === "text" ? spans(node.p?.spans ?? node.p?.text)
		: node.k === "md" || node.k === "ansi" || node.k === "toast" ? node.p?.text ?? ""
		: node.k === "section" ? spans(node.p?.head) : "";
	return [own, ...(node.c?.map(commandNodeText) ?? [])].filter(Boolean).join("\n");
}
const matches = (pattern: RegExp, text: string): boolean => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(text);
function feedback(root: TspNode): TspNode[] {
	if (root.p?.hidden) return [];
	if (root.p?.role === TSP_ROLES.toastStatus || root.p?.role === TSP_ROLES.noticeError || root.k === "section" && root.p?.role === TSP_ROLES.compaction) return [root];
	return root.c?.flatMap(feedback) ?? [];
}
/** Only semantic output changes or a newly settled summary can complete the pinned command. */
export function commandOutcome(before: TspHostSnapshot, after: TspHostSnapshot, spec: CommandOutcomeSpec): CommandOutcome | null {
	if (before.hostId !== after.hostId || before.epoch !== after.epoch || before.generation !== after.generation || !after.negotiated || after.lifecycle !== "live" || after.closing) return null;
	const candidates: { node: TspNode; sf: string; text: string; completed: boolean }[] = [];
	for (const surface of after.surfaces) {
		if (surface.closed || surface.suspended || surface.documentGeneration !== after.generation) continue;
		const old = before.surfaces.find(item => item.open.id === surface.open.id);
		if (old && surface.sequence <= old.sequence) continue;
		const previous = new Map(old ? feedback(old.document).map(node => [node.id, JSON.stringify([node.k, node.p?.role, commandNodeText(node), node.k === "section" && old.settled.includes(node.id)])]) : []);
		for (const node of feedback(surface.document)) {
			const text = commandNodeText(node);
			const settled = node.k === "section" && surface.settled.includes(node.id);
			if (previous.get(node.id) === JSON.stringify([node.k, node.p?.role, text, settled])) continue;
			const completed = settled && !!spec.compaction && matches(spec.compaction, spans(node.p?.head))
				&& !!node.c?.some(child => child.k === "md" && child.p?.key === "summary" && !!child.p.text?.trim());
			if (text.trim()) candidates.push({ node, sf: surface.open.id, text, completed });
		}
	}
	const errors = candidates.filter(({ node, text }) => node.k !== "section" && spec.errors?.some(pattern => matches(pattern, text)));
	const cancelled = candidates.filter(({ node, text }) => node.k !== "section" && spec.cancelled && matches(spec.cancelled, text));
	const success = candidates.filter(({ node, text, completed }) => completed || node.p?.role === TSP_ROLES.toastStatus && spec.success && matches(spec.success, text));
	const selected = (errors.length ? errors : cancelled.length ? cancelled : success).slice(0, 1);
	const restated = !errors.length && !cancelled.length && selected.length && spec.restates
		? candidates.filter(({ node, text }) => node.p?.role === TSP_ROLES.toastStatus && matches(spec.restates!, text)) : [];
	if (selected.length) return {
		status: errors.length ? "error" : cancelled.length ? "cancelled" : "success",
		// Collab draws completed summaries. Their text never becomes a second command row.
		lines: selected.filter(({ completed }) => !completed).flatMap(item => item.text.split("\n")),
		nodes: [...selected, ...restated].map(({ node, sf, text }) => ({ sf, id: node.id, text })),
	};
	return spec.quietMs !== undefined && (spec.elapsedMs ?? 0) >= spec.quietMs && after.availability.available
		? { status: "success", lines: [], nodes: [] } : null;
}

/** Pinned command messages are contracts; unrelated failures and cancellations remain notices. */
export function commandOutcomeSpec(line: string): CommandOutcomeSpec | null {
	const command = line.trim().split(/\s+/, 1)[0]?.toLowerCase();
	switch (command) {
		case "/rename": return { success: /^Session renamed to .+\.$/, errors: [/^Rename failed:\s*\S/i] };
		case "/export": return { success: /^Session exported to:\s+\S/, errors: [/^Failed to export session:\s*\S/i] };
		case "/compact": return { errors: [/^Compaction failed:\s*\S/i], cancelled: /^Compaction cancelled\.?$/i, compaction: /^(?:Soft|Snap|Remote|Server)-compacted\b/i };
		case "/handoff": return { errors: [/^Handoff failed:\s*\S/i], cancelled: /^Handoff cancelled\.?$/i, compaction: /^Handed-off\b/i, restates: /^Session compacted \d+ times?$/ };
		case "/cleanse": return { success: /^Cleanse (?:complete|completed)\.?$/i, errors: [/^Cleanse failed:\s*\S/i], cancelled: /^Cleanse cancelled\.?$/i };
		case "/jobs": {
			const target = /^\/jobs\s+kill\s+(\S+)\s*$/i.exec(line.trim())?.[1];
			if (!target) return null;
			const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return target === "all"
				? { success: /^(?:Cancelled \d+ background jobs?|No running background jobs to cancel)\.$/, quietMs: 1500 }
				: { success: new RegExp(`^Cancelled background job ${escaped}\\.$`), errors: [new RegExp(`^No running background job with id "${escaped}"\\.$`), new RegExp(`^Could not cancel background job ${escaped}\\.$`)], quietMs: 1500 };
		}
		default: return null;
	}
}
