import { describe, expect, it } from "vitest";
import type { AssistantMessage, CollabUiRequest, MessageEntry, WireMessage } from "@oh-my-pi/pi-wire";
import type { HostState } from "@shared/ipc";
import type { GuestSnapshot } from "../collab/lib/client";
import type { SessionView } from "./session";
import { continueEligible, supportsContinue } from "./continue";

const entry = (id: string, parentId: string | null, message: WireMessage): MessageEntry => ({
	type: "message", id, parentId, timestamp: "2026-11-10T12:00:00.000Z", message,
});
const assistant = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
	role: "assistant", content: [], model: "fixture", timestamp: 1, stopReason,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
});
const user = entry("user", null, { role: "user", content: [], timestamp: 0 });
const aborted = entry("aborted", "user", assistant("aborted"));
const composer: NonNullable<HostState["tspComposer"]> = {
	sendable: true, text: "", cursor: 0, ghost: "", editorId: "editor", surfaceId: "surface",
	queued: [], blockedBy: null,
};
const host: HostState = {
	hostId: "host", cwd: "/project", generation: 2, phase: "live", transport: "tsp",
	tspAvailability: { available: true, reason: null }, tspComposer: composer,
	link: null, sessionId: "session", sessionFile: null, pid: 1, exitCode: null,
	error: null, tui: null, cols: 80, rows: 24,
};
const guest = (patch: Partial<GuestSnapshot> = {}): GuestSnapshot => ({
	phase: "live", endedReason: null, header: null, entries: [user, aborted], state: null,
	agents: [], progress: new Map(), lifecycle: new Map(), stream: null, streamDone: false,
	activeTools: new Map(), backgroundTools: new Map(), working: false, readOnly: false,
	uiRequest: null, pendingUiRequests: [], notices: [], thinkingSelector: null, loading: null,
	...patch,
});
const view = (patch: Partial<SessionView> = {}): SessionView => ({
	mode: "live", host, guest: guest(), displayLeaf: null, history: null, queue: [], inputHistory: [],
	working: false, workingSince: null, readOnly: false, follow: null, ownerUnverified: false,
	carryover: null, strandedImages: false, error: null, ...patch,
});

describe("Continue eligibility", () => {
	it("allows a running turn, an aborted tail or an unanswered user prompt", () => {
		expect(continueEligible(view({ working: true }))).toBe(true);
		expect(continueEligible(view())).toBe(true);
		expect(continueEligible(view({ guest: guest({ entries: [user] }) }))).toBe(true);
	});
	it("rejects a completed or empty chat and follows the selected branch", () => {
		const done = entry("done", "user", assistant("stop"));
		expect(continueEligible(view({ guest: guest({ entries: [user, done] }) }))).toBe(false);
		expect(continueEligible(view({ guest: guest({ entries: [] }) }))).toBe(false);
		expect(continueEligible(view({ displayLeaf: "done", guest: guest({ entries: [user, done, aborted] }) }))).toBe(false);
	});
	it("allows an interrupted tool turn whose tail has no final assistant reply", () => {
		const call = entry("call", "user", assistant("toolUse"));
		const result = entry("result", "call", { role: "toolResult", toolCallId: "tool", toolName: "bash", content: [], isError: true, timestamp: 2 });
		expect(continueEligible(view({ guest: guest({ entries: [user, call, result] }) }))).toBe(true);
	});
	it.each([{ readOnly: true }, { strandedImages: true }, { mode: "history" }, { mode: "reconnecting" }] satisfies Partial<SessionView>[])("rejects unavailable chat state %j", patch => {
		expect(continueEligible(view(patch))).toBe(false);
	});
	it("refuses pending questions, native panels, queued native input and disconnected guests", () => {
		const request: CollabUiRequest = { reqId: 1, kind: "editor", title: "Question" };
		const guestPatches: Partial<GuestSnapshot>[] = [{ uiRequest: request }, { pendingUiRequests: [request] }, { phase: "ended" }, { readOnly: true }];
		for (const patch of guestPatches) {
			expect(continueEligible(view({ guest: guest(patch) }))).toBe(false);
		}
		const hostPatches: Partial<HostState>[] = [
			{ tspAvailability: { available: false, reason: "Question" } },
			{ tspComposer: { ...composer, queued: ["queued"] } },
			{ tspComposer: { ...composer, blockedBy: "approval" } },
		];
		for (const patch of hostPatches) {
			expect(continueEligible(view({ host: { ...host, ...patch } }))).toBe(false);
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
