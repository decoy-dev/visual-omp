import type { TspNode, TspText } from "../tsp";
import type { TspHostSnapshot } from "../tsp-host";
import { TSP_ROLES } from "./roles";
import { region, walkNodes } from "./view-state";

export interface ActivityHost { hostId: string; generation: number; tspEpoch?: number }

/**
 * omp's own progress for work it runs outside a model turn: the `omp.loader` row (for example
 * "Generating handoff…" during /handoff or "Creating worktree on …") and the `omp.working` row that
 * carries a progress child (for example "Compacting context…" during /compact). A model turn's
 * `omp.working` row has no progress child; collab reports that work instead.
 */
export interface OmpActivity {
	/** Host, generation, protocol epoch, surface and node, so a replacement process or a new run counts as new work. */
	key: string;
	/** omp's label without its keyboard hint, for example "Generating handoff…". */
	label: string;
}

/** Visible text, skipping icon glyphs such as the keycap in "(Esc to cancel)". */
function plain(spans: TspText | undefined): string {
	if (typeof spans === "string") return spans;
	return spans?.filter(span => !span.s?.split(" ").some(style => style === "icon" || style === "hide")).map(span => span.t).join("") ?? "";
}

function label(node: TspNode): string {
	const loader = node.p?.role === TSP_ROLES.loader;
	for (const child of walkNodes(node)) {
		const text = (child.k === "shimmer" || child.k === "text") && (loader || child.p?.role === TSP_ROLES.workingLabel)
			? plain(child.p?.spans ?? child.p?.text) : "";
		// omp appends a keyboard hint to a loader, such as " (Esc to cancel)"; the app offers Stop instead.
		const shown = text.replace(/\s*\([^()]*\)\s*$/, "").trim();
		if (shown) return shown;
	}
	return "";
}

/** The current activity of exactly this host process and protocol epoch; stale, closing or replaced documents have none. */
export function ompActivity(snapshot: TspHostSnapshot | null | undefined, host: ActivityHost | null | undefined): OmpActivity | null {
	if (!host || !snapshot || snapshot.hostId !== host.hostId || snapshot.generation !== host.generation
		|| snapshot.epoch !== host.tspEpoch || snapshot.lifecycle !== "live" || !snapshot.negotiated || snapshot.closing) return null;
	for (const surface of snapshot.surfaces) {
		if (surface.closed || surface.suspended || surface.documentGeneration !== host.generation) continue;
		for (const root of region(surface, "dock")) {
			for (const node of walkNodes(root)) {
				const role = node.p?.role;
				if (role !== TSP_ROLES.loader && !(role === TSP_ROLES.working && (node.c ?? []).some(child => child.k === "progress"))) continue;
				const text = label(node);
				if (text) return { key: [host.hostId, host.generation, snapshot.epoch, surface.open.id, node.id].join("\n"), label: text };
			}
		}
	}
	return null;
}

export interface ActivityRun { key: string; since: number }
/**
 * The run an activity belongs to, for its elapsed time: the same key continues the previous run, and any other key,
 * including one reused after a gap with no activity (the caller passes no previous run then), starts a new one.
 */
export function activityRun(previous: ActivityRun | undefined, activity: OmpActivity, now: number): ActivityRun {
	return previous?.key === activity.key ? previous : { key: activity.key, since: now };
}
