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
