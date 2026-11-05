import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { THINKING_LEVELS, type ThinkingLevel } from "./screen";

/**
 * The thinking selector the user chose. Both omp's classic status line and TSP effort node can
 * show Auto's resolved effort, and collab and display updates arrive independently. Prefer the
 * complete collab selector, then the latest thinking entry on this branch after a reconnect.
 */
export function configuredThinking(
	selector: string | null | undefined,
	entries: readonly SessionEntry[],
	displayed: ThinkingLevel | null,
): ThinkingLevel | null {
	const change = entries.findLast(entry => entry.type === "thinking_level_change");
	const recorded = change?.type === "thinking_level_change" ? (change.configured ?? change.thinkingLevel ?? null) : null;
	const selected = selector ?? recorded;
	return selected === null ? displayed : THINKING_LEVELS.find(level => level === selected) ?? null;
}

export interface ThinkingState {
	configured: ThinkingLevel | null;
	resolved: Exclude<ThinkingLevel, "auto"> | null;
	/** omp has selected Auto but has not reported a classifier result yet. */
	provisional: boolean;
}

export interface ThinkingEvent {
	thinkingLevel?: string;
	configured?: string;
	resolved?: string;
}

export interface ThinkingObservation {
	displayed: ThinkingLevel | null;
	lastDisplayed: ThinkingLevel | null;
	event: ThinkingEvent | null;
	stale: boolean;
}

/** A concrete-to-pending display transition starts a new Auto classification, even on the same model. */
export function observeThinking(
	previous: ThinkingObservation | null,
	displayed: ThinkingLevel | null,
	event: ThinkingEvent | null,
): ThinkingObservation {
	const sameEvent = previous?.event === event;
	const pendingTransition = displayed === "auto" && previous?.lastDisplayed != null && previous.lastDisplayed !== "auto";
	return {
		displayed,
		lastDisplayed: displayed ?? previous?.lastDisplayed ?? null,
		event,
		stale: sameEvent && (previous.stale || (event?.resolved !== undefined && pendingTransition)),
	};
}

interface SessionThinkingObservation {
	hostId: string | undefined;
	generation: number | undefined;
	observation: ThinkingObservation;
}
// Session ownership preserves invalidation when controls unmount or another consumer appears.
// Weak keys release it with the controller, without a second session lifetime.
const sessionObservations = new WeakMap<object, SessionThinkingObservation>();

export function observeSessionThinking(
	session: object,
	host: { hostId: string; generation: number } | null | undefined,
	displayed: ThinkingLevel | null,
	event: ThinkingEvent | null,
): ThinkingObservation {
	const saved = sessionObservations.get(session);
	const previous = saved?.hostId === host?.hostId && saved?.generation === host?.generation ? saved?.observation ?? null : null;
	if (previous && previous.displayed === displayed && previous.event === event) return previous;
	const observation = observeThinking(previous, displayed, event);
	sessionObservations.set(session, { hostId: host?.hostId, generation: host?.generation, observation });
	return observation;
}

export function thinkingState(
	selector: string | null | undefined,
	entries: readonly SessionEntry[],
	displayed: ThinkingLevel | null,
	event?: ThinkingEvent | null,
): ThinkingState {
	const configured = configuredThinking(selector, entries, displayed);
	if (configured !== "auto") return { configured, resolved: null, provisional: false };
	const effort = (value: string | null | undefined) => THINKING_LEVELS.find((level): level is Exclude<ThinkingLevel, "auto"> => level !== "auto" && level === value);
	// Only the classifier's event carries `resolved`. A selection event's thinkingLevel
	// can be a provisional default. TSP's `auto` and classic's pending glyph mean no pick.
	if (event?.configured === "auto" && event.resolved !== undefined) {
		return { configured, resolved: effort(event.resolved) ?? null, provisional: false };
	}
	if (displayed === "auto") return { configured, resolved: null, provisional: true };
	if (event?.configured === "auto") {
		return { configured, resolved: effort(displayed ?? event.thinkingLevel) ?? null, provisional: true };
	}
	const change = entries.findLast(entry => entry.type === "thinking_level_change");
	const recorded = change?.type === "thinking_level_change" && change.configured === "auto" ? change.thinkingLevel : null;
	return { configured, resolved: effort(displayed ?? recorded) ?? null, provisional: false };
}
