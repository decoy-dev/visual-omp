import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { FixtureDocuments, loadFixtureRecording } from "../tsp/testing/documents";
import { walkNodes } from "@shared/tsp/view-state";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { semanticThinkingEffort } from "./modelTsp";
import { parseStatusLine, type ThinkingLevel } from "./screen";
import { configuredThinking, observeThinking, thinkingState } from "./thinking";

const entry = (thinkingLevel: string | null, configured?: string | null): SessionEntry => ({ type: "thinking_level_change", id: "effort", parentId: null, timestamp: "", thinkingLevel, configured });

// Exercise the real readers for both presentations with omp's recorded composer tree.
function displayed(presentation: "classic" | "tsp", level: ThinkingLevel): ThinkingLevel | null {
	if (presentation === "classic") return parseStatusLine([` π ▶ ⬢ Model · ${level === "auto" ? "⟳ auto" : level} ▶─0%─`, "╰─ "])?.thinking ?? null;
	const docs = new FixtureDocuments();
	const recording = loadFixtureRecording("thinking-cycle");
	for (const message of recording.messages.slice(0, recording.inputs[0]!.afterMessage)) docs.receive({ verb: message.verb, body: JSON.stringify(message.body) });
	const document = structuredClone(docs.snapshot());
	const snapshot = { ...document, generation: 1, surfaces: document.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) } as TspHostSnapshot;
	for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) if (node.k === "effort") node.p = { ...node.p, level };
	return semanticThinkingEffort(snapshot);
}

describe.each(["classic", "tsp"] as const)("%s Auto effort", presentation => {
	it("keeps the configured selector separate from a reported Low effort", () => {
		const level = displayed(presentation, "low");
		expect(level).toBe("low");
		expect(thinkingState("auto", [], level)).toEqual({ configured: "auto", resolved: "low", provisional: false });
		expect(thinkingState("high", [entry("low", "auto")], level)).toEqual({ configured: "high", resolved: null, provisional: false });
	});
	it("does not present a startup default as a classifier result", () => {
		const pending = { configured: "auto", thinkingLevel: "high" };
		expect(thinkingState("auto", [entry("low", "auto")], displayed(presentation, "auto"), pending)).toEqual({ configured: "auto", resolved: null, provisional: true });
		expect(thinkingState("auto", [], displayed(presentation, "high"), pending)).toEqual({ configured: "auto", resolved: "high", provisional: true });
	});
	it("uses a newly received classifier result while an already-pending display catches up", () => {
		const pending = displayed(presentation, "auto");
		const previous = observeThinking(null, pending, null);
		const event = { configured: "auto", thinkingLevel: "low", resolved: "low" };
		const current = observeThinking(previous, pending, event);
		expect(current.stale).toBe(false);
		expect(thinkingState("auto", [], pending, current.stale ? null : current.event)).toEqual({ configured: "auto", resolved: "low", provisional: false });
	});
	it("invalidates the same-model result when omp reapplies Auto without another event", () => {
		const event = { configured: "auto", thinkingLevel: "high", resolved: "high" };
		const high = displayed(presentation, "high");
		let current = observeThinking(null, high, event);
		expect(thinkingState("auto", [], high, current.event).resolved).toBe("high");
		const pending = displayed(presentation, "auto");
		current = observeThinking(current, pending, event);
		expect(current.stale).toBe(true);
		expect(thinkingState("auto", [], pending, current.stale ? null : current.event)).toEqual({ configured: "auto", resolved: null, provisional: true });
		current = observeThinking(current, pending, event);
		expect(current.stale).toBe(true);
		// A new classifier result is accepted before the display catches up.
		current = observeThinking(current, pending, { ...event });
		expect(current.stale).toBe(false);
		expect(thinkingState("auto", [], pending, current.event).resolved).toBe("high");
	});
	it("shows pending when omp displays Auto after reconnect", () => {
		expect(thinkingState(null, [entry("high", "auto")], displayed(presentation, "auto"))).toEqual({ configured: "auto", resolved: null, provisional: true });
	});
});

it("uses only the latest branch entry and never invents an effort", () => {
	expect(thinkingState(null, [entry("low", "auto")], null)).toEqual({ configured: "auto", resolved: "low", provisional: false });
	expect(thinkingState(null, [entry("low", "auto"), entry("high", "high")], null)).toEqual({ configured: "high", resolved: null, provisional: false });
	expect(thinkingState("auto", [], null)).toEqual({ configured: "auto", resolved: null, provisional: false });
	expect(thinkingState("auto", [entry("unknown", "auto")], null).resolved).toBeNull();
	expect(configuredThinking("unsupported", [], "low")).toBeNull();
});
