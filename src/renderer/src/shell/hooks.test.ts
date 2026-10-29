import type { AgentSnapshot, SubagentLifecyclePayload } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import type { GuestSnapshot } from "../collab/lib/client";
import type { SessionView } from "../state/session";
import { chatStatus } from "./hooks";

const agent = (id: string, status: AgentSnapshot["status"]): AgentSnapshot =>
	({ id, displayName: id, kind: "sub", status, hasSessionFile: true, createdAt: 0, lastActivity: 0 }) as AgentSnapshot;
const started = (id: string, status: SubagentLifecyclePayload["status"]): [string, SubagentLifecyclePayload] => [id, { id, agent: "task", status, index: 0 }];

/** An open chat on a running omp: `guest` patches omp's mirror (its turn, its question, its helpers). */
function view(guest: Partial<GuestSnapshot>, patch: Partial<SessionView> = {}): SessionView {
	return {
		mode: "live",
		working: false,
		readOnly: false,
		follow: null,
		guest: { agents: [], progress: new Map(), lifecycle: new Map(), uiRequest: null, ...guest } as GuestSnapshot,
		...patch,
	} as SessionView;
}

describe("chatStatus", () => {
	it("shows omp's own turn as working, with or without helpers", () => {
		expect(chatStatus(view({}, { working: true }))).toBe("working");
		expect(chatStatus(view({ agents: [agent("Atlas", "running")] }, { working: true }))).toBe("working");
	});

	it("keeps a chat whose turn ended working while a helper runs, then open once it finishes", () => {
		expect(chatStatus(view({ agents: [agent("Atlas", "running")] }))).toBe("helpersWorking");
		// Reported by the lifecycle channel alone, as a background spawn starts.
		expect(chatStatus(view({ lifecycle: new Map([started("Bolt", "started")]) }))).toBe("helpersWorking");
		expect(chatStatus(view({ agents: [agent("Atlas", "idle")], lifecycle: new Map([started("Atlas", "completed")]) }))).toBe("live");
	});

	it("puts a question first, even while helpers run", () => {
		const uiRequest = { reqId: 1 } as unknown as GuestSnapshot["uiRequest"];
		expect(chatStatus(view({ uiRequest, agents: [agent("Atlas", "running")] }))).toBe("needsInput");
		expect(chatStatus(view({ uiRequest, agents: [agent("Atlas", "running")] }, { working: true }))).toBe("needsInput");
	});

	it("shows no helper at work once omp is gone, whatever the mirror last recorded", () => {
		const running = { agents: [agent("Atlas", "running")], lifecycle: new Map([started("Bolt", "started")]) };
		expect(chatStatus(view(running, { mode: "exited" }))).toBe("idle");
		expect(chatStatus(view(running, { mode: "history" }))).toBe("idle");
		// A read-only follow whose other process let go of the file runs nothing either.
		expect(chatStatus(view(running, { mode: "history", readOnly: true, follow: { ownership: "free" } as SessionView["follow"] }))).toBe("idle");
	});

	it("never spins for helpers that finished, failed, stopped or wait parked for a follow-up", () => {
		const finished = {
			agents: [agent("Idle", "idle"), agent("Parked", "parked"), agent("Gone", "aborted")],
			lifecycle: new Map([started("Failed", "failed"), started("Done", "completed")]),
		};
		expect(chatStatus(view(finished))).toBe("live");
	});

	it("reads a chat without a mirror as saved", () => {
		expect(chatStatus(null)).toBe("idle");
		expect(chatStatus(view({}, { mode: "history", guest: null }))).toBe("idle");
	});
});

it("prioritizes OSC blocks and errors, without retaining them after omp exits", () => {
	const host = { programStatus: { state: "blocked", kind: "permission" } } as SessionView["host"];
	expect(chatStatus(view({}, { host, working: true }))).toBe("needsInput");
	const failed = { programStatus: { state: "error", msg: "Provider failed" } } as SessionView["host"];
	expect(chatStatus(view({}, { host: failed, working: true }))).toBe("error");
	expect(chatStatus(view({}, { host: failed, mode: "exited" }))).toBe("idle");
});
