import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { HostState } from "@shared/ipc";
import type { SessionView } from "./session";
import { continueEligible, supportsContinue } from "./continue";

const entry = (id: string, parentId: string | null, role: string, stopReason?: string) => ({ type: "message", id, parentId, timestamp: "", message: { role, content: [], stopReason } }) as SessionEntry;
const user = entry("user", null, "user");
const aborted = entry("aborted", "user", "assistant", "aborted");
const host = { hostId: "host", generation: 2, phase: "live", transport: "tsp", tspAvailability: { available: true, reason: null }, tspComposer: { queued: [], blockedBy: null } } as unknown as HostState;
const view = (patch: Partial<SessionView> = {}) => ({ mode: "live", host, guest: { phase: "live", entries: [user, aborted] }, displayLeaf: null, history: null, ...patch }) as SessionView;

describe("Continue eligibility", () => {
	it("allows a running turn, an aborted tail or an unanswered user prompt", () => {
		expect(continueEligible(view({ working: true }))).toBe(true);
		expect(continueEligible(view())).toBe(true);
		expect(continueEligible(view({ guest: { phase: "live", entries: [user] } as SessionView["guest"] }))).toBe(true);
	});
	it("rejects a completed or empty chat and follows the selected branch", () => {
		const done = entry("done", "user", "assistant", "stop");
		expect(continueEligible(view({ guest: { phase: "live", entries: [user, done] } as SessionView["guest"] }))).toBe(false);
		expect(continueEligible(view({ guest: { phase: "live", entries: [] } as unknown as SessionView["guest"] }))).toBe(false);
		expect(continueEligible(view({ displayLeaf: "done", guest: { phase: "live", entries: [user, done, aborted] } as SessionView["guest"] }))).toBe(false);
	});
	it("allows an interrupted tool turn whose tail has no final assistant reply", () => {
		const call = entry("call", "user", "assistant", "toolUse");
		const result = entry("result", "call", "toolResult");
		expect(continueEligible(view({ guest: { phase: "live", entries: [user, call, result] } as SessionView["guest"] }))).toBe(true);
	});
	it.each([{ readOnly: true }, { strandedImages: true }, { mode: "history" }, { mode: "reconnecting" }] as Partial<SessionView>[])("rejects unavailable chat state %j", patch => {
		expect(continueEligible(view(patch))).toBe(false);
	});
	it("refuses pending questions, native panels, queued native input and disconnected guests", () => {
		for (const patch of [{ uiRequest: {} }, { pendingUiRequests: [{}] }, { phase: "ended" }, { readOnly: true }]) {
			expect(continueEligible(view({ guest: { phase: "live", entries: [user, aborted], ...patch } as SessionView["guest"] }))).toBe(false);
		}
		for (const patch of [{ tspAvailability: { available: false, reason: "Question" } }, { tspComposer: { queued: ["queued"], blockedBy: null } }, { tspComposer: { queued: [], blockedBy: "approval" } }]) {
			expect(continueEligible(view({ host: { ...host, ...patch } as HostState }))).toBe(false);
		}
	});
	it("requires classic editor inspection without overlays", () => {
		expect(continueEligible(view({ host: { ...host, transport: "classic", tui: null } }))).toBe(false);
		expect(continueEligible(view({ host: { ...host, transport: "classic", tui: { overlays: 0, focused: "Editor", altScreen: false, overlayKinds: [] } } }))).toBe(true);
	});
});

describe("Continue version gate", () => {
	it.each(["18.15.0", "18.18.1", "18.18.2-beta.1", "invalid"])("hides Continue for %s", ompVersion => {
		expect(supportsContinue({ modes: null, theme: null, ompVersion, asyncJobsGeneration: 2 }, view())).toBe(false);
	});
	it.each(["18.18.2", "18.18.6", "v18.18.7+test", "19.0.0"])("supports %s only in the matching host generation", ompVersion => {
		expect(supportsContinue({ modes: null, theme: null, ompVersion, asyncJobsGeneration: 2 }, view())).toBe(true);
		expect(supportsContinue({ modes: null, theme: null, ompVersion, asyncJobsGeneration: 1 }, view())).toBe(false);
	});
	expect(supportsContinue(null, view())).toBe(false);
});
