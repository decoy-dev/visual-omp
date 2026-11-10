import type { AssistantMessage, MessageEntry, SessionEntry } from "@oh-my-pi/pi-wire";
import type { HostStartOptions, HostState } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliver } from "../chat/composer/send";
import type { GuestSnapshot } from "../collab/lib/client";
import { useComposerDrafts } from "../chat/composer/drafts";
import { sendSlashCommand } from "../features/session-tools/typed";
import { pinSessionAccount } from "../features/session-tools/accounts";
import { LARGE_RESUME_BYTES, ResumeDeclinedError, type ResumeGuard, setResumeGuard } from "../registry/guards";
import { chatStatus } from "../shell/hooks";
import { toast } from "../ui/toast";
import type * as ToastModule from "../ui/toast";
import { liveEntries, liveGuest, SessionController, setSlashDelivery } from "./session";
import type * as SessionFiles from "./sessionFiles";
import { workInFlight } from "./chatWork";

// vi.mock is hoisted above the imports, so the controller under test builds these fakes.
const fakes = vi.hoisted(() => {
	const guests: FakeGuest[] = [];
	class FakeGuest {
		snapshot = { phase: "connecting", entries: [], notices: [] } as unknown as GuestSnapshot;
		readonly listeners = new Set<() => void>();
		constructor(readonly link: string) {
			guests.push(this);
		}
		subscribe(listener: () => void): () => void {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		}
		getSnapshot(): GuestSnapshot {
			return this.snapshot;
		}
		connect(): void {}
		close(): void {}
		setForeground(): void {}
		sendPrompt = vi.fn(async (_text: string, _images: unknown[], beforeSend?: () => void) => { beforeSend?.(); });
		sendAgentCmd = vi.fn(async (_cmd: string, _agentId: string, _text?: string) => {});
		settleAsyncWait(revision: number): void {
			if (!this.snapshot.awaitingAsyncWork || revision !== (this.snapshot.asyncWaitRevision ?? 0)) return;
			this.snapshot = { ...this.snapshot, awaitingAsyncWork: false };
			for (const listener of this.listeners) listener();
		}
		settleIdle(revision: number): void {
			if (revision !== this.snapshot.idleCheckRevision) return;
			this.snapshot = { ...this.snapshot, working: false, idleCheckRevision: undefined };
			for (const listener of this.listeners) listener();
		}
		/** What the real client publishes: `waiting` until omp's snapshot arrives, then `live`. */
		emit(phase: GuestSnapshot["phase"], entries: readonly SessionEntry[], working = false, extra: Partial<GuestSnapshot> = {}): void {
			this.snapshot = { phase, entries, working, uiRequest: null, agents: [], notices: [], progress: new Map(), lifecycle: new Map(), activeTools: new Map(), stream: null, ...extra } as unknown as GuestSnapshot;
			for (const listener of this.listeners) listener();
		}
	}
	/** A typed slash command's watch polls once, after this settles, and then ends (the command is done). */
	const watch = { end: Promise.withResolvers<void>() };
	return { FakeGuest, guests, watch };
});
vi.mock("../ui/toast", async importOriginal => ({ ...await importOriginal<typeof ToastModule>(), toast: vi.fn() }));
vi.mock("../collab/lib/client", () => ({ APP_GUEST_NAME: "visual-omp", GuestClient: fakes.FakeGuest }));
// typed.ts drives omp's painted screen; these stand-ins type the command and let the test end its watch.
vi.mock("../features/session-tools/drive", () => ({
	OmpBusyError: class OmpBusyError extends Error {},
	readScreen: async () => [],
	readyEditor: async () => [],
	reportFailure: () => undefined,
	sleep: () => fakes.watch.end.promise,
}));
vi.mock("../features/session-tools/results", () => ({
	addCommandResult: () => undefined,
	clearCommandResults: () => undefined,
	drawsRow: () => false,
	linesTone: () => "info",
	presentLines: (lines: string[]) => lines,
	roomKey: () => "room",
	startWatch: () => ({ replaced: false }),
	supersededResult: () => null,
	WATCH: { replacedPolls: 2 },
	watchStep: (state: unknown) => [state, { kind: "stop" }],
}));
vi.mock("../features/session-tools/screen", () => ({ parseStatusLine: () => ({}) }));
vi.mock("../features/session-tools/slash", () => ({
	routeSlash: async () => false,
	parseSlash: (line: string) => ({ name: line.trim().slice(1).split(/[\s:]/)[0], args: line.trim().replace(/^\/[^\s:]+[\s:]?/, "").trim() }),
}));
vi.mock("../features/palette/overlays", () => ({ isNativeOverlay: () => false }));
vi.mock("../features/palette/TerminalSheet", () => ({ autoOpened: { tabId: null } }));
vi.mock("../chat/branch", () => ({ displayedEntries: () => [] }));
vi.mock("./app", () => ({ useApp: { getState: () => ({ view: "home", terminalTabId: null, openTerminal: () => undefined }) } }));

const hostListeners = new Set<(state: HostState) => void>();
let savedText = "";
/** Application delivery calls, excluding submission receipts recorded separately below. */
let invoked: unknown[][] = [];
let submissionAcks: unknown[][] = [];
/** Answers for chosen `invoke` calls (a delayed paste, a failed submit); everything else resolves null. */
let respond: ((channel: string) => Promise<unknown> | undefined) | null = null;

beforeEach(() => {
	vi.mocked(toast).mockClear();
	fakes.guests.length = 0;
	fakes.watch.end = Promise.withResolvers<void>();
	hostListeners.clear();
	savedText = "";
	invoked = [];
	submissionAcks = [];
	respond = null;
	vi.stubGlobal("window", {
		vomp: {
			on: (channel: string, listener: (state: HostState) => void) => {
				if (channel !== "host:state") return () => undefined;
				hostListeners.add(listener);
				return () => hostListeners.delete(listener);
			},
			invoke: async (channel: string, ...args: unknown[]) => {
				if (channel === "sessions:read") return savedText;
				if (channel === "sessions:resolve") return (await respond?.(channel)) ?? args[0];
				if (channel === "composer:commands") return [];
				if (channel === "composer:isSideCommand") return false;
				if (channel === "host:ack-submission") submissionAcks.push([channel, ...args]);
				if (channel !== "sessions:find" && channel !== "host:tsp-snapshot" && channel !== "host:ack-submission") invoked.push([channel, ...args]);
				return (await respond?.(channel)) ?? null;
			},
		},
	});
});

/** The next `invoke` on `channel` rejects with `message`; later ones resolve as usual. */
function failOnce(channel: string, message: string): void {
	let failed = false;
	respond = asked => {
		if (asked !== channel || failed) return undefined;
		failed = true;
		return Promise.reject(new Error(message));
	};
}

const host = (patch: Partial<HostState>): HostState => ({
	hostId: "h1",
	cwd: "/p",
	phase: "live",
	link: null,
	generation: 1,
	sessionId: "s1",
	sessionFile: "/p/session.jsonl",
	pid: 1,
	exitCode: null,
	error: null,
	tui: null,
	cols: 80,
	rows: 24,
	...patch,
});
const sendHost = (patch: Partial<HostState>) => {
	for (const listener of hostListeners) listener(host(patch));
};
const message = (id: string, parentId: string | null, role: "user" | "assistant") =>
	({ type: "message", id, parentId, timestamp: "", message: { role, content: [] } }) as unknown as SessionEntry;
const ids = (entries: readonly SessionEntry[] | null) => entries?.map(entry => entry.id) ?? null;


describe("Continue editor action", () => {
	const assistant = (timestamp: number, stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
		role: "assistant", content: [], model: "fixture", timestamp, stopReason,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	});
	const ready = (working = true) => {
		const session = new SessionController({ tabId: "continue", projectPath: "/p", sessionFile: null });
		session.attach(host({ link: "L1", transport: "tsp", tspAvailability: { available: true, reason: null } }));
		const guest = fakes.guests[0]!;
		const aborted: MessageEntry = { type: "message", id: "a1", parentId: "u1", timestamp: "", message: assistant(0, "aborted") };
		guest.emit("live", [u1, aborted], working);
		respond = channel => channel === "native:snapshot" ? Promise.resolve({ modes: null, theme: null, ompVersion: "18.18.6", asyncJobsGeneration: 1 }) : undefined;
		invoked = [];
		return { session, guest };
	};
	it.each([true, false])("submits the shortcut through the immediate editor route while working=%s", async working => {
		const { session, guest } = ready(working);
		await session.continueTurn();
		expect(invoked).toEqual([["native:snapshot", "h1"], ["host:submit", "h1", ".", "steer"]]);
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(session.getSnapshot().inputHistory).toEqual([]);
		expect(session.getSnapshot().queue).toEqual([]);
	});
	it("refuses an older running engine before writing input", async () => {
		const { session } = ready();
		respond = channel => channel === "native:snapshot" ? Promise.resolve({ modes: null, theme: null, ompVersion: "18.18.1", asyncJobsGeneration: 1 }) : undefined;
		await expect(session.continueTurn()).rejects.toThrow("Continue is unavailable");
		expect(invoked).toEqual([["native:snapshot", "h1"]]);
	});
	it("does not consume an ask question as a literal model message", async () => {
		const { session, guest } = ready();
		guest.emit("live", [u1, a1], true, { uiRequest: { reqId: 1, kind: "select" } as GuestSnapshot["uiRequest"] });
		expect(session.canContinue).toBe(false);
		await expect(session.continueTurn()).rejects.toThrow("Continue is unavailable");
		expect(invoked).toEqual([]);
		expect(guest.sendPrompt).not.toHaveBeenCalled();
	});
	it("refuses a changed host while its version read is pending", async () => {
		const { session } = ready();
		const pending = Promise.withResolvers<unknown>();
		respond = channel => channel === "native:snapshot" ? pending.promise : undefined;
		const operation = session.continueTurn();
		sendHost({ link: "L2", generation: 2 });
		pending.resolve({ modes: null, theme: null, ompVersion: "18.18.6", asyncJobsGeneration: 1 });
		await expect(operation).rejects.toThrow("Continue is unavailable");
		expect(invoked.some(([channel]) => channel === "host:submit")).toBe(false);
	});
	it("rejects repeated activation and holds queued input until the continued turn starts", async () => {
		const { session, guest } = ready(false);
		const pending = Promise.withResolvers<unknown>();
		respond = channel => channel === "native:snapshot" ? pending.promise : undefined;
		const operation = session.continueTurn();
		await expect(session.continueTurn()).rejects.toThrow("Continue is unavailable");
		await session.send("Next message");
		expect(session.getSnapshot().queue).toHaveLength(1);
		pending.resolve({ modes: null, theme: null, ompVersion: "18.18.6", asyncJobsGeneration: 1 });
		await operation;
		expect(invoked.filter(([channel]) => channel === "host:submit")).toHaveLength(1);
		guest.emit("live", [u1, a1], true);
		expect(session.getSnapshot().queue).toHaveLength(1);
	});
	it("keeps queued input held across a running Continue's interruption gap", async () => {
		const { session, guest } = ready(true);
		await session.send("Next message");
		await session.continueTurn();
		expect(invoked.filter(([channel]) => channel === "host:submit")).toHaveLength(1);
		guest.emit("live", [u1, a1], false);
		expect(session.getSnapshot().queue).toHaveLength(1);
		expect(invoked.filter(([channel]) => channel === "host:submit")).toHaveLength(1);
		guest.emit("live", [u1, a1], true);
		expect(session.getSnapshot().queue).toHaveLength(1);
		guest.emit("live", [u1, a1], false);
		await vi.waitFor(() => expect(invoked.filter(([channel]) => channel === "host:submit")).toHaveLength(2));
		expect(invoked.find(([, , text]) => text === "Next message")).toEqual(["host:submit", "h1", "Next message", "steer", undefined, expect.any(String)]);
	});
	it.each([false, true])("acknowledges a newer assistant request while working stays true (during submit=%s)", async duringSubmit => {
		const { session, guest } = ready(true);
		const original = { type: "message", id: "a1", parentId: "u1", timestamp: "", message: assistant(100, "aborted") } satisfies MessageEntry;
		const resumed = { ...original, id: "resumed", message: { ...original.message, timestamp: 200, stopReason: "stop" } } satisfies MessageEntry;
		guest.emit("live", [u1], true, { stream: assistant(100, "aborted") });
		await session.send("Next message");
		const submitted = Promise.withResolvers<unknown>();
		respond = channel => channel === "native:snapshot"
			? Promise.resolve({ modes: null, theme: null, ompVersion: "18.18.6", asyncJobsGeneration: 1 })
			: channel === "host:submit" ? submitted.promise : undefined;
		const operation = session.continueTurn();
		await vi.waitFor(() => expect(invoked.some(([, , text]) => text === ".")).toBe(true));
		// A late saved copy of the interrupted assistant is not a resumed request.
		guest.emit("live", [u1, original], true, { stream: assistant(100, "aborted") });
		if (duringSubmit) guest.emit("live", [u1, original], true, { stream: assistant(200, "stop") });
		submitted.resolve(null);
		await operation;
		expect(invoked.filter(([channel]) => channel === "host:submit")).toHaveLength(1);
		if (!duringSubmit) {
			expect(session.canContinue).toBe(false);
			guest.emit("live", [u1, original], true, { stream: assistant(200, "stop") });
		}
		expect(session.getSnapshot().queue).toHaveLength(1);
		respond = null;
		guest.emit("live", [u1, original, resumed], false);
		await vi.waitFor(() => expect(invoked.filter(([channel]) => channel === "host:submit")).toHaveLength(2));
	});
});
it("reports a failed helper Stop instead of silently ignoring a closed guest", async () => {
	const session = new SessionController({ tabId: "helper-stop", projectPath: "/p", sessionFile: null });
	session.attach(host({ link: "ws://localhost/r/room.key", transport: "tsp" }));
	const guest = fakes.guests[0]!;
	guest.emit("ended", []);
	guest.sendAgentCmd.mockRejectedValueOnce(new Error("The chat connection ended. Restart omp and try again."));
	session.agentCommand("kill", "Atlas");
	await vi.waitFor(() => expect(toast).toHaveBeenCalledWith({ tone: "err", message: expect.stringContaining("Restart omp") }));
	expect(guest.sendAgentCmd).toHaveBeenCalledWith("kill", "Atlas", undefined);
});

it("reports helper Stop when there is no guest connection", () => {
	const session = new SessionController({ tabId: "no-helper-guest", projectPath: "/p", sessionFile: null });
	session.agentCommand("kill", "Atlas");
	expect(toast).toHaveBeenCalledWith({ tone: "err", message: expect.stringContaining("connection is unavailable") });
});

const u1 = message("u1", null, "user");
const a1 = message("a1", "u1", "assistant");
const u2 = message("u2", "a1", "user");
const userPrompt = (id: string, text: string, images = 0, synthetic = false): SessionEntry =>
	({
		...message(id, "u1", "user"),
		message: { role: "user", content: [{ type: "text", text }, ...Array.from({ length: images }, () => ({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }))], synthetic },
	}) as unknown as SessionEntry;

describe("SessionController room handoff", () => {
	it("keeps a chat's messages on screen while the room after /restart loads, then shows the new room", () => {
		const session = new SessionController({ tabId: "t1", projectPath: "/p", sessionFile: null });
		session.attach(host({ link: "L1" }));
		fakes.guests[0]?.emit("live", [u1, a1]);
		sendHost({ phase: "restarting", link: null });
		sendHost({ phase: "live", link: "L2", generation: 2 });
		fakes.guests[1]?.emit("waiting", []);
		expect(ids(liveEntries(session.getSnapshot()))).toEqual(["u1", "a1"]);
		// The carried transcript is display only: nothing from the old room can be answered.
		expect(liveGuest(session.getSnapshot())).toBeNull();
		fakes.guests[1]?.emit("live", [u1, a1, u2]);
		expect(ids(liveEntries(session.getSnapshot()))).toEqual(["u1", "a1", "u2"]);
		expect(session.getSnapshot().carryover).toBeNull();
	});

	it("shows an empty chat once the room after /new has synced", () => {
		const session = new SessionController({ tabId: "t2", projectPath: "/p", sessionFile: null });
		session.attach(host({ link: "L1" }));
		fakes.guests[0]?.emit("live", [u1, a1]);
		sendHost({ phase: "live", link: "L2", generation: 2 });
		fakes.guests[1]?.emit("waiting", []);
		fakes.guests[1]?.emit("live", []);
		expect(ids(liveEntries(session.getSnapshot()))).toEqual([]);
		expect(session.getSnapshot().carryover).toBeNull();
	});

	it("carries a resumed chat's newer live turns, not the older saved file", async () => {
		savedText = JSON.stringify(u1);
		const session = new SessionController({ tabId: "t3", projectPath: "/p", sessionFile: "/p/session.jsonl" });
		await session.loadHistory();
		session.attach(host({ link: "L1" }));
		fakes.guests[0]?.emit("live", [u1, a1, u2]);
		sendHost({ phase: "live", link: "L2", generation: 2 });
		fakes.guests[1]?.emit("waiting", []);
		expect(ids(session.getSnapshot().history?.entries ?? null)).toEqual(["u1"]);
		expect(ids(liveEntries(session.getSnapshot()))).toEqual(["u1", "a1", "u2"]);
	});

	it("keeps the saved history on screen while the first room of a resumed chat loads", async () => {
		savedText = [u1, a1].map(entry => JSON.stringify(entry)).join("\n");
		const session = new SessionController({ tabId: "t4", projectPath: "/p", sessionFile: "/p/session.jsonl" });
		await session.loadHistory();
		session.attach(host({ link: "L1" }));
		fakes.guests[0]?.emit("waiting", []);
		expect(liveEntries(session.getSnapshot())).toBeNull();
		fakes.guests[0]?.emit("live", [u1, a1, u2]);
		expect(ids(liveEntries(session.getSnapshot()))).toEqual(["u1", "a1", "u2"]);
	});
});

describe("saved continuation history", () => {
	it("opens the newest linked file before reading saved history", async () => {
		savedText = JSON.stringify(u1);
		respond = channel => channel === "sessions:resolve" ? Promise.resolve("/p/newest.jsonl") : channel === "sessions:ownership" ? Promise.resolve("free") : undefined;
		const session = new SessionController({ tabId: "continued", projectPath: "/p", sessionFile: "/p/old.jsonl" });
		await session.loadHistory();
		expect(session.sessionFile).toBe("/p/newest.jsonl");
		expect(ids(session.getSnapshot().history?.entries ?? null)).toEqual(["u1"]);
	});

	it("ignores ownership from an old file after the saved view resolves a continuation", async () => {
		const oldOwnership = Promise.withResolvers<string>();
		let ownershipCalls = 0;
		respond = channel => {
			if (channel === "sessions:resolve") return Promise.resolve("/p/newest.jsonl");
			if (channel === "sessions:ownership") return ownershipCalls++ === 0 ? oldOwnership.promise : Promise.resolve("free");
			return undefined;
		};
		const session = new SessionController({ tabId: "ownership-race", projectPath: "/p", sessionFile: "/p/old.jsonl" });
		const pending = session.checkOwnership();
		await session.loadHistory();
		oldOwnership.resolve("elsewhere");
		await pending;
		await Promise.resolve();
		expect(session.getSnapshot().readOnly).toBe(false);
		expect(session.sessionFile).toBe("/p/newest.jsonl");
	});

	it("drops a predecessor's read-only follow when its continuation is free", async () => {
		let ownershipCalls = 0;
		respond = channel => {
			if (channel === "sessions:resolve") return Promise.resolve("/p/newest.jsonl");
			if (channel === "sessions:ownership") return Promise.resolve(ownershipCalls++ === 0 ? "elsewhere" : "free");
			return undefined;
		};
		const session = new SessionController({ tabId: "followed-predecessor", projectPath: "/p", sessionFile: "/p/old.jsonl" });
		await session.checkOwnership();
		expect(session.getSnapshot().readOnly).toBe(true);
		await session.loadHistory();
		await session.checkOwnership();
		expect(session.getSnapshot().readOnly).toBe(false);
		expect(session.getSnapshot().follow).toBeNull();
	});
});

describe("unreadable session ownership", () => {
	it("keeps an unverified Windows lease read-only and refuses Continue here", async () => {
		respond = channel => channel === "sessions:ownership" ? Promise.resolve("unknown") : undefined;
		const session = new SessionController({ tabId: "unknown-lease", projectPath: "/p", sessionFile: "/p/source.jsonl" });
		await session.checkOwnership();
		expect(session.getSnapshot().readOnly).toBe(true);
		expect(session.getSnapshot().follow?.ownership).toBe("unknown");
		expect(session.getSnapshot().ownerUnverified).toBe(false);
		expect(await session.continueHere()).toBe(false);
		expect(invoked.some(call => call[0] === "host:start")).toBe(false);
	});
});

describe("SessionController working start", () => {
	it("times a turn it saw start, keeps the time across updates, and has none for a turn under way at join", () => {
		vi.spyOn(Date, "now").mockReturnValue(5000);
		const session = new SessionController({ tabId: "t5", projectPath: "/p", sessionFile: null });
		session.attach(host({ link: "L1" }));
		fakes.guests[0]?.emit("live", [u1], true);
		// Already working when the mirror first synced: the real start is unknown.
		expect(session.getSnapshot().workingSince).toBeNull();
		fakes.guests[0]?.emit("live", [u1, a1], false);
		expect(session.getSnapshot().workingSince).toBeNull();
		fakes.guests[0]?.emit("live", [u1, a1, u2], true);
		expect(session.getSnapshot().workingSince).toBe(5000);
		vi.spyOn(Date, "now").mockReturnValue(9000);
		fakes.guests[0]?.emit("live", [u1, a1, u2], true);
		expect(session.getSnapshot().workingSince).toBe(5000);
		fakes.guests[0]?.emit("live", [u1, a1, u2], false);
		expect(session.getSnapshot().workingSince).toBeNull();
		vi.restoreAllMocks();
	});

	it("keeps background waits active without publishing a finished result until the wait ends", () => {
		const session = new SessionController({ tabId: "async-wait", projectPath: "/p", sessionFile: null });
		const events: string[] = [];
		const empty = { agents: [], progress: new Map(), lifecycle: new Map() };
		session.onEvent(event => events.push(event.kind));
		session.attach(host({ link: "L1" }));
		fakes.guests[0]?.emit("live", [u1], false, empty);
		fakes.guests[0]?.emit("live", [u1, a1], true, empty);
		fakes.guests[0]?.emit("live", [u1, a1], false, { ...empty, awaitingAsyncWork: true });
		expect(session.getSnapshot().working).toBe(true);
		expect(chatStatus(session.getSnapshot())).toBe("working");
		expect(session.busy).toBe(true);
		expect(events).toEqual([]);
		// A continued run and another wait are the same unfinished request.
		fakes.guests[0]?.emit("live", [u1, a1], true, empty);
		fakes.guests[0]?.emit("live", [u1, a1], false, { ...empty, awaitingAsyncWork: true });
		expect(events).toEqual([]);
		fakes.guests[0]?.emit("live", [u1, a1], false, { ...empty, awaitingAsyncWork: false });
		expect(events).toEqual(["finished"]);
		expect(session.getSnapshot().working).toBe(false);
		expect(chatStatus(session.getSnapshot())).toBe("live");
	});

	it("does not finish or deliver queued work after an idle sample corrected by streaming at two seconds", async () => {
		vi.useFakeTimers();
		const session = new SessionController({ tabId: "idle-correction", projectPath: "/p", sessionFile: null });
		const slash = vi.fn(async () => undefined);
		const sample = Promise.withResolvers<boolean>();
		const events: string[] = [];
		session.onEvent(event => events.push(event.kind));
		setSlashDelivery(slash);
		respond = channel => channel === "native:asyncWork" ? sample.promise : undefined;
		try {
			session.attach(host({ link: "L1" }));
			const guest = fakes.guests[0]!;
			guest.emit("live", [u1, a1], true);
			await session.send("/compact");
			await vi.advanceTimersByTimeAsync(1_500);
			guest.emit("live", [u1, a1], true, { idleCheckRevision: 1 });
			await vi.advanceTimersByTimeAsync(500);
			guest.emit("live", [u1, a1], true);
			sample.resolve(false);
			await flush();
			expect(session.getSnapshot().working).toBe(true);
			expect(events).toEqual([]);
			expect(slash).not.toHaveBeenCalled();
			expect(session.getSnapshot().queue.map(row => row.text)).toEqual(["/compact"]);
		} finally { await session.dispose(); vi.useRealTimers(); }
	});

	it("settles a state-only idle from a fresh native sample", async () => {
		const session = new SessionController({ tabId: "idle-confirmation", projectPath: "/p", sessionFile: null });
		const events: string[] = [];
		session.onEvent(event => events.push(event.kind));
		respond = channel => channel === "native:asyncWork" ? Promise.resolve(false) : undefined;
		try {
			session.attach(host({ link: "L1" }));
			fakes.guests[0]!.emit("live", [u1, a1], true, { idleCheckRevision: 1 });
			await flush();
			expect(session.getSnapshot().working).toBe(false);
			expect(events).toEqual(["finished"]);
		} finally { await session.dispose(); }
	});

	it("retains an idle candidate when the native observation is unavailable or still busy", async () => {
		vi.useFakeTimers();
		const session = new SessionController({ tabId: "idle-unknown", projectPath: "/p", sessionFile: null });
		const samples = [null, true, false];
		respond = channel => channel === "native:asyncWork" ? Promise.resolve(samples.shift()) : undefined;
		try {
			session.attach(host({ link: "L1" }));
			fakes.guests[0]!.emit("live", [u1, a1], true, { idleCheckRevision: 1 });
			await flush();
			expect(session.getSnapshot().working).toBe(true);
			await vi.advanceTimersByTimeAsync(250);
			expect(session.getSnapshot().working).toBe(true);
			await vi.advanceTimersByTimeAsync(250);
			expect(session.getSnapshot().working).toBe(false);
		} finally { await session.dispose(); vi.useRealTimers(); }
	});

	it.each((["classic", "tsp"] as const).flatMap(transport => ["slash cancellation", "Tasks Stop", "quiet completion"].map(source => ({ transport, source }))))("releases queued compaction after $source in $transport", async ({ transport, source }) => {
		vi.useFakeTimers();
		const session = new SessionController({ tabId: `wait-release-${transport}`, projectPath: "/p", sessionFile: null });
		const slash = vi.fn(async () => undefined);
		setSlashDelivery(slash);
		const samples = [true, true, false];
		respond = channel => channel === "native:asyncWork" ? Promise.resolve(samples.shift() ?? true) : undefined;
		try {
			session.attach(host({ link: "L1", transport }));
			const guest = fakes.guests[0]!;
			guest.emit("live", [u1, a1], true);
			guest.emit("live", [u1, a1], false, { awaitingAsyncWork: true, asyncWaitRevision: 1 });
			await session.send("/compact");
			await flush();
			expect(session.getSnapshot().queue.map(row => row.text)).toEqual(["/compact"]);
			expect(slash).not.toHaveBeenCalled();
			if (source !== "quiet completion") {
				const command = source === "Tasks Stop" ? "/jobs kill bg_1" : "/jobs kill all";
				await session.command(command);
				expect(invoked.filter(call => call[0] === "host:submit").at(-1)?.[2]).toBe(command);
			}
			await vi.advanceTimersByTimeAsync(250);
			expect(session.getSnapshot().working).toBe(true);
			expect(slash).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(250);
			await flush();
			expect(session.getSnapshot().working).toBe(false);
			expect(session.getSnapshot().guest?.awaitingAsyncWork).toBe(false);
			expect(session.getSnapshot().queue).toEqual([]);
			expect(slash).toHaveBeenCalledExactlyOnceWith(session, "/compact", { report: true });
		} finally { await session.dispose(); vi.useRealTimers(); }
	});

	it("retains the wait when the SDK sample is unavailable or interrupted", async () => {
		vi.useFakeTimers();
		const session = new SessionController({ tabId: "wait-unknown", projectPath: "/p", sessionFile: null });
		let sample = 0;
		respond = channel => channel === "native:asyncWork"
			? ++sample === 1 ? Promise.resolve(null) : sample === 2 ? Promise.reject(new Error("Bridge interrupted")) : Promise.resolve(false)
			: undefined;
		try {
			session.attach(host({ link: "L1" }));
			fakes.guests[0]!.emit("live", [u1, a1], false, { awaitingAsyncWork: true, asyncWaitRevision: 1 });
			await flush();
			expect(session.getSnapshot().working).toBe(true);
			await vi.advanceTimersByTimeAsync(250);
			expect(session.getSnapshot().working).toBe(true);
			await vi.advanceTimersByTimeAsync(250);
			expect(session.getSnapshot().working).toBe(false);
		} finally { await session.dispose(); vi.useRealTimers(); }
	});

	it("does not apply an old quiet sample to a continuation's next wait", async () => {
		vi.useFakeTimers();
		const session = new SessionController({ tabId: "wait-race", projectPath: "/p", sessionFile: null });
		const first = Promise.withResolvers<boolean>();
		let count = 0;
		respond = channel => channel === "native:asyncWork" ? (++count === 1 ? first.promise : Promise.resolve(true)) : undefined;
		try {
			session.attach(host({ link: "L1" }));
			const guest = fakes.guests[0]!;
			guest.emit("live", [u1, a1], false, { awaitingAsyncWork: true, asyncWaitRevision: 1 });
			guest.emit("live", [u1, a1], true);
			guest.emit("live", [u1, a1], false, { awaitingAsyncWork: true, asyncWaitRevision: 2 });
			first.resolve(false);
			await flush();
			expect(session.getSnapshot().working).toBe(true);
			expect(session.getSnapshot().guest?.awaitingAsyncWork).toBe(true);
		} finally { await session.dispose(); vi.useRealTimers(); }
	});

	it("reports the turn's end while a helper it started still runs, and keeps the chat marked for the helper", () => {
		const session = new SessionController({ tabId: "t5h", projectPath: "/p", sessionFile: null });
		const events: string[] = [];
		session.onEvent(event => events.push(event.kind));
		session.attach(host({ link: "L1" }));
		const helper = { id: "Atlas", displayName: "Atlas", kind: "sub", status: "running", hasSessionFile: true, createdAt: 0, lastActivity: 0 };
		const helpers = { agents: [helper], progress: new Map(), lifecycle: new Map() } as unknown as Partial<GuestSnapshot>;
		fakes.guests[0]?.emit("live", [u1], false);
		fakes.guests[0]?.emit("live", [u1, a1], true, helpers);
		expect(chatStatus(session.getSnapshot())).toBe("working");
		fakes.guests[0]?.emit("live", [u1, a1], false, helpers);
		// The notification, the Dock badge and the usage refresh all listen for this event.
		expect(events).toEqual(["finished"]);
		expect(session.getSnapshot().workingSince).toBeNull();
		expect(chatStatus(session.getSnapshot())).toBe("helpersWorking");
		// The helper's end is no turn end, so nothing reports a second time.
		fakes.guests[0]?.emit("live", [u1, a1], false, { ...helpers, agents: [{ ...helper, status: "idle" }] } as Partial<GuestSnapshot>);
		expect(events).toEqual(["finished"]);
		expect(chatStatus(session.getSnapshot())).toBe("live");
	});
});

const tui = (overlays: number) => ({ overlays, focused: "vw", altScreen: false, overlayKinds: [] });
/** Let promise callbacks settle (deliveries, holds, whenLive, a typed command's watch); no timers involved. */
const flush = async () => {
	for (let i = 0; i < 50; i++) await Promise.resolve();
};
const queued = (session: SessionController) => session.getSnapshot().queue.map(item => item.text);
/** A live chat in the middle of a turn. */
function working(tabId: string) {
	const session = new SessionController({ tabId, projectPath: "/p", sessionFile: null });
	session.attach(host({ link: "L1", tui: tui(0) }));
	fakes.guests.at(-1)?.emit("live", [u1], true);
	return session;
}
/** A live chat waiting for the next message; `overlays` > 0 means omp's own full-screen menu is open. */
function idle(tabId: string, overlays = 0) {
	const session = new SessionController({ tabId, projectPath: "/p", sessionFile: null });
	session.attach(host({ link: "L1", tui: tui(overlays) }));
	fakes.guests.at(-1)?.emit("live", [u1], false);
	return session;
}
/** Slash deliveries in order; each stays in flight until its `done` is called. */
function fakeDelivery() {
	const calls: { line: string; done: () => void }[] = [];
	setSlashDelivery((_session, line) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		calls.push({ line, done: resolve });
		return promise;
	});
	return calls;
}
const shot = { path: "/tmp/Screen Shot.png", name: "Screen Shot.png" };
const pasteShot = ["composer:paste", "h1", "/tmp/Screen\\ Shot.png"];
const submit = (text: string) => ["host:submit", "h1", text, "steer", ...(!text.startsWith("/") && !/^!!?/.test(text) && !/^\$\$?\s/.test(text) ? [undefined, expect.any(String)] : [])];

describe("SessionController account pin submission guard", () => {
	it.each(["host", "generation", "session", "provider", "reply"] as const)("refuses a pin when %s changes behind an earlier serialized write", async change => {
		const session = idle(`pin-write-${change}`);
		const state = { isStreaming: false, queuedMessageCount: 0, cwd: "/p", participants: [], model: { provider: "anthropic", id: "model", name: "Model", contextWindow: 200000 } };
		fakes.guests.at(-1)!.emit("live", [u1], false, { state });
		const block = Promise.withResolvers<null>();
		respond = channel => channel === "host:submit" ? block.promise : undefined;
		const earlier = session.command("/hold");
		await flush();
		const pin = pinSessionAccount(session, { provider: "anthropic", sessionId: "s1", accounts: [
			{ credentialId: 7, label: "first@example.com", active: true },
			{ credentialId: 12, label: "second@example.com", active: false },
		] }, 12);
		const rejected = expect(pin).rejects.toThrow(change === "reply" ? "finish replying" : "chat or model changed");
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit")).toEqual([submit("/hold")]);
		if (change === "host") session.attach(host({ hostId: "h2", link: "L2", tui: tui(0) }));
		else if (change === "generation") sendHost({ link: "L1", generation: 2, tui: tui(0) });
		else if (change === "session") sendHost({ link: "L1", sessionId: "s2", tui: tui(0) });
		const model = change === "provider" ? { ...state.model, provider: "openai-codex" } : state.model;
		fakes.guests.at(-1)!.emit("live", [u1], change === "reply", { state: { ...state, model } });
		block.resolve(null);
		await earlier;
		await rejected;
		expect(invoked.filter(call => call[0] === "host:submit")).toEqual([submit("/hold")]);
	});
});

describe("SessionController rejected prompt recovery", () => {
	afterEach(() => { vi.useRealTimers(); });

	it.each(["classic", "tsp"] as const)("retains a direct %s rejection arriving before submit resolves, including images and a newer draft", async transport => {
		const session = idle(`rejected-before-${transport}`);
		sendHost({ transport, link: "L1" });
		const write = Promise.withResolvers<null>();
		respond = channel => channel === "host:submit" ? write.promise : undefined;
		const sending = session.send("Original prompt", [shot]);
		await flush();
		const call = invoked.find(entry => entry[0] === "host:submit")!;
		expect(call).toEqual(["host:submit", "h1", "Original prompt", "steer", transport === "tsp" ? "/tmp/Screen\\ Shot.png" : undefined, expect.any(String)]);
		useComposerDrafts.getState().setDraft(session.tabId, "A newer draft");
		useComposerDrafts.getState().addAttachments(session.tabId, [{ path: "/tmp/new.png", name: "new.png" }]);
		const failure = { id: call[5] as string, generation: 1, diagnostic: "No API key found for provider.", cleared: true };
		let retainedAtReceipt = false;
		respond = channel => {
			if (channel === "host:ack-submission") retainedAtReceipt = session.getSnapshot().queue.some(item => item.text === "Original prompt" && item.error === failure.diagnostic);
			return channel === "host:submit" ? write.promise : undefined;
		};
		sendHost({ transport, link: "L1", promptFailures: [failure] });
		sendHost({ transport, link: "L1", promptFailures: [failure] });
		expect(retainedAtReceipt).toBe(true);
		expect(session.getSnapshot().queue).toMatchObject([{ text: "Original prompt", images: [shot], error: failure.diagnostic }]);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", failure.id]]);
		expect(useComposerDrafts.getState().drafts[session.tabId]).toBe("A newer draft");
		expect(useComposerDrafts.getState().attachments[session.tabId]).toEqual([{ path: "/tmp/new.png", name: "new.png" }]);
		write.resolve(null);
		await sending;
		await session.send("Next prompt");
		session.removeQueued(session.getSnapshot().queue[0]!.id);
		await flush();
		expect(invoked.filter(entry => entry[0] === "host:submit").map(entry => entry[2])).toEqual(["Original prompt", "Next prompt"]);
		useComposerDrafts.getState().forget(session.tabId);
	});

	it("retains a rejection after submit resolves from an adopted initial host state and never infers a rejection from elapsed time", async () => {
		vi.useFakeTimers();
		const session = idle("rejected-after");
		await session.send("Original prompt");
		const id = invoked.at(-1)![5] as string;
		await session.send("Next prompt");
		await vi.advanceTimersByTimeAsync(600_000);
		expect(queued(session)).toEqual(["Next prompt"]);
		expect(submissionAcks).toEqual([]);
		expect(invoked.filter(entry => entry[0] === "host:submit")).toHaveLength(1);
		const failure = { id, generation: 1, diagnostic: "No models available.", cleared: true };
		session.attach(host({ link: "L1", promptFailures: [failure] }));
		await flush();
		sendHost({ link: "L1", promptFailures: [failure] });
		expect(session.getSnapshot().queue).toMatchObject([{ text: "Original prompt", error: failure.diagnostic }, { text: "Next prompt" }]);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
		fakes.guests[0]!.emit("live", [u1], true);
		fakes.guests[0]!.emit("live", [u1, a1], false);
		await flush();
		expect(invoked.filter(entry => entry[0] === "host:submit")).toHaveLength(1);
	});

	it("retains a queued rejection as the original row and accepts an explicit retry with a fresh submission id", async () => {
		const session = working("rejected-queued");
		await session.send("Queued prompt", [shot]);
		await session.send("Following prompt");
		const original = session.getSnapshot().queue[0]!;
		fakes.guests[0]!.emit("live", [u1, a1], false);
		await flush();
		const first = invoked.find(entry => entry[0] === "host:submit")!;
		const failure = { id: first[5] as string, generation: 1, diagnostic: "No models available.", cleared: true };
		sendHost({ link: "L1", promptFailures: [failure] });
		await flush();
		expect(session.getSnapshot().queue[0]).toEqual({ ...original, error: failure.diagnostic });
		await session.sendNow(original.id);
		const retry = invoked.filter(entry => entry[0] === "host:submit").at(-1)!;
		expect(retry[5]).not.toBe(first[5]);
		expect(invoked.filter(entry => entry[0] === "composer:paste")).toEqual([pasteShot, pasteShot]);
		expect(queued(session)).toEqual(["Following prompt"]);
		sendHost({ link: "L1", promptFailures: [failure] });
		expect(queued(session)).toEqual(["Following prompt"]);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", first[5]]]);
		const accepted = userPrompt("accepted-retry", "Queued prompt", 1);
		fakes.guests[0]!.emit("live", [u1, a1, accepted], true);
		fakes.guests[0]!.emit("live", [u1, a1, accepted], false);
		await flush();
		expect(submissionAcks).toContainEqual(["host:ack-submission", "h1", retry[5]]);
		expect(invoked.filter(entry => entry[0] === "host:submit").map(entry => entry[2])).toEqual(["Queued prompt", "Queued prompt", "Following prompt"]);
	});

	it("restores Send now to its queue position when rejection precedes a rejected submit response", async () => {
		const session = working("rejected-now");
		await session.send("First");
		await session.send("Send now", [shot]);
		await session.send("Last");
		const original = session.getSnapshot().queue[1]!;
		const write = Promise.withResolvers<null>();
		respond = channel => channel === "host:submit" ? write.promise : undefined;
		const sending = session.sendNow(original.id);
		await flush();
		const id = invoked.find(entry => entry[0] === "host:submit")![5] as string;
		const failure = { id, generation: 1, diagnostic: "No API key found for provider.", cleared: true };
		sendHost({ link: "L1", promptFailures: [failure] });
		write.reject(new Error("submission rejected"));
		await sending;
		await flush();
		sendHost({ link: "L1", promptFailures: [failure] });
		expect(queued(session)).toEqual(["First", "Send now", "Last"]);
		expect(session.getSnapshot().queue[1]).toEqual({ ...original, error: failure.diagnostic });
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
	});

	it("acknowledges a normal direct send only after its matching user entry and positive turn evidence", async () => {
		const session = idle("accepted-direct");
		await session.send("Normal prompt");
		const id = invoked[0]![5];
		expect(typeof id).toBe("string");
		expect(submissionAcks).toEqual([]);
		const accepted = userPrompt("accepted-direct", "Normal prompt");
		fakes.guests[0]!.emit("live", [u1, accepted], false);
		expect(submissionAcks).toEqual([]);
		fakes.guests[0]!.emit("live", [u1, accepted], true);
		await flush();
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
		fakes.guests[0]!.emit("live", [u1, accepted, a1], false);
		sendHost({ link: "L1", promptFailures: [{ id: id as string, generation: 1, diagnostic: "Stale failure", cleared: true }] });
		expect(queued(session)).toEqual([]);
	});

	it("waits for the submit response before acknowledging positive evidence received mid-write", async () => {
		const session = idle("accepted-mid-write");
		const write = Promise.withResolvers<null>();
		respond = channel => channel === "host:submit" ? write.promise : undefined;
		const sending = session.send("Normal prompt");
		await flush();
		const id = invoked[0]![5];
		fakes.guests[0]!.emit("live", [u1, userPrompt("accepted-mid-write", "Normal prompt")], true);
		expect(submissionAcks).toEqual([]);
		write.resolve(null);
		await sending;
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
		expect(queued(session)).toEqual([]);
	});

	it("acknowledges a steered send from its user message without waiting for another turn", async () => {
		const session = working("accepted-steered");
		await session.steer("Steer this turn");
		const id = invoked[0]![5];
		expect(submissionAcks).toEqual([]);
		fakes.guests[0]!.emit("live", [u1, userPrompt("accepted-steered", "Steer this turn")], true);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
	});

	it("keeps a pending submission when a new chat first publishes its session file", async () => {
		const session = new SessionController({ tabId: "rejected-first-file", projectPath: "/p", sessionFile: null });
		session.attach(host({ link: "L1", sessionFile: null }));
		fakes.guests[0]!.emit("live", [], false);
		await session.send("First prompt");
		const id = invoked[0]![5] as string;
		sendHost({ link: "L1", promptFailures: [{ id, generation: 1, diagnostic: "No models available.", cleared: true }] });
		expect(session.getSnapshot().queue).toMatchObject([{ text: "First prompt", error: "No models available." }]);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
	});

	it("retries a failed rejection receipt without duplicating or resending the retained row", async () => {
		const session = idle("rejected-receipt-retry");
		await session.send("Original");
		const id = invoked[0]![5] as string;
		const failure = { id, generation: 1, diagnostic: "No models available.", cleared: true };
		failOnce("host:ack-submission", "IPC interrupted");
		sendHost({ link: "L1", promptFailures: [failure] });
		await flush();
		sendHost({ link: "L1", promptFailures: [failure] });
		await flush();
		expect(session.getSnapshot().queue).toMatchObject([{ text: "Original", error: failure.diagnostic }]);
		expect(session.getSnapshot().queue).toHaveLength(1);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id], ["host:ack-submission", "h1", id]]);
		expect(invoked.filter(entry => entry[0] === "host:submit")).toHaveLength(1);
	});

	it("retains a matching rejection while an accepted receipt is still in flight", async () => {
		const session = idle("rejected-during-receipt");
		const receipt = Promise.withResolvers<null>();
		respond = channel => channel === "host:ack-submission" ? receipt.promise : undefined;
		await session.send("Original prompt");
		const id = invoked[0]![5] as string;
		fakes.guests[0]!.emit("live", [u1, userPrompt("accepted-during-receipt", "Original prompt")], true);
		sendHost({ link: "L1", promptFailures: [{ id, generation: 1, diagnostic: "No models available.", cleared: true }] });
		expect(session.getSnapshot().queue).toMatchObject([{ text: "Original prompt", error: "No models available." }]);
		receipt.resolve(null);
		await flush();
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
		expect(queued(session)).toEqual(["Original prompt"]);
	});

	it("keeps simultaneous pending submissions separate and releases only the rejected submission's wait", async () => {
		const session = idle("rejected-simultaneous");
		await session.send("First");
		await session.steer("Second");
		const [first, second] = invoked.filter(entry => entry[0] === "host:submit");
		expect(first![5]).not.toBe(second![5]);
		sendHost({ link: "L1", promptFailures: [{ id: first![5] as string, generation: 1, diagnostic: "First rejected", cleared: true }] });
		session.removeQueued(session.getSnapshot().queue[0]!.id);
		await session.send("Third");
		await flush();
		expect(queued(session)).toEqual(["Third"]);
		expect(invoked.filter(entry => entry[0] === "host:submit")).toHaveLength(2);
		sendHost({ link: "L1", promptFailures: [{ id: second![5] as string, generation: 1, diagnostic: "Second rejected", cleared: true }] });
		expect(session.getSnapshot().queue).toMatchObject([{ text: "Second", error: "Second rejected" }, { text: "Third" }]);
		session.removeQueued(session.getSnapshot().queue[0]!.id);
		await flush();
		expect(invoked.filter(entry => entry[0] === "host:submit").map(entry => entry[2])).toEqual(["First", "Second", "Third"]);
	});

	it.each([
		{ text: "distinct", first: "First", second: "Second", timing: "settled" },
		{ text: "identical", first: "Repeated", second: "Repeated", timing: "settled" },
		{ text: "distinct", first: "First", second: "Second", timing: "mid-write" },
		{ text: "identical", first: "Repeated", second: "Repeated", timing: "mid-write" },
	])("retains the second of two $text submissions when only the first has delivery evidence ($timing)", async ({ first, second, timing }) => {
		const session = idle(`accepted-first-${first}-${timing}`);
		await session.send(first);
		const write = Promise.withResolvers<null>();
		respond = channel => channel === "host:submit" ? write.promise : undefined;
		const sending = session.steer(second);
		await flush();
		const [firstCall, secondCall] = invoked.filter(entry => entry[0] === "host:submit");
		if (timing === "settled") {
			write.resolve(null);
			await sending;
		}
		const accepted = userPrompt("accepted-first", first);
		fakes.guests[0]!.emit("live", [u1, accepted], true);
		await flush();
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", firstCall![5]]]);
		if (timing === "mid-write") {
			write.resolve(null);
			await sending;
		}
		// Replayed transcript evidence must stay consumed after the first watch has retired.
		fakes.guests[0]!.emit("live", [u1, accepted], false);
		await flush();
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", firstCall![5]]]);
		expect(session.busy).toBe(false);
		sendHost({ link: "L1", promptFailures: [{ id: secondCall![5] as string, generation: 1, diagnostic: "Second rejected", cleared: true }] });
		expect(session.getSnapshot().queue).toMatchObject([{ text: second, error: "Second rejected" }]);
		expect(submissionAcks).toEqual([
			["host:ack-submission", "h1", firstCall![5]],
			["host:ack-submission", "h1", secondCall![5]],
		]);
	});

	it("requires a new matching transcript entry to acknowledge another identical submission", async () => {
		const session = working("accepted-identical");
		await session.steer("Repeated");
		await session.steer("Repeated");
		const [first, second] = invoked.filter(entry => entry[0] === "host:submit");
		const acceptedFirst = userPrompt("accepted-repeat-1", "Repeated");
		fakes.guests[0]!.emit("live", [u1, acceptedFirst], true);
		await flush();
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", first![5]]]);
		fakes.guests[0]!.emit("live", [u1, acceptedFirst, userPrompt("accepted-repeat-2", "Repeated")], true);
		expect(submissionAcks).toEqual([
			["host:ack-submission", "h1", first![5]],
			["host:ack-submission", "h1", second![5]],
		]);
	});

	it("keeps an image submission pending for synthetic text or a different attachment count", async () => {
		const session = working("accepted-exact-images");
		await session.steer("Look", [shot]);
		const id = invoked.find(entry => entry[0] === "host:submit")![5];
		const synthetic = userPrompt("synthetic", "Look", 1, true);
		const textOnly = userPrompt("text-only", "Look");
		fakes.guests[0]!.emit("live", [u1, synthetic, textOnly], true);
		expect(submissionAcks).toEqual([]);
		fakes.guests[0]!.emit("live", [u1, synthetic, textOnly, userPrompt("accepted-image", "Look", 1)], true);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
	});

	it("acknowledges exact authored image text with expanded numbered markers and ignores malformed, reordered or changed text", async () => {
		const session = working("accepted-expanded-images");
		await session.steer("Look at these.", [shot, { path: "/tmp/second.png", name: "second.png" }]);
		const id = invoked.find(entry => entry[0] === "host:submit")![5];
		const unrelated = [
			userPrompt("malformed-marker", "[Image #1, 398x] [Image #2, 477x200] Look at these.", 2),
			userPrompt("reordered-markers", "[Image #2, 477x200] [Image #1, 398x406] Look at these.", 2),
			userPrompt("changed-authored-text", "[Image #1, 398x406] [Image #2, 477x200] Look elsewhere.", 2),
			userPrompt("wrong-image-count", "[Image #1, 398x406] [Image #2, 477x200] Look at these.", 1),
		];
		fakes.guests[0]!.emit("live", [u1, ...unrelated], true);
		expect(submissionAcks).toEqual([]);
		const accepted = userPrompt("accepted-expanded", "[Image #1, 398x406] [Image #2, 477x200] Look at these.", 2);
		fakes.guests[0]!.emit("live", [u1, ...unrelated, accepted], true);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
	});

	it.each(["classic", "tsp"] as const)("returns unavailable ordinary-text observation to the %s caller without consuming its draft, then permits a later send", async transport => {
		const session = idle(`observation-unavailable-${transport}`);
		sendHost({ transport, link: "L1" });
		const draft = "  Keep this original draft.\n";
		useComposerDrafts.getState().setDraft(session.tabId, draft);
		failOnce("host:submit", "Prompt observation is unavailable. Try again.");
		await expect(deliver(session, draft, [], false)).rejects.toThrow("Prompt observation is unavailable");
		expect(useComposerDrafts.getState().drafts[session.tabId]).toBe(draft);
		expect(queued(session)).toEqual([]);
		expect(session.getSnapshot().inputHistory).toEqual([]);
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(session.getSnapshot().error).toBeNull();
		expect(submissionAcks).toEqual([]);
		expect(session.busy).toBe(false);
		await deliver(session, draft, [], false);
		const calls = invoked.filter(entry => entry[0] === "host:submit");
		expect(calls.map(entry => entry[2])).toEqual([draft.trim(), draft.trim()]);
		expect(calls[0]![5]).not.toBe(calls[1]![5]);
		fakes.guests[0]!.emit("live", [u1, userPrompt("accepted-after-observation", draft.trim())], true);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", calls[1]![5]]]);
		expect(session.getSnapshot().inputHistory.map(item => item.text)).toEqual([draft.trim()]);
		expect(useComposerDrafts.getState().drafts[session.tabId]).toBe(draft);
		useComposerDrafts.getState().forget(session.tabId);
	});

	it("ignores unmatched ids and stale failure generations without retiring the current submission", async () => {
		const session = idle("rejected-stale");
		await session.send("Current");
		const id = invoked[0]![5] as string;
		sendHost({ link: "L1", promptFailures: [
			{ id: "unknown", generation: 1, diagnostic: "Unknown", cleared: false },
			{ id, generation: 0, diagnostic: "Stale", cleared: false },
		] });
		expect(queued(session)).toEqual([]);
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(submissionAcks).toEqual([]);
		sendHost({ link: "L1", promptFailures: [{ id, generation: 1, diagnostic: "Current rejection", cleared: true }] });
		expect(session.getSnapshot().queue).toMatchObject([{ text: "Current", error: "Current rejection" }]);
	});

	it.each(["room", "generation", "exit", "dispose"] as const)("retires pending ids on %s so late failure cannot affect newer input", async change => {
		const session = idle(`rejected-retired-${change}`);
		await session.send("Old");
		const oldId = invoked[0]![5] as string;
		const link = change === "room" || change === "exit" ? "L2" : "L1";
		const generation = change === "room" ? 1 : 2;
		if (change === "dispose") await session.dispose();
		else {
			if (change === "exit") sendHost({ phase: "exited", exitCode: 0 });
			sendHost({ link, generation });
			fakes.guests.at(-1)!.emit("live", [u1], false);
			await session.send("New");
		}
		sendHost({ link, generation, promptFailures: [{ id: oldId, generation, diagnostic: "Late failure", cleared: false }] });
		if (generation > 1) sendHost({ link, generation: 1, promptFailures: [{ id: oldId, generation: 1, diagnostic: "Old state", cleared: false }] });
		expect(queued(session)).toEqual([]);
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(submissionAcks).toEqual([]);
		if (change !== "dispose") {
			const newId = invoked.filter(entry => entry[0] === "host:submit").at(-1)![5];
			fakes.guests.at(-1)!.emit("live", [u1, userPrompt("accepted-new", "New")], true);
			expect(submissionAcks).toEqual([["host:ack-submission", "h1", newId]]);
		}
	});

	it("preserves a failed-clear row and blocks all editor writes until explicit relaunch", async () => {
		const session = idle("rejected-uncleared");
		await session.send("Original", [shot]);
		const id = invoked.find(entry => entry[0] === "host:submit")![5] as string;
		const failure = { id, generation: 1, diagnostic: "No models available.", cleared: false };
		sendHost({ link: "L1", promptFailures: [failure] });
		expect(session.getSnapshot().queue).toMatchObject([{ text: "Original", images: [shot], error: failure.diagnostic }]);
		const row = session.getSnapshot().queue[0]!;
		await expect(session.sendNow(row.id)).rejects.toThrow("Restart omp to clear it");
		await expect(session.command("/compact")).rejects.toThrow("Restart omp to clear it");
		session.removeQueued(row.id);
		await session.steer("New prompt");
		sendHost({ link: "L1", promptFailures: [failure] });
		await flush();
		expect(queued(session)).toEqual(["New prompt"]);
		expect(session.getSnapshot().strandedImages).toBe(true);
		expect(invoked.filter(entry => entry[0] === "host:submit")).toHaveLength(1);
		respond = channel => channel === "host:start" ? Promise.resolve(host({ hostId: "h2", link: "L2", generation: 2 })) : undefined;
		await session.restart();
		expect(invoked).toContainEqual(["host:stop", "h1", "editor-recovery"]);
		expect(invoked.some(entry => entry[0] === "host:submit" && entry[2] === "/restart")).toBe(false);
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(submissionAcks).toEqual([["host:ack-submission", "h1", id]]);
	});

	it.each([".", "c"])("tracks the ordinary shortcut %s for explicit Nothing-to-resume rejection", async text => {
		const session = idle(`rejected-shortcut-${text}`);
		await session.send(text);
		const id = invoked[0]![5] as string;
		expect(typeof id).toBe("string");
		sendHost({ link: "L1", promptFailures: [{ id, generation: 1, diagnostic: "Nothing to resume.", cleared: true }] });
		expect(session.getSnapshot().queue).toMatchObject([{ text, error: "Nothing to resume." }]);
	});

	it.each(["/compact", "!pwd", "!!pwd", "$ print(1)", "$$ print(1)"])("does not register %s as an ordinary prompt", async text => {
		const session = idle(`untracked-${text}`);
		if (text.startsWith("/")) await session.command(text);
		else await session.steer(text);
		expect(invoked).toEqual([["host:submit", "h1", text, "steer"]]);
		fakes.guests[0]!.emit("live", [u1, u2], true);
		expect(submissionAcks).toEqual([]);
	});
});

describe("messages while ask waits", () => {
	const args = { questions: [{ id: "db", question: "Which database?", options: [{ label: "SQLite" }] }] };
	const request = { reqId: 7, kind: "select" as const, title: "Which database?", options: ["SQLite", "Other (type your own)", "Chat about this"] };
	const ask = { uiRequest: request, activeTools: new Map([["ask-1", { toolCallId: "ask-1", toolName: "ask", args, startedAt: 0 }]]) };
	it.each(["classic", "tsp"] as const)("sends Enter and Send now through a user collab prompt in %s without touching the question selector", async transport => {
		const session = working(`ask-${transport}`);
		sendHost({ transport, link: "L1", tui: tui(1), tspAvailability: { available: false, reason: "Question", reasonCode: "matched-question", questionReqId: 7 } });
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		await deliver(session, "Use Postgres instead.", [], false);
		await deliver(session, "Keep the existing schema.", [], true);
		expect(guest.sendPrompt.mock.calls.map(call => call.slice(0, 2))).toEqual([["Use Postgres instead.", []], ["Keep the existing schema.", []]]);
		expect(invoked.filter(call => ["host:submit", "host:keys", "composer:paste"].includes(call[0] as string))).toEqual([]);
		expect(queued(session)).toEqual([]);
		expect(session.getSnapshot().inputHistory.map(item => item.text)).toEqual(["Use Postgres instead.", "Keep the existing schema."]);
	});

	it.each(["classic", "tsp"] as const)("sends an existing queued message over collab while ask waits in %s", async transport => {
		const session = working(`queued-ask-${transport}`);
		await session.send("Use Postgres.");
		const id = session.getSnapshot().queue[0]!.id;
		sendHost({ transport, link: "L1", tui: tui(1), tspAvailability: { available: false, reason: "Question", reasonCode: "matched-question", questionReqId: 7 } });
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		await session.sendNow(id);
		expect(guest.sendPrompt).toHaveBeenCalledExactlyOnceWith("Use Postgres.", [], expect.any(Function));
		expect(queued(session)).toEqual([]);
		expect(invoked.filter(call => call[0] === "host:submit")).toEqual([]);
	});

	it("sends a collab-only rich TSP ask through all message paths while its semantic main editor is absent", async () => {
		const session = working("observed-tsp-rich-ask");
		await session.send("Previously queued.");
		const queuedId = session.getSnapshot().queue[0]!.id;
		sendHost({ transport: "tsp", link: "L1", tui: tui(0), tspAvailability: { available: false, reason: "Answer the question card before sending a message.", reasonCode: "ask-editor" } });
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		await session.send("Use Postgres.");
		await session.steer("Keep the schema.");
		await session.sendNow(queuedId);
		expect(guest.sendPrompt.mock.calls.map(call => call.slice(0, 2))).toEqual([["Use Postgres.", []], ["Keep the schema.", []], ["Previously queued.", []]]);
		expect(invoked.some(call => call[0] === "host:submit" || call[0] === "composer:paste")).toBe(false);
		expect(queued(session)).toEqual([]);
	});

	it("refuses the rich ask code without a current ask and binds matched hooks to that exact request", async () => {
		const session = working("tsp-question-authority");
		await session.send("Keep this queued.");
		const item = session.getSnapshot().queue[0]!;
		const guest = fakes.guests.at(-1)!;
		sendHost({ transport: "tsp", link: "L1", tspAvailability: { available: false, reason: "Extension question", reasonCode: "matched-question", questionReqId: 8 } });
		guest.emit("live", [u1], true, ask);
		await expect(session.send("Ask A must not bypass hook B.")).rejects.toThrow("Extension question");
		await expect(session.sendNow(item.id)).rejects.toThrow("Extension question");
		expect(session.getSnapshot().queue).toEqual([item]);
		sendHost({ transport: "tsp", link: "L1", tspAvailability: { available: false, reason: "Rich ask owns dock", reasonCode: "ask-editor" } });
		guest.emit("live", [u1], true, { uiRequest: request, activeTools: new Map() });
		await expect(session.steer("No active ask.")).rejects.toThrow("Answer the question card");
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(invoked.some(call => call[0] === "host:submit")).toBe(false);
	});

	it("carries original image blocks without pasting paths into the ask selector", async () => {
		const session = working("ask-image");
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		respond = channel => channel === "panes:readFile" ? Promise.resolve({ kind: "image", dataUrl: "data:image/png;base64,aW1hZ2U=", size: 5 }) : undefined;
		await session.send("Use this design.", [shot]);
		expect(guest.sendPrompt).toHaveBeenCalledExactlyOnceWith("Use this design.", [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }], expect.any(Function));
		expect(invoked.filter(call => call[0] === "composer:paste" || call[0] === "host:submit")).toEqual([]);
		expect(session.getSnapshot().strandedImages).toBe(false);
	});

	it("leaves unreadable images unsent without stranding them in omp's editor", async () => {
		const session = working("ask-image-failed");
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		respond = channel => channel === "panes:readFile" ? Promise.resolve({ kind: "tooLarge", size: 9_000_000, limit: 8_388_608 }) : undefined;
		await expect(session.send("Use this image.", [shot])).rejects.toThrow("Could not attach");
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(session.getSnapshot().inputHistory).toEqual([]);
		expect(invoked.filter(call => call[0] === "host:submit" || call[0] === "composer:paste")).toEqual([]);
	});

	it("does not redirect an in-flight image prompt into a replacement extension dialog", async () => {
		const session = working("ask-image-replaced");
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		const read = Promise.withResolvers<unknown>();
		respond = channel => channel === "panes:readFile" ? read.promise : undefined;
		const sending = session.send("Use this image.", [shot]);
		await flush();
		guest.emit("live", [u1], true, { ...ask, uiRequest: { reqId: 8, kind: "editor", title: "Extension input" } });
		read.resolve({ kind: "image", dataUrl: "data:image/png;base64,aW1hZ2U=", size: 5 });
		await expect(sending).rejects.toThrow("Answer the question card");
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(session.getSnapshot().strandedImages).toBe(false);
	});

	it("treats dollar amounts as message text rather than Python commands", async () => {
		const session = working("ask-currency");
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		await session.send("$100 is the budget.");
		expect(guest.sendPrompt).toHaveBeenCalledExactlyOnceWith("$100 is the budget.", [], expect.any(Function));
		expect(queued(session)).toEqual([]);
	});

	it("keeps a queued message when a replacement extension dialog refuses Send now", async () => {
		const session = working("ask-replaced");
		await session.send("Keep this message.");
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, { ...ask, uiRequest: { ...request, options: ["Extension option"] } });
		await expect(session.sendNow(session.getSnapshot().queue[0]!.id)).rejects.toThrow("Answer the question card");
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(invoked.filter(call => call[0] === "host:submit")).toEqual([]);
		expect(queued(session)).toEqual(["Keep this message."]);
	});

	it("keeps classic approval sends on their existing sending-denies path", async () => {
		const session = working("approval-message");
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, { uiRequest: { reqId: 8, kind: "select", title: "Run command?", options: ["Approve Once", "Deny"] } });
		await deliver(session, "Do not run that.", [], true);
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(invoked).toContainEqual(submit("Do not run that."));
	});

	it.each(["ended", "replaced", "reconnected"] as const)("keeps ask-origin routing across a serialized write when the question is %s", async change => {
		const session = working(`ask-write-${change}`);
		const guest = fakes.guests.at(-1)!;
		const block = Promise.withResolvers<null>();
		respond = channel => channel === "host:submit" ? block.promise : undefined;
		const command = session.command("/hold");
		await flush();
		guest.emit("live", [u1], true, { ...ask, uiConnection: 1 });
		const sending = session.send("Keep this as a prompt.");
		const result = change === "ended" ? sending : expect(sending).rejects.toThrow();
		if (change === "ended") guest.emit("live", [u1], true, { uiConnection: 1 });
		else if (change === "replaced") guest.emit("live", [u1], true, { ...ask, uiConnection: 1, uiRequest: { ...request, options: ["Extension option"] } });
		else guest.emit("live", [u1], true, { ...ask, uiConnection: 2 });
		block.resolve(null);
		await command; await result;
		expect(invoked.filter(call => call[0] === "host:submit")).toEqual([submit("/hold")]);
		if (change === "ended") expect(guest.sendPrompt).toHaveBeenCalledExactlyOnceWith("Keep this as a prompt.", [], expect.any(Function));
		else { expect(guest.sendPrompt).not.toHaveBeenCalled(); expect(session.getSnapshot().inputHistory.map(row => row.text)).not.toContain("Keep this as a prompt."); }
	});

	it.each(["dispose", "reconnect", "readOnly"] as const)("refuses image delivery after %s while retaining undelivered input", async change => {
		const session = working(`ask-image-${change}`);
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, { ...ask, uiConnection: 1 });
		const read = Promise.withResolvers<unknown>();
		respond = channel => channel === "panes:readFile" ? read.promise : undefined;
		const sending = session.send("Keep this image draft.", [shot]);
		const rejected = expect(sending).rejects.toThrow("chat changed");
		await flush();
		if (change === "dispose") await session.dispose();
		else if (change === "readOnly") guest.emit("live", [u1], true, { ...ask, uiConnection: 1, readOnly: true });
		else { guest.emit("reconnecting", [u1], true, { ...ask, uiConnection: 2 }); guest.emit("live", [u1], true, { ...ask, uiConnection: 3 }); }
		read.resolve({ kind: "image", dataUrl: "data:image/png;base64,aW1hZ2U=", size: 5 });
		await rejected;
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(session.getSnapshot().inputHistory).toEqual([]);
		expect(invoked.some(call => call[0] === "composer:paste" || call[0] === "host:submit")).toBe(false);
	});

	it.each(["reconnecting", "readOnly"] as const)("refuses a stale ask send initiated while %s without queueing or typing it", async unavailable => {
		const session = working(`ask-stale-${unavailable}`);
		const guest = fakes.guests.at(-1)!;
		guest.emit(unavailable === "reconnecting" ? "reconnecting" : "live", [u1], true, { ...ask, readOnly: unavailable === "readOnly" });
		await expect(session.send("Keep this draft.")).rejects.toThrow("chat changed");
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(queued(session)).toEqual([]);
		expect(invoked.some(call => call[0] === "host:submit")).toBe(false);
	});

	it("retains a queued row when its captured ask request changes before its write", async () => {
		const session = working("ask-queue-replaced");
		await session.send("Keep this queued.");
		const item = session.getSnapshot().queue[0]!;
		const block = Promise.withResolvers<null>();
		respond = channel => channel === "host:submit" ? block.promise : undefined;
		const command = session.command("/hold");
		await flush();
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		const sending = session.sendNow(item.id);
		const rejected = expect(sending).rejects.toThrow("Answer the question card");
		guest.emit("live", [u1], true, { ...ask, uiRequest: { reqId: 8, kind: "editor", title: "Extension input" } });
		block.resolve(null); await command; await rejected;
		expect(session.getSnapshot().queue).toEqual([item]);
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(invoked.filter(call => call[0] === "host:submit")).toEqual([submit("/hold")]);
	});

	it("refuses non-question TSP unavailability for all controller prompt entry points", async () => {
		const session = working("ask-tsp-menu");
		await session.send("Keep this queued.");
		const item = session.getSnapshot().queue[0]!;
		sendHost({ transport: "tsp", link: "L1", tspAvailability: { available: false, reason: "Close the omp screen before sending a message." } });
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		await expect(session.send("Enter prompt")).rejects.toThrow("Close the omp screen");
		await expect(session.steer("Immediate prompt")).rejects.toThrow("Close the omp screen");
		await expect(session.sendNow(item.id)).rejects.toThrow("Close the omp screen");
		expect(session.getSnapshot().queue).toEqual([item]);
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(invoked.some(call => call[0] === "host:submit")).toBe(false);
	});

	it("waits for its own attributed collab prompt before draining the next queued row", async () => {
		const session = working("ask-collab-ack");
		await session.send("Next queued message.");
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		const read = Promise.withResolvers<unknown>();
		respond = channel => channel === "panes:readFile" ? read.promise : undefined;
		const sending = session.send("My image prompt.", [shot]);
		await flush();
		guest.emit("live", [u1], false);
		read.resolve({ kind: "image", dataUrl: "data:image/png;base64,aW1hZ2U=", size: 5 });
		await sending; await flush();
		const collab = (id: string, from: string, content: string): SessionEntry => ({ type: "custom_message", id, parentId: "u1", timestamp: "", customType: "collab-prompt", display: true, content, details: { from } });
		const unrelated = collab("other", "Someone else", "My image prompt.");
		guest.emit("live", [u1, unrelated], false); await flush();
		expect(queued(session)).toEqual(["Next queued message."]);
		guest.emit("live", [u1, unrelated, collab("mine", "visual-omp", "My image prompt.")], false); await flush();
		expect(queued(session)).toEqual([]);
		expect(invoked.filter(call => call[0] === "host:submit")).toEqual([submit("Next queued message.")]);
	});

	it("preserves a failed submitted message as one queue row without retrying it", async () => {
		const session = idle("preserve-failed-message");
		session.preserveFailedMessage("Keep the failed message.", [shot]);
		await flush();
		expect(session.getSnapshot().queue).toMatchObject([{ text: "Keep the failed message.", images: [shot] }]);
		expect(invoked.filter(call => call[0] === "host:submit" || call[0] === "composer:paste")).toEqual([]);
	});

	it("queues compaction behind the turn and routes it once through the existing slash delivery", async () => {
		const calls = fakeDelivery();
		const session = working("compact-queue");
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, ask);
		await session.send("/compact");
		expect(queued(session)).toEqual(["/compact"]);
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
		guest.emit("live", [u1, a1], false);
		await flush();
		expect(calls.map(call => call.line)).toEqual(["/compact"]);
		expect(queued(session)).toEqual([]);
		calls[0]!.done();
		await flush();
		expect(calls).toHaveLength(1);
	});
});

describe("SessionController TSP input", () => {
	const preview = (busy: boolean) => {
		const session = busy ? working("preview-working") : idle("preview-idle");
		sendHost({ transport: "tsp", link: "L1", tui: tui(0), tspAvailability: { available: true, reason: null } });
		return session;
	};

	it("uses the real promise-based hold and reports exact queue ownership before submission", async () => {
		const session = preview(false);
		const hold = Promise.withResolvers<void>();
		session.holdQueue(hold.promise);
		const receipt = await session.sendWithOwnership('@"/p/source/handoff.md"\n\nContinue.', [shot]);
		expect(receipt).toMatchObject({ kind: "queued" });
		expect(session.getSnapshot().queue).toMatchObject([{ id: receipt.kind === "queued" ? receipt.id : "", text: '@"/p/source/handoff.md"\n\nContinue.', images: [shot], explicitRetry: true }]);
		expect(invoked.filter(call => call[0] === "host:submit")).toEqual([]);
		hold.resolve();
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit")).toEqual([["host:submit", "h1", '@"/p/source/handoff.md"\n\nContinue.', "steer", "/tmp/Screen\\ Shot.png", expect.any(String)]]);
		expect(session.getSnapshot().queue).toEqual([]);
	});

	it("rejects a pre-ownership handoff send so the caller can keep its draft", async () => {
		const session = preview(false);
		failOnce("host:submit", "The host stopped before submission.");
		await expect(session.sendWithOwnership("Continue.")).rejects.toThrow("The host stopped before submission.");
		expect(session.getSnapshot().queue).toEqual([]);
	});

	it("retains a failed queued handoff with explicit recovery and never retries on readiness", async () => {
		const session = preview(true);
		const text = '@"/p/source/handoff.md"\n\nContinue.';
		const receipt = await session.sendWithOwnership(text, [shot]);
		expect(receipt.kind).toBe("queued");
		failOnce("host:submit", "The host rejected the pending send.");
		fakes.guests.at(-1)?.emit("live", [u1, a1], false);
		await flush();
		const failed = session.getSnapshot().queue[0]!;
		expect(failed).toMatchObject({ id: receipt.kind === "queued" ? receipt.id : "", text, images: [shot], error: "The host rejected the pending send.", explicitRetry: true });
		sendHost({ transport: "tsp", link: "L1", tspAvailability: { available: true, reason: null } });
		fakes.guests.at(-1)?.emit("live", [u1, a1], false);
		await session.send("A later message");
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(1);
		failOnce("host:submit", "The retry was refused.");
		await expect(session.sendNow(failed.id)).rejects.toThrow("The retry was refused.");
		expect(session.getSnapshot().queue[0]).toMatchObject({ id: failed.id, text, images: [shot], error: "The retry was refused." });
		fakes.guests.at(-1)?.emit("live", [u1, a1], false);
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(2);
		await session.sendNow(failed.id);
		expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(3);
		expect(session.getSnapshot().queue.map(item => item.text)).toEqual(["A later message"]);
	});

	it("keeps the transferred retry policy after an asynchronous omp rejection and a failed explicit retry", async () => {
		const session = preview(false);
		const text = '@"/p/source/handoff.md"\n\nContinue.';
		await expect(session.sendWithOwnership(text, [shot])).resolves.toEqual({ kind: "submitted" });
		const id = invoked.filter(call => call[0] === "host:submit").at(-1)![5] as string;
		sendHost({ transport: "tsp", link: "L1", promptFailures: [{ id, generation: 1, diagnostic: "omp rejected the transferred prompt.", cleared: true }] });
		await flush();
		const failed = session.getSnapshot().queue[0]!;
		expect(failed).toMatchObject({ text, images: [shot], explicitRetry: true, error: "omp rejected the transferred prompt." });
		failOnce("host:submit", "The retry was refused.");
		await expect(session.sendNow(failed.id)).rejects.toThrow("The retry was refused.");
		expect(session.getSnapshot().queue[0]).toMatchObject({ id: failed.id, text, images: [shot], explicitRetry: true, error: "The retry was refused." });
		sendHost({ transport: "tsp", link: "L1", tspAvailability: { available: true, reason: null } });
		fakes.guests.at(-1)?.emit("live", [u1, a1], false);
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(2);
		expect(session.getSnapshot().queue).toHaveLength(1);
	});

	it.each(["restored", "stranded"] as const)("reports queue ownership for %s handoff images without duplicating the draft payload", async recovery => {
		const session = preview(false);
		const diagnostic = recovery === "restored" ? "Image submission was restored. The image could not be read." : "Image submission needs recovery. The image was staged before the host stopped.";
		failOnce("host:submit", diagnostic);
		const receipt = await session.sendWithOwnership("Continue with this image.", [shot]);
		expect(receipt.kind).toBe("queued");
		const failed = session.getSnapshot().queue[0]!;
		expect(failed).toMatchObject({ id: receipt.kind === "queued" ? receipt.id : "", text: "Continue with this image.", images: [shot], explicitRetry: true, error: expect.any(String) });
		expect(session.getSnapshot().strandedImages).toBe(recovery === "stranded");
		sendHost({ transport: "tsp", link: "L1", tspAvailability: { available: true, reason: null } });
		fakes.guests.at(-1)?.emit("live", [u1, a1], false);
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(1);
		if (recovery === "stranded") await expect(session.sendNow(failed.id)).rejects.toThrow("Restart omp");
		else {
			await session.sendNow(failed.id);
			expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(2);
			expect(session.getSnapshot().queue).toEqual([]);
		}
	});

	it.each(["send", "steer"] as const)("routes a direct TSP slash from %s through slash delivery without awaiting a collab turn", async method => {
		const calls = fakeDelivery();
		const session = preview(false);
		const sending = session[method]("/extension-ui-only");
		await flush();
		expect(calls.map(call => call.line)).toEqual(["/extension-ui-only"]);
		expect(invoked).toEqual([]);
		await session.send("after the command");
		expect(queued(session)).toEqual(["after the command"]);
		calls[0]!.done();
		await sending;
		await flush();
		expect(invoked).toEqual([submit("after the command")]);
		expect(queued(session)).toEqual([]);
	});

	it("returns a failed direct TSP slash to its caller without also adding it to the queue", async () => {
		setSlashDelivery(async () => { throw new Error("omp owns the editor"); });
		const session = preview(false);
		await expect(session.send("/extension-ui-only")).rejects.toThrow("omp owns the editor");
		expect(queued(session)).toEqual([]);
		expect(session.busy).toBe(false);
		expect(invoked).toEqual([]);
	});

	it.each(["!pwd", "!!pwd", "$ print(1)", "$$ print(1)"])("delivers %s without the classic screen or paste path", async text => {
		const session = preview(false);
		await session.steer(text);
		expect(invoked).toEqual([submit(text)]);
		expect(session.getSnapshot().strandedImages).toBe(false);
	});

	it("delivers queued images through one main-owned editor transaction", async () => {
		const session = preview(true);
		await session.send("look", [shot]);
		const id = session.getSnapshot().queue[0]!.id;
		await session.sendNow(id);
		expect(invoked).toEqual([["host:submit", "h1", "look", "steer", "/tmp/Screen\\ Shot.png", expect.any(String)]]);
		expect(session.getSnapshot().queue).toEqual([]);
	});

	it("delivers an idle prompt from semantic composer facts despite a stale classic overlay count", async () => {
		const session = preview(false);
		sendHost({ transport: "tsp", link: "L1", tui: tui(4), tspAvailability: { available: true, reason: null } });
		expect(session.busy).toBe(false);
		await session.send("Use the semantic editor.");
		expect(invoked).toEqual([submit("Use the semantic editor.")]);
		expect(queued(session)).toEqual([]);
	});

	it.each(["panel", "ask"] as const)("holds queued input for the semantic %s and releases it independently of classic focus", async blockedBy => {
		const session = preview(true);
		const facts = { sendable: true, text: "", cursor: 0, ghost: "", editorId: "e", surfaceId: "s", queued: [] };
		await session.send("After omp returns.");
		sendHost({ transport: "tsp", link: "L1", tui: tui(0), tspAvailability: { available: false, reason: "omp owns the editor." }, tspComposer: { ...facts, blockedBy } });
		fakes.guests.at(-1)!.emit("live", [u1, a1], false);
		await flush();
		expect(invoked).toEqual([]);
		expect(queued(session)).toEqual(["After omp returns."]);
		sendHost({ transport: "tsp", link: "L1", tui: tui(4), tspAvailability: { available: true, reason: null }, tspComposer: { ...facts, blockedBy: null } });
		await flush();
		expect(invoked).toEqual([submit("After omp returns.")]);
		expect(queued(session)).toEqual([]);
	});

	it("releases a previous classic overlay hold when the replacement TSP host is ready", async () => {
		const session = working("classic-overlay-replacement");
		await session.send("Continue in the replacement.");
		sendHost({ link: "L1", tui: tui(1) });
		fakes.guests.at(-1)!.emit("live", [u1, a1], false);
		await flush();
		expect(invoked).toEqual([]);
		session.attach(host({ hostId: "h2", transport: "tsp", link: "L2", tui: tui(4), tspAvailability: { available: true, reason: null } }));
		fakes.guests.at(-1)!.emit("live", [u1, a1], false);
		await flush();
		expect(invoked).toEqual([["host:submit", "h2", "Continue in the replacement.", "steer", undefined, expect.any(String)]]);
		expect(queued(session)).toEqual([]);
	});

	it("holds the app queue behind omp's own queued follow-up until its dock clears", async () => {
		const session = preview(false);
		const facts = { sendable: true, text: "", cursor: 0, ghost: "", editorId: "e", surfaceId: "s", queued: ["omp follow-up"], blockedBy: null } as const;
		sendHost({ transport: "tsp", link: "L1", tspAvailability: { available: true, reason: null }, tspComposer: { ...facts, queued: [...facts.queued] } });
		await session.send("app follow-up");
		expect(queued(session)).toEqual(["app follow-up"]);
		expect(invoked).toEqual([]);
		sendHost({ transport: "tsp", link: "L1", tspAvailability: { available: true, reason: null }, tspComposer: { ...facts, queued: [] } });
		await flush();
		expect(invoked).toEqual([submit("app follow-up")]);
	});

	it("strands staged images after a main-owned attachment failure without automatically repasting", async () => {
		const session = preview(false);
		failOnce("host:submit", "omp screen: Image submission needs recovery. omp did not attach the image.");
		await session.send("look", [shot]);
		expect(session.getSnapshot().strandedImages).toBe(true);
		expect(queued(session)).toEqual(["look"]);
		expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(1);
	});

	it.each(["classic", "tsp"] as const)("retains a restored failed image with omp's error until an explicit retry in %s", async transport => {
		const session = preview(false);
		sendHost({ transport, link: "L1" });
		failOnce(transport === "tsp" ? "host:submit" : "composer:paste", "Image submission was restored. Failed to read pasted image path");
		await session.send("look", [shot]);
		expect(session.getSnapshot().strandedImages).toBe(false);
		const [failed] = session.getSnapshot().queue;
		expect(failed).toMatchObject({ text: "look", images: [shot], error: "Failed to read pasted image path" });
		const before = invoked.filter(call => call[0] === "host:submit" || call[0] === "composer:paste").length;
		sendHost({ transport, link: "L1" });
		fakes.guests.at(-1)?.emit("live", [u1], true);
		fakes.guests.at(-1)?.emit("live", [u1, a1], false);
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit" || call[0] === "composer:paste")).toHaveLength(before);
		expect(session.getSnapshot().queue).toEqual([failed]);
		await session.sendNow(failed!.id);
		expect(session.getSnapshot().queue).toEqual([]);
		expect(session.getSnapshot().strandedImages).toBe(false);
	});

	it("keeps an automatically sent rejected image queued without retrying on readiness updates", async () => {
		const session = preview(true);
		await session.send("look", [shot]);
		failOnce("host:submit", "omp screen: Image submission was restored. Failed to read pasted image path");
		fakes.guests.at(-1)?.emit("live", [u1, a1], false);
		await flush();
		expect(session.getSnapshot().queue[0]).toMatchObject({ text: "look", images: [shot], error: "Failed to read pasted image path" });
		sendHost({ transport: "tsp", link: "L1" });
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(1);
		expect(session.getSnapshot().strandedImages).toBe(false);
		const failed = session.getSnapshot().queue[0]!;
		await session.send("next message");
		session.editQueued(failed.id, "edited prompt");
		sendHost({ transport: "tsp", link: "L1" });
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(1);
		session.removeQueued(failed.id);
		await flush();
		expect(invoked.filter(call => call[0] === "host:submit").at(-1)).toEqual(submit("next message"));
		expect(session.getSnapshot().queue).toEqual([]);
	});

	it("waits for semantic menu dismissal before sending /restart", async () => {
		const session = preview(false);
		sendHost({ transport: "tsp", link: "L1", tspEpoch: 7, tspAvailability: { available: false, reason: "Close the open omp menu before sending a message." } });
		const prepared = Promise.withResolvers<boolean>();
		respond = channel => channel === "host:prepare-restart" ? prepared.promise : undefined;
		const restarting = session.restart();
		await flush();
		expect(invoked).toContainEqual(["host:prepare-restart", "h1", 1, 7]);
		expect(invoked.some(call => call[0] === "host:submit")).toBe(false);
		prepared.resolve(true);
		await restarting;
		expect(invoked).toContainEqual(submit("/restart"));
		expect(invoked.some(call => call[0] === "host:stop" || call[0] === "host:start")).toBe(false);
	});

	it.each([true, false])("keeps work that starts during restart preparation when dismissal returns %s", async dismissed => {
		const session = preview(false);
		sendHost({ transport: "tsp", link: "L1", tspEpoch: 7 });
		const prepared = Promise.withResolvers<boolean>();
		respond = channel => channel === "host:prepare-restart" ? prepared.promise : undefined;
		const restarting = session.restart(() => {
			if (workInFlight(session.getSnapshot())) throw new Error("Chat has work running");
		});
		const rejected = expect(restarting).rejects.toThrow("work running");
		await flush();
		fakes.guests.at(-1)?.emit("live", [u1, a1], true);
		prepared.resolve(dismissed);
		await rejected;
		expect(invoked.some(call => call[0] === "host:submit" || call[0] === "host:stop")).toBe(false);
	});

	it("relaunches the saved TSP session when autocomplete has no declared dismissal", async () => {
		const session = preview(false);
		sendHost({ transport: "tsp", link: "L1", tspEpoch: 7, tspAvailability: { available: false, reason: "Close the open omp menu before sending a message." } });
		respond = channel => channel === "host:prepare-restart" ? Promise.resolve(false) : channel === "host:start" ? Promise.resolve(host({ hostId: "h2", transport: "tsp" })) : undefined;
		await session.restart();
		expect(invoked.filter(call => call[0] === "host:stop")).toEqual([["host:stop", "h1"]]);
		expect(invoked.find(call => call[0] === "host:start")?.[1]).toMatchObject({ resumeFile: "/p/session.jsonl" });
		expect(invoked.some(call => call[0] === "host:submit")).toBe(false);
		expect(session.getSnapshot().host?.hostId).toBe("h2");
	});

	it.each(["tsp", "classic"] as const)("relaunches %s after its guest ends instead of waiting for a dead mirror", async transport => {
		const session = preview(false);
		sendHost({ transport, link: "L1", tspEpoch: 7, tspAvailability: { available: true, reason: null } });
		fakes.guests.at(-1)!.emit("ended", [u1, a1]);
		respond = channel => channel === "host:prepare-restart" ? Promise.resolve(true)
			: channel === "host:start" ? Promise.resolve(host({ hostId: "h2", transport })) : undefined;
		await session.restart();
		expect(invoked.filter(call => call[0] === "host:stop")).toEqual([["host:stop", "h1"]]);
		expect(invoked.find(call => call[0] === "host:start")?.[1]).toMatchObject({ resumeFile: "/p/session.jsonl" });
		expect(invoked.some(call => call[0] === "host:prepare-restart" || call[0] === "host:submit")).toBe(false);
		expect(session.getSnapshot().host?.hostId).toBe("h2");
	});

	it.each(["tsp", "classic"] as const)("keeps the existing %s Restart path while a guest is reconnecting", async transport => {
		const session = preview(false);
		sendHost({ transport, link: "L1", tspEpoch: 7 });
		const guest = fakes.guests.at(-1)!;
		guest.emit("reconnecting", [u1, a1]);
		respond = channel => channel === "host:prepare-restart" ? Promise.resolve(true) : undefined;
		const restarting = session.restart(); await flush();
		expect(invoked.some(call => call[0] === "host:stop" || call[0] === "host:start")).toBe(false);
		guest.emit("live", [u1, a1]); await restarting;
		expect(invoked).toContainEqual(submit("/restart"));
		expect(invoked.some(call => call[0] === "host:stop" || call[0] === "host:start")).toBe(false);
	});

	it("relaunches if the guest ends while semantic Restart preparation is pending", async () => {
		const session = preview(false);
		sendHost({ transport: "tsp", link: "L1", tspEpoch: 7 });
		const prepared = Promise.withResolvers<boolean>();
		respond = channel => channel === "host:prepare-restart" ? prepared.promise
			: channel === "host:start" ? Promise.resolve(host({ hostId: "h2", transport: "tsp" })) : undefined;
		const restarting = session.restart(); await flush();
		fakes.guests.at(-1)!.emit("ended", [u1, a1]);
		prepared.resolve(true); await restarting;
		expect(invoked.filter(call => call[0] === "host:stop")).toEqual([["host:stop", "h1"]]);
		expect(invoked.some(call => call[0] === "host:submit")).toBe(false);
		expect(session.getSnapshot().host?.hostId).toBe("h2");
	});

	it("relaunches classic required recovery without appending /restart to contaminated image input", async () => {
		const session = preview(false);
		sendHost({ transport: "classic", link: "L1" });
		failOnce("composer:paste", "Image submission needs recovery. Failed image text includes Image submission was restored. unsafe");
		await session.send("look", [shot]);
		expect(session.getSnapshot().strandedImages).toBe(true);
		expect(session.getSnapshot().queue[0]?.error).toBeUndefined();
		respond = channel => channel === "host:start" ? Promise.resolve(host({ hostId: "h2", transport: "classic" })) : undefined;
		await session.restart();
		expect(invoked.filter(call => call[0] === "host:stop")).toEqual([["host:stop", "h1", "editor-recovery"]]);
		expect(invoked.some(call => call[0] === "host:submit" || call[0] === "host:prepare-restart")).toBe(false);
		expect(session.getSnapshot().host?.hostId).toBe("h2");
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(session.getSnapshot().queue[0]).toMatchObject({ text: "look", images: [shot] });
	});

	it("does not restart a replacement generation after semantic preparation finishes late", async () => {
		const session = preview(false);
		sendHost({ transport: "tsp", link: "L1", tspEpoch: 7 });
		const prepared = Promise.withResolvers<boolean>();
		respond = channel => channel === "host:prepare-restart" ? prepared.promise : undefined;
		const restarting = session.restart();
		const rejected = expect(restarting).rejects.toThrow("chat changed");
		await flush();
		sendHost({ transport: "tsp", link: "L1", generation: 2, tspEpoch: 8 });
		prepared.resolve(true);
		await rejected;
		expect(invoked.some(call => call[0] === "host:submit" || call[0] === "host:stop" || call[0] === "host:start")).toBe(false);
	});

	it("acknowledges an inserted restoration once per delivery without duplicating its draft on recovery", async () => {
		const session = preview(false);
		useComposerDrafts.getState().forget(session.tabId);
		const capture = { id: "restore-retry", hostId: "h1", text: "Saved follow-up", cleared: false, error: null };
		sendHost({ transport: "tsp", link: "L1", tspEditorRestore: capture });
		expect(useComposerDrafts.getState().drafts[session.tabId]).toBe("Saved follow-up");
		expect(invoked.some(call => call[0] === "host:ack-editor-restore")).toBe(false);
		sendHost({ transport: "tsp", link: "L1", tspEditorRestore: { ...capture, cleared: true } });
		sendHost({ transport: "tsp", link: "L1", tspEditorRestore: { ...capture, cleared: true } });
		await flush();
		expect(invoked.filter(call => call[0] === "host:ack-editor-restore")).toEqual([["host:ack-editor-restore", "h1", capture.id]]);
		sendHost({ transport: "tsp", link: "L1", tspEditorRestore: { ...capture, cleared: true } });
		await flush();
		expect(useComposerDrafts.getState().drafts[session.tabId]).toBe("Saved follow-up");
		useComposerDrafts.getState().forget(session.tabId);
	});

	it("sends ordinary TSP approval messages immediately so omp denies and steers", async () => {
		const session = preview(true);
		const guest = fakes.guests.at(-1)!;
		guest.emit("live", [u1], true, { uiRequest: { reqId: 8, kind: "select", title: "Run command?", options: ["Approve Once", "Deny"] } });
		await deliver(session, "Do not run that.", [], false);
		expect(invoked).toContainEqual(submit("Do not run that."));
		expect(queued(session)).toEqual([]);
		expect(guest.sendPrompt).not.toHaveBeenCalled();
		await expect(session.command("/compact")).rejects.toThrow("Answer the approval");
	});

	it("returns actionable readiness failure to the composer without a persistent error status", async () => {
		const session = preview(false);
		const reason = `Error invoking remote method 'host:submit': Error: omp screen: The focused editor is not ready. Restart omp.`;
		failOnce("host:submit", reason);
		await expect(deliver(session, "keep this draft", [], false)).rejects.toThrow("Restart omp");
		expect(session.getSnapshot().queue).toEqual([]);
		expect(session.getSnapshot().inputHistory).toEqual([]);
		expect(session.getSnapshot().error).toBeNull();
		expect(chatStatus(session.getSnapshot())).toBe("live");
	});

	it("keeps an automatically delivered preview message queued and shows an actionable notice without red status", async () => {
		const session = preview(true);
		await session.send("keep this queued");
		failOnce("host:submit", "omp screen: The editor is not ready. Restart omp.");
		fakes.guests.at(-1)?.emit("live", [u1, a1], false);
		await flush();
		expect(queued(session)).toEqual(["keep this queued"]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({ tone: "warn", message: "omp screen: The editor is not ready. Restart omp." });
		expect(session.getSnapshot().error).toBeNull();
		expect(chatStatus(session.getSnapshot())).toBe("live");
	});

	it("keeps actual launch failures authoritative even when they quote omp screen errors", async () => {
		const reason = "omp startup failed while processing 'omp screen:'";
		failOnce("host:start", reason);
		const session = new SessionController({ tabId: "preview-start-failure", projectPath: "/p", sessionFile: null });
		await expect(session.send("keep this draft")).rejects.toThrow(reason);
		expect(session.getSnapshot().queue).toEqual([]);
		expect(session.getSnapshot().mode).toBe("exited");
		expect(session.getSnapshot().error).toBe(reason);
		expect(chatStatus(session.getSnapshot())).toBe("error");
	});

	it("restarts a failed semantic host only on request, preserving the saved chat and visible history", async () => {
		const session = new SessionController({ tabId: "preview-restart", projectPath: "/p", sessionFile: "/p/session.jsonl" });
		session.attach(host({ transport: "tsp", tspFailed: true, link: "L1" }));
		fakes.guests.at(-1)?.emit("live", [u1, a1]);
		session.recordInput("Earlier prompt", 10);
		expect(invoked.some(call => call[0] === "host:stop")).toBe(false);
		respond = channel => channel === "host:start" ? Promise.resolve(host({ hostId: "h2", transport: "tsp" })) : undefined;
		await session.restart();
		expect(invoked.filter(call => call[0] === "host:stop")).toEqual([["host:stop", "h1"]]);
		expect(invoked.find(call => call[0] === "host:start")?.[1]).toMatchObject({ cwd: "/p", resumeFile: "/p/session.jsonl" });
		expect(invoked.some(call => call[0] === "host:submit")).toBe(false);
		expect(session.getSnapshot().host?.hostId).toBe("h2");
		expect(ids(liveEntries(session.getSnapshot()))).toEqual(["u1", "a1"]);
		expect(session.getSnapshot().inputHistory).toContainEqual({ text: "Earlier prompt", timestamp: 10 });
	});

	it.each(["Invalid TSP JSON", "Invalid TSP surface"])("restarts after a live protocol failure by stopping before saved-session relaunch: %s", async diagnostic => {
		const session = new SessionController({ tabId: "protocol-failed-restart", projectPath: "/p", sessionFile: "/p/session.jsonl" });
		session.attach(host({ transport: "tsp", tspFailed: false, tspEpoch: 7, link: "L1" }));
		fakes.guests.at(-1)?.emit("live", [u1, a1]);
		sendHost({ transport: "tsp", tspFailed: true, tspEpoch: 7, link: "L1", tspAvailability: { available: false, reason: diagnostic } });
		const stopped = Promise.withResolvers<null>();
		respond = channel => channel === "host:prepare-restart" ? Promise.reject(new Error("Failed protocols cannot prepare restart"))
			: channel === "host:stop" ? stopped.promise
			: channel === "host:start" ? Promise.resolve(host({ hostId: "h2", transport: "tsp", tspFailed: false, link: "L2" })) : undefined;
		const restarting = session.restart();
		await flush();
		expect(invoked.filter(call => call[0] === "host:stop")).toEqual([["host:stop", "h1"]]);
		expect(invoked.some(call => call[0] === "host:prepare-restart" || call[0] === "host:submit" || call[0] === "host:start")).toBe(false);
		expect(ids(liveEntries(session.getSnapshot()))).toEqual(["u1", "a1"]);
		stopped.resolve(null);
		await restarting;
		expect(invoked.find(call => call[0] === "host:start")?.[1]).toMatchObject({ cwd: "/p", resumeFile: "/p/session.jsonl" });
		expect(session.getSnapshot().host).toMatchObject({ hostId: "h2", tspFailed: false });
		expect(invoked.some(call => call[0] === "host:prepare-restart" || call[0] === "host:submit")).toBe(false);
		expect(ids(liveEntries(session.getSnapshot()))).toEqual(["u1", "a1"]);
	});

	it("does not relaunch a failed semantic host when its explicit stop fails", async () => {
		const session = new SessionController({ tabId: "preview-restart-stop-failed", projectPath: "/p", sessionFile: "/p/session.jsonl" });
		session.attach(host({ transport: "tsp", tspFailed: true }));
		failOnce("host:stop", "Could not stop omp");
		await expect(session.restart()).rejects.toThrow("Could not stop omp");
		expect(invoked.some(call => call[0] === "host:start")).toBe(false);
		expect(session.getSnapshot().host?.hostId).toBe("h1");
	});

	it("shares simultaneous failed-host restart requests", async () => {
		const session = new SessionController({ tabId: "preview-restart-once", projectPath: "/p", sessionFile: "/p/session.jsonl" });
		session.attach(host({ transport: "tsp", tspFailed: true }));
		const stopped = Promise.withResolvers<null>();
		respond = channel => channel === "host:stop" ? stopped.promise : channel === "host:start" ? Promise.resolve(host({ hostId: "h2", transport: "tsp" })) : undefined;
		const first = session.restart(); const second = session.restart();
		await flush();
		expect(invoked.filter(call => call[0] === "host:stop")).toHaveLength(1);
		stopped.resolve(null);
		await Promise.all([first, second]);
		expect(invoked.filter(call => call[0] === "host:start")).toHaveLength(1);
	});

	it("preserves an actual host exit reason for an in-flight readiness waiter", async () => {
		const session = new SessionController({ tabId: "preview-exit", projectPath: "/p", sessionFile: null });
		session.attach(host({ transport: "tsp", phase: "connecting", link: "L1" }));
		const ready = session.whenLive();
		await flush();
		sendHost({ transport: "tsp", phase: "exited", error: "connection lost" });
		await expect(ready).rejects.toThrow("connection lost");
		expect(session.getSnapshot().error).toBe("connection lost");
		expect(chatStatus(session.getSnapshot())).toBe("error");
	});

	it("keeps ordinary host failures as errors", () => {
		const session = preview(false);
		sendHost({ transport: "tsp", link: "L1", error: "connection lost" });
		expect(session.getSnapshot().error).toBe("connection lost");
		expect(chatStatus(session.getSnapshot())).toBe("error");
	});

	it("does not suppress authoritative omp error status that quotes omp screen errors", () => {
		const session = preview(false);
		const programStatus = { state: "error" as const, msg: "omp task failed while processing 'omp screen:'" };
		sendHost({ transport: "tsp", link: "L1", programStatus });
		expect(session.getSnapshot().host?.programStatus).toBe(programStatus);
		expect(chatStatus(session.getSnapshot())).toBe("error");
	});
});

it("keeps plain preview sends on the composer’s existing explicit steer submit mode", async () => {
	const session = idle("preview-plain");
	sendHost({ transport: "tsp", link: "L1", tui: tui(0) });
	await deliver(session, "plain text", [], false);
	expect(invoked).toEqual([submit("plain text")]);
	expect(session.getSnapshot().error).toBeNull();
});

describe("SessionController queue around omp's own screens", () => {
	it("holds a queued command while omp's full-screen report is open at turn end, then sends it once the report closes", async () => {
		const calls = fakeDelivery();
		const session = working("q1");
		await session.send("/fast status");
		// A command sent now opened a full-screen report; the turn ends behind it.
		sendHost({ link: "L1", tui: tui(1) });
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(calls).toEqual([]);
		expect(queued(session)).toEqual(["/fast status"]);
		sendHost({ link: "L1", tui: tui(0) });
		await flush();
		expect(calls.map(call => call.line)).toEqual(["/fast status"]);
		expect(queued(session)).toEqual([]);
	});

	it("drains once when a slash delivery and a screen hold both end", async () => {
		const calls = fakeDelivery();
		const session = working("q2");
		await session.send("/a");
		await session.send("/b");
		await session.send("/c");
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(calls.map(call => call.line)).toEqual(["/a"]);
		// "/a" opened omp's own screen: its watch holds the queue until the editor is back.
		const screen = Promise.withResolvers<void>();
		session.holdQueue(screen.promise);
		calls[0]?.done();
		await flush();
		expect(calls.map(call => call.line)).toEqual(["/a"]);
		screen.resolve();
		await flush();
		expect(calls.map(call => call.line)).toEqual(["/a", "/b"]);
		expect(queued(session)).toEqual(["/c"]);
	});

	it("puts back a command that found omp's screen open and sends it when the screen closes", async () => {
		const gate = Promise.withResolvers<void>();
		const lines: string[] = [];
		setSlashDelivery(async (session, line) => {
			lines.push(line);
			if (lines.length === 1) {
				session.holdQueue(gate.promise);
				throw new Error("busy");
			}
		});
		const session = working("q3");
		await session.send("/a");
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(lines).toEqual(["/a"]);
		expect(queued(session)).toEqual(["/a"]);
		// Nothing else drains it meanwhile: a turn ending behind the screen leaves it queued.
		fakes.guests[0]?.emit("live", [u1, a1], true);
		fakes.guests[0]?.emit("live", [u1, a1, u2], false);
		await flush();
		expect(lines).toEqual(["/a"]);
		gate.resolve();
		await flush();
		expect(lines).toEqual(["/a", "/a"]);
		expect(queued(session)).toEqual([]);
	});
});

describe("SessionController queue with images", () => {
	it("queues a message with images while omp works and sends it with its images after the turn", async () => {
		const session = working("m1");
		await deliver(session, "what is this?", [shot], false);
		expect(invoked).toEqual([]);
		expect(session.getSnapshot().queue).toMatchObject([{ text: "what is this?", images: [shot] }]);
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(invoked).toEqual([pasteShot, submit("what is this?")]);
		expect(queued(session)).toEqual([]);
	});

	it("queues a message with images behind waiting messages and sends them one turn at a time", async () => {
		const session = working("m2");
		await deliver(session, "first", [], false);
		await deliver(session, "second", [shot], false);
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(invoked).toEqual([submit("first")]);
		// omp has not reported the turn for "first" yet: the new message waits, and "second" stays queued.
		await deliver(session, "third", [shot], false);
		await flush();
		expect(invoked).toEqual([submit("first")]);
		expect(queued(session)).toEqual(["second", "third"]);
		fakes.guests[0]?.emit("live", [u1, a1, u2], true);
		fakes.guests[0]?.emit("live", [u1, a1, u2], false);
		await flush();
		expect(invoked).toEqual([submit("first"), pasteShot, submit("second")]);
		expect(queued(session)).toEqual(["third"]);
	});

	it("sends a message with images at once with Send now, steering the running turn", async () => {
		const session = working("m3");
		await deliver(session, "first", [], false);
		await deliver(session, "look here", [shot], true);
		expect(invoked).toEqual([pasteShot, submit("look here")]);
		expect(queued(session)).toEqual(["first"]);
	});

	it("submits a queued image-only message through the guarded submit path", async () => {
		const session = working("m4");
		await deliver(session, "", [shot], false);
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(invoked).toEqual([pasteShot, submit("")]);
	});
});

describe("SessionController queue admission and acknowledgement", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("queues Enter while the last queued slash command is still being delivered", async () => {
		const calls = fakeDelivery();
		const session = working("g1");
		await session.send("/fast status");
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(calls.map(call => call.line)).toEqual(["/fast status"]);
		// The queue is empty and omp is idle, but the command is still being typed and watched.
		await deliver(session, "hi", [], false);
		expect(invoked).toEqual([]);
		expect(queued(session)).toEqual(["hi"]);
		calls[0]?.done();
		await flush();
		expect(invoked).toEqual([submit("hi")]);
	});

	it("queues Enter while omp's full-screen menu is open or a hold stands, and sends it afterwards", async () => {
		const session = idle("g2", 1);
		await deliver(session, "after the menu", [shot], false);
		expect(invoked).toEqual([]);
		sendHost({ link: "L1", tui: tui(0) });
		await flush();
		expect(invoked).toEqual([pasteShot, submit("after the menu")]);

		const held = idle("g3");
		const screen = Promise.withResolvers<void>();
		held.holdQueue(screen.promise);
		await deliver(held, "after the hold", [], false);
		expect(queued(held)).toEqual(["after the hold"]);
		screen.resolve();
		await flush();
		expect(invoked.at(-1)).toEqual(submit("after the hold"));
	});

	it("queues Enter pressed right after an idle slash command until the command's watch ends", async () => {
		const session = idle("g4");
		const typing = sendSlashCommand(session, "/fast status");
		await deliver(session, "hi", [], false);
		await typing;
		await flush();
		expect(invoked).toEqual([submit("/fast status")]);
		expect(queued(session)).toEqual(["hi"]);
		fakes.watch.end.resolve();
		await flush();
		expect(invoked).toEqual([submit("/fast status"), submit("hi")]);
	});

	it("waits however long the paste and the turn start take before sending the next message", async () => {
		vi.useFakeTimers();
		const paste = Promise.withResolvers<null>();
		respond = channel => (channel === "composer:paste" ? paste.promise : undefined);
		const session = idle("g5");
		const first = deliver(session, "look", [shot], false);
		await deliver(session, "next", [], false);
		vi.advanceTimersByTime(60_000);
		await flush();
		expect(invoked).toEqual([pasteShot]);
		paste.resolve(null);
		await first;
		vi.advanceTimersByTime(60_000);
		await flush();
		expect(invoked).toEqual([pasteShot, submit("look")]);
		expect(queued(session)).toEqual(["next"]);
		fakes.guests[0]?.emit("live", [u1, u2], true);
		fakes.guests[0]?.emit("live", [u1, u2, a1], false);
		await flush();
		expect(invoked).toEqual([pasteShot, submit("look"), submit("next")]);
	});

	/** The entry omp appends when a shell line it ran itself finishes. */
	const shellResult = (id: string, command: string) =>
		({
			type: "message",
			id,
			parentId: "u1",
			timestamp: "",
			message: { role: "bashExecution", command, output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
		}) as unknown as SessionEntry;

	it("sends the next message once omp appends the shell line's own result, and not for another entry", async () => {
		const session = idle("g6");
		await deliver(session, "!ls -la", [], false);
		await deliver(session, "next", [], false);
		expect(invoked).toEqual([submit("!ls -la")]);
		// Unrelated entries arrive first: a reply and the result of another command.
		fakes.guests[0]?.emit("live", [u1, a1, shellResult("b0", "pwd")], false);
		await flush();
		expect(invoked).toEqual([submit("!ls -la")]);
		expect(queued(session)).toEqual(["next"]);
		fakes.guests[0]?.emit("live", [u1, a1, shellResult("b0", "pwd"), shellResult("b1", "ls -la")], false);
		await flush();
		expect(invoked).toEqual([submit("!ls -la"), submit("next")]);
	});

	it("moves the queue on when the turn a Send now message steered ends before its write finishes", async () => {
		const write = Promise.withResolvers<null>();
		const session = working("g7");
		await deliver(session, "a", [], false);
		respond = channel => (channel === "host:submit" ? write.promise : undefined);
		const steering = deliver(session, "steer this", [], true);
		await flush();
		// omp took the message into the turn (its user entry) and the turn ended, all before the write returned.
		fakes.guests[0]?.emit("live", [u1, u2], true);
		fakes.guests[0]?.emit("live", [u1, u2, a1], false);
		await flush();
		expect(invoked).toEqual([submit("steer this")]);
		respond = null;
		write.resolve(null);
		await steering;
		await flush();
		expect(invoked).toEqual([submit("steer this"), submit("a")]);
	});

	it("drops a write's wait when omp stops or changes rooms before the write finishes", async () => {
		for (const change of ["exit", "room"] as const) {
			invoked = [];
			fakes.guests.length = 0;
			const write = Promise.withResolvers<null>();
			respond = channel => (channel === "host:submit" ? write.promise : undefined);
			const session = idle(`g8-${change}`);
			const first = deliver(session, "first", [], false);
			await deliver(session, "next", [], false);
			await flush();
			if (change === "exit") sendHost({ phase: "exited", link: null, exitCode: 0 });
			sendHost({ link: "L2", tui: tui(0), generation: 2 });
			respond = null;
			write.resolve(null);
			await first;
			fakes.guests.at(-1)?.emit("live", [u1], false);
			// The old room's counters can't acknowledge "first", so nothing waits for them: the next send moves the queue.
			await deliver(session, "third", [], false);
			await flush();
			expect(invoked.filter(call => call[0] === "host:submit")).toEqual([submit("first"), submit("next")]);
			expect(queued(session)).toEqual(["third"]);
			await session.dispose();
		}
	});

	it("keeps a queued message first in line when its delivery fails, and delivers it later", async () => {
		failOnce("host:submit", "pty closed");
		const session = working("g9");
		await deliver(session, "a", [], false);
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(queued(session)).toEqual(["a"]);
		await deliver(session, "b", [], false);
		await flush();
		expect(invoked).toEqual([submit("a"), submit("a")]);
		expect(queued(session)).toEqual(["b"]);
	});

	/** omp's partial failure: the paste of A's images got through, its submit did not; B waits behind A. */
	async function strandedAfterTurn(tabId: string) {
		failOnce("host:submit", "pty closed");
		const session = working(tabId);
		await deliver(session, "look", [shot], false);
		await deliver(session, "b", [], false);
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(invoked).toEqual([pasteShot, submit("look")]);
		expect(session.getSnapshot().strandedImages).toBe(true);
		return session;
	}
	/** "Restart omp": the app types /restart, and omp comes back in a new room with a new, empty editor. */
	async function restartOmp(session: SessionController) {
		await session.restart();
		sendHost({ link: "L9", tui: tui(0), generation: 9 });
		await flush();
	}

	it("writes nothing into omp after a failed submit left images there until omp restarts, even when the message is removed", async () => {
		const session = await strandedAfterTurn("g10");
		const [look, b] = session.getSnapshot().queue;
		await expect(session.sendNow(b?.id ?? "")).rejects.toThrow("Restart omp to clear it");
		await expect(session.sendNow(look?.id ?? "")).rejects.toThrow("Restart omp to clear it");
		await expect(session.command("/compact")).rejects.toThrow("Restart omp to clear it");
		fakes.guests[0]?.emit("live", [u1, a1], true);
		await deliver(session, "steer", [], true);
		session.removeQueued(look?.id ?? "");
		fakes.guests[0]?.emit("live", [u1, a1, u2], false);
		await flush();
		// Removing the message did not release the hold: B never reached the editor that may hold the images.
		expect(invoked).toEqual([pasteShot, submit("look")]);
		expect(queued(session)).toEqual(["b", "steer"]);
		expect(session.getSnapshot().strandedImages).toBe(true);
		await restartOmp(session);
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(invoked).toEqual([pasteShot, submit("look"), submit("/restart"), submit("b")]);
	});

	it("releases the hold only on a generation after the restart, and then pastes the images exactly once", async () => {
		const session = await strandedAfterTurn("g11");
		const typed = () => invoked.filter(call => call[0] === "composer:paste" || call[0] === "host:submit");
		// A new room without a restart (a new session, say) keeps the editor, so the hold stays.
		sendHost({ link: "L2", tui: tui(0), generation: 2 });
		fakes.guests.at(-1)?.emit("live", [u1], false);
		await deliver(session, "c", [], false);
		await flush();
		expect(typed()).toEqual([pasteShot, submit("look")]);

		// A restart that failed to type keeps the hold, even through a later room change.
		failOnce("host:submit", "pty closed");
		await expect(session.restart()).rejects.toThrow("pty closed");
		sendHost({ link: "L3", tui: tui(0), generation: 3 });
		fakes.guests.at(-1)?.emit("live", [u1], false);
		await flush();
		expect(session.getSnapshot().strandedImages).toBe(true);

		// Updates within the generation /restart was typed in keep it too, during and after the write.
		const write = Promise.withResolvers<null>();
		respond = channel => (channel === "host:submit" ? write.promise : undefined);
		const restarting = session.restart();
		await flush();
		sendHost({ link: "L3", tui: tui(0), generation: 3 });
		await flush();
		respond = null;
		write.resolve(null);
		await restarting;
		sendHost({ link: "L3", tui: tui(0), generation: 3 });
		await flush();
		expect(session.getSnapshot().strandedImages).toBe(true);
		expect(typed()).toEqual([pasteShot, submit("look"), submit("/restart"), submit("/restart")]);

		// The restarted omp's room is the next generation: its editor is empty, so A goes with one fresh paste.
		sendHost({ link: "L4", tui: tui(0), generation: 4 });
		await flush();
		expect(session.getSnapshot().strandedImages).toBe(false);
		expect(typed()).toEqual([pasteShot, submit("look"), submit("/restart"), submit("/restart"), pasteShot, submit("look")]);
		expect(queued(session)).toEqual(["b", "c"]);
		// B waits for omp's turn for A, then goes.
		fakes.guests.at(-1)?.emit("live", [u1], true);
		fakes.guests.at(-1)?.emit("live", [u1, u2, a1], false);
		await flush();
		expect(invoked.at(-1)).toEqual(submit("b"));
	});

	it("keeps a composer message whose submit failed after its paste in the queue until omp restarts", async () => {
		failOnce("host:submit", "pty closed");
		const session = idle("g13");
		await deliver(session, "look", [shot], false);
		expect(queued(session)).toEqual(["look"]);
		await deliver(session, "next", [], false);
		await flush();
		expect(invoked).toEqual([pasteShot, submit("look")]);
		await restartOmp(session);
		expect(invoked).toEqual([pasteShot, submit("look"), submit("/restart"), pasteShot, submit("look")]);
		expect(queued(session)).toEqual(["next"]);

		// Without a paste nothing can be left in omp, so the composer gets the message back.
		failOnce("host:submit", "pty closed");
		const plain = idle("g14");
		await expect(deliver(plain, "hi", [], false)).rejects.toThrow("pty closed");
		expect(queued(plain)).toEqual([]);
		expect(plain.getSnapshot().strandedImages).toBe(false);
	});

	it("waits for the turn of a message sent while idle, even after omp records its user entry", async () => {
		const session = idle("g18");
		await deliver(session, "a", [], false);
		await deliver(session, "b", [], false);
		fakes.guests[0]?.emit("live", [u1, u2], false);
		await flush();
		expect(invoked).toEqual([submit("a")]);
		expect(queued(session)).toEqual(["b"]);
		fakes.guests[0]?.emit("live", [u1, u2], true);
		await flush();
		expect(invoked).toEqual([submit("a")]);
		fakes.guests[0]?.emit("live", [u1, u2, a1], false);
		await flush();
		expect(invoked).toEqual([submit("a"), submit("b")]);
	});

	it("puts a message back in its place when Send now fails, and rejects with the reason", async () => {
		const session = working("g15");
		await deliver(session, "a", [], false);
		await deliver(session, "b", [], false);
		await deliver(session, "c", [], false);
		failOnce("host:submit", "pty closed");
		const id = session.getSnapshot().queue[1]?.id ?? "";
		await expect(session.sendNow(id)).rejects.toThrow("pty closed");
		expect(queued(session)).toEqual(["a", "b", "c"]);
	});

	it("puts a slash command back in its place when Send now can't type it, and rejects with the reason", async () => {
		setSlashDelivery(async () => {
			throw new Error("omp shows a menu");
		});
		const session = working("g16");
		await deliver(session, "a", [], false);
		await session.send("/fast on");
		await deliver(session, "c", [], false);
		const id = session.getSnapshot().queue[1]?.id ?? "";
		await expect(session.sendNow(id)).rejects.toThrow("omp shows a menu");
		expect(queued(session)).toEqual(["a", "/fast on", "c"]);
	});

	it("leaves exactly one copy, the caller's, when omp fails to start", async () => {
		respond = channel => (channel === "host:start" ? Promise.reject(new Error("omp is missing")) : undefined);
		const session = new SessionController({ tabId: "g17", projectPath: "/p", sessionFile: null });
		await expect(deliver(session, "hi", [shot], false)).rejects.toThrow("omp is missing");
		expect(session.getSnapshot().queue).toEqual([]);
	});
});

describe("SessionController sends that bring the transcript to its end", () => {
	function sentEvents(session: SessionController): string[] {
		const events: string[] = [];
		session.onEvent(event => {
			if (event.kind === "sent") events.push(event.kind);
		});
		return events;
	}

	it("reports Enter while omp is idle, and not the message after it that waits for that turn", async () => {
		const session = idle("s1");
		const sent = sentEvents(session);
		await deliver(session, "a", [], false);
		expect(sent).toEqual(["sent"]);
		await deliver(session, "b", [], false);
		expect(queued(session)).toEqual(["b"]);
		expect(sent).toEqual(["sent"]);
	});

	it("does not report a message that joins the queue, nor its delivery when the turn ends", async () => {
		const session = working("s2");
		const sent = sentEvents(session);
		await deliver(session, "later", [], false);
		expect(queued(session)).toEqual(["later"]);
		fakes.guests[0]?.emit("live", [u1, a1], false);
		await flush();
		expect(invoked).toEqual([submit("later")]);
		expect(sent).toEqual([]);
	});

	it("reports Send now from the composer and from the queue tray", async () => {
		const session = working("s3");
		const sent = sentEvents(session);
		await deliver(session, "steer", [], true);
		expect(sent).toEqual(["sent"]);
		await deliver(session, "queued", [], false);
		expect(sent).toEqual(["sent"]);
		await session.sendNow(session.getSnapshot().queue[0]?.id ?? "");
		expect(sent).toEqual(["sent", "sent"]);
		expect(invoked).toEqual([submit("steer"), submit("queued")]);
	});

	it("reports a slash command typed at once and a shell line, and not a slash command that queues", async () => {
		const session = idle("s4");
		const sent = sentEvents(session);
		await sendSlashCommand(session, "/fast status");
		expect(sent).toEqual(["sent"]);
		fakes.watch.end.resolve();
		await flush();
		await deliver(session, "!ls", [], false);
		expect(sent).toEqual(["sent", "sent"]);

		const busy = working("s5");
		const busySent = sentEvents(busy);
		await sendSlashCommand(busy, "/fast status");
		expect(queued(busy)).toEqual(["/fast status"]);
		expect(busySent).toEqual([]);
	});

	it("reports a message sent while omp is still starting, which goes out first once omp runs", () => {
		respond = channel => (channel === "host:start" ? Promise.withResolvers<null>().promise : undefined);
		const session = new SessionController({ tabId: "s6", projectPath: "/p", sessionFile: null });
		const sent = sentEvents(session);
		void deliver(session, "first", [], false);
		expect(queued(session)).toEqual(["first"]);
		expect(sent).toEqual(["sent"]);
		void deliver(session, "second", [], false);
		expect(sent).toEqual(["sent"]);
	});
});

describe("delivered composer input history", () => {
	it("records successful Send now text, excluding queued rows and failed submissions", async () => {
		const session = working("history-send");
		await session.send("queued");
		expect(session.getSnapshot().inputHistory).toEqual([]);
		failOnce("host:submit", "pty closed");
		await expect(session.sendNow(session.getSnapshot().queue[0]!.id)).rejects.toThrow("pty closed");
		expect(session.getSnapshot().inputHistory).toEqual([]);
		await session.sendNow(session.getSnapshot().queue[0]!.id);
		expect(session.getSnapshot().inputHistory.map(item => item.text)).toEqual(["queued"]);
	});

	it.each(["hello", "!pwd", "$ print(1)"])("records successful direct input: %s", async text => {
		const session = idle("history-direct");
		await session.send(text);
		expect(session.getSnapshot().inputHistory).toEqual([{ text, timestamp: expect.any(Number) }]);
	});

	it("preserves delivered input through a restart, but clears it when the session file changes", () => {
		const session = working("history-room");
		session.recordInput("hello", 123);
		sendHost({ link: "L2", generation: 2 });
		expect(session.getSnapshot().inputHistory).toEqual([{ text: "hello", timestamp: 123 }]);
		sendHost({ link: "L3", generation: 3, sessionFile: "/p/other.jsonl", sessionId: "other" });
		expect(session.getSnapshot().inputHistory).toEqual([]);
	});
});

describe("native crash and worktree lifecycle", () => {
	it("updates the controller's folder and saved file together when omp relocates", () => {
		const session = new SessionController({ tabId: "moved", projectPath: "/p", sessionFile: "/p/session.jsonl" });
		session.attach(host({ cwd: "/worktree", sessionFile: "/worktree/session.jsonl" }));
		expect(session.projectPath).toBe("/worktree");
		expect(session.sessionFile).toBe("/worktree/session.jsonl");
	});
	it("restores interrupted work only when the user selects crash recovery", async () => {
		const session = new SessionController({ tabId: "crashed", projectPath: "/p", sessionFile: "/p/session.jsonl" });
		session.attach(host({ phase: "exited", exitCode: 1, restoreAvailable: true }));
		respond = channel => channel === "host:start" ? Promise.resolve(host({})) : undefined;
		await session.restore();
		expect(invoked.find(call => call[0] === "host:start")?.[1]).toMatchObject({ resumeFile: "/p/session.jsonl", restore: true });
	});
	it("announces an OSC-only block once, and again after the next working state", () => {
		const session = new SessionController({ tabId: "blocked", projectPath: "/p", sessionFile: null });
		session.attach(host({}));
		const events: string[] = []; session.onEvent(event => events.push(event.kind));
		sendHost({ programStatus: { state: "blocked", kind: "permission", msg: "Approve command?" } });
		sendHost({ programStatus: { state: "blocked", kind: "permission", msg: "Approve command?" } });
		expect(events).toEqual(["needsInput"]);
		sendHost({ programStatus: { state: "working" } });
		sendHost({ programStatus: { state: "blocked", kind: "question" } });
		expect(events).toEqual(["needsInput", "needsInput"]);
	});
});

describe("large saved chat warning", () => {
	const ask = vi.fn<ResumeGuard>();
	beforeEach(() => {
		ask.mockReset();
		setResumeGuard(ask);
	});
	afterEach(() => setResumeGuard(async () => true));

	/**
	 * Main answers the size checks in order from `sizes`, starts omp on the file it is asked to resume (the call's
	 * arguments are the last `invoked` entry), and leaves other channels to `other`.
	 */
	const answer = (sizes: Array<number | null | Promise<number | null>>, other?: (channel: string) => Promise<unknown> | undefined) => {
		respond = channel => {
			if (channel === "sessions:size") return Promise.resolve(sizes.shift() ?? null);
			if (channel === "host:start") {
				// `invoke` records each call before answering it, so the last entry holds this start's options.
				const options = invoked.at(-1)?.[1] as HostStartOptions | undefined;
				return Promise.resolve(host({ sessionFile: options?.resumeFile ?? null }));
			}
			return other?.(channel);
		};
	};
	/** Main reports `bytes` for every size check of the saved file. */
	const saved = (file: string, bytes: number | null) => {
		answer(Array.from({ length: 4 }, () => bytes));
		return new SessionController({ tabId: file, projectPath: "/p", sessionFile: file });
	};
	const starts = () => invoked.filter(call => call[0] === "host:start");
	const asked = () => ask.mock.calls.map(([request]) => request.file);
	const LARGE = LARGE_RESUME_BYTES * 2;

	it("asks at the size limit, and declining keeps omp stopped and gives the message back", async () => {
		ask.mockResolvedValue(false);
		const session = saved("/p/declined.jsonl", LARGE_RESUME_BYTES);
		await expect(session.send("continue the refactor")).rejects.toBeInstanceOf(ResumeDeclinedError);
		expect(ask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tabId: "/p/declined.jsonl", projectPath: "/p", file: "/p/declined.jsonl", bytes: LARGE_RESUME_BYTES }));
		expect(starts()).toEqual([]);
		expect(session.getSnapshot()).toMatchObject({ mode: "history", queue: [], error: null });
	});

	it("passes the submitted text and attachments to the guard and consumes only the transferred send", async () => {
		const images = [{ path: "/p/reference.png", name: "reference.png" }];
		ask.mockImplementation(async request => {
			expect(request.message).toEqual({ text: "continue with this image", images });
			request.messageTransferred = true;
			return false;
		});
		const session = saved("/p/transferred.jsonl", LARGE);
		await expect(session.send("continue with this image", images)).resolves.toBeUndefined();
		expect(starts()).toEqual([]);
		expect(session.getSnapshot()).toMatchObject({ mode: "history", queue: [], error: null });
	});

	it("does not consume a second send sharing the transferred send's launch", async () => {
		const choice = Promise.withResolvers<boolean>();
		ask.mockImplementation(request => {
			request.messageTransferred = true;
			return choice.promise;
		});
		const session = saved("/p/transferred-concurrent.jsonl", LARGE);
		const first = session.send("same message");
		const second = expect(session.send("same message")).rejects.toBeInstanceOf(ResumeDeclinedError);
		await flush();
		expect(ask).toHaveBeenCalledOnce();
		choice.resolve(false);
		await expect(first).resolves.toBeUndefined();
		await second;
		expect(session.getSnapshot().queue).toEqual([]);
		expect(starts()).toEqual([]);
	});

	it.each([LARGE_RESUME_BYTES - 1, null])("resumes a saved chat of %s bytes without asking", async bytes => {
		const session = saved(`/p/small-${bytes}.jsonl`, bytes);
		await session.ensureLive();
		expect(ask).not.toHaveBeenCalled();
		expect(starts()[0]?.[1]).toMatchObject({ resumeFile: `/p/small-${bytes}.jsonl` });
	});

	it("remembers an approval, so reopening the same file resumes without asking again", async () => {
		ask.mockResolvedValue(true);
		await saved("/p/approved.jsonl", LARGE_RESUME_BYTES * 2).ensureLive();
		await saved("/p/approved.jsonl", LARGE_RESUME_BYTES * 2).ensureLive();
		expect(ask).toHaveBeenCalledOnce();
		expect(starts().map(call => call[1])).toEqual([expect.objectContaining({ resumeFile: "/p/approved.jsonl" }), expect.objectContaining({ resumeFile: "/p/approved.jsonl" })]);
	});

	it("relaunches a chat whose omp already ran without asking", async () => {
		const session = saved("/p/ran.jsonl", LARGE_RESUME_BYTES * 2);
		session.attach(host({ sessionFile: "/p/ran.jsonl" }));
		sendHost({ phase: "exited", exitCode: 1, sessionFile: "/p/ran.jsonl" });
		await session.ensureLive();
		expect(ask).not.toHaveBeenCalled();
		expect(starts()[0]?.[1]).toMatchObject({ resumeFile: "/p/ran.jsonl" });
	});

	it("closing the chat while the warning is open ends the start without launching omp", async () => {
		ask.mockImplementation(request => {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			request.signal.addEventListener("abort", () => resolve(false));
			return promise;
		});
		const session = saved("/p/closed.jsonl", LARGE_RESUME_BYTES * 2);
		const starting = expect(session.ensureLive()).rejects.toBeInstanceOf(ResumeDeclinedError);
		await flush();
		expect(ask).toHaveBeenCalledOnce();
		await session.dispose();
		await starting;
		expect(starts()).toEqual([]);
	});

	it("asks once for concurrent starts and asks again after a decline", async () => {
		const first = Promise.withResolvers<boolean>();
		ask.mockReturnValueOnce(first.promise).mockResolvedValueOnce(true);
		const session = saved("/p/retried.jsonl", LARGE);
		const starting = [session.ensureLive(), session.ensureLive()];
		await flush();
		first.resolve(false);
		for (const start of starting) await expect(start).rejects.toBeInstanceOf(ResumeDeclinedError);
		await session.ensureLive();
		expect(asked()).toEqual(["/p/retried.jsonl", "/p/retried.jsonl"]);
		expect(starts()).toHaveLength(1);
	});

	it("checks omp's newer linked copy when the chat moves to it during the size check", async () => {
		const olderSize = Promise.withResolvers<number | null>();
		answer([olderSize.promise, LARGE], channel => channel === "sessions:resolve" ? Promise.resolve("/p/newer.jsonl") : channel === "sessions:ownership" ? Promise.resolve("free") : undefined);
		ask.mockResolvedValue(true);
		const session = new SessionController({ tabId: "moved", projectPath: "/p", sessionFile: "/p/older.jsonl" });
		const starting = session.ensureLive();
		await flush();
		await session.loadHistory();
		olderSize.resolve(LARGE);
		await starting;
		expect(asked()).toEqual(["/p/newer.jsonl"]);
		expect(starts().map(call => call[1])).toEqual([expect.objectContaining({ resumeFile: "/p/newer.jsonl" })]);
	});

	it("never lets an approval for one file start omp on the copy the chat moved to while asking", async () => {
		const older = Promise.withResolvers<boolean>();
		ask.mockReturnValueOnce(older.promise).mockResolvedValueOnce(false);
		answer([LARGE, LARGE], channel => channel === "sessions:resolve" ? Promise.resolve("/p/moved-newer.jsonl") : channel === "sessions:ownership" ? Promise.resolve("free") : undefined);
		const session = new SessionController({ tabId: "moved-asking", projectPath: "/p", sessionFile: "/p/moved-older.jsonl" });
		const starting = expect(session.ensureLive()).rejects.toBeInstanceOf(ResumeDeclinedError);
		await flush();
		await session.loadHistory();
		older.resolve(true);
		await starting;
		expect(asked()).toEqual(["/p/moved-older.jsonl", "/p/moved-newer.jsonl"]);
		expect(starts()).toEqual([]);
	});

	it("starts nothing when another omp opens the chat while the warning waits", async () => {
		const answered = Promise.withResolvers<boolean>();
		ask.mockReturnValue(answered.promise);
		answer([LARGE], channel => channel === "sessions:ownership" ? Promise.resolve("elsewhere") : undefined);
		const session = new SessionController({ tabId: "taken", projectPath: "/p", sessionFile: "/p/taken.jsonl" });
		const starting = expect(session.ensureLive()).rejects.toThrow("open elsewhere");
		await flush();
		await session.checkOwnership();
		answered.resolve(true);
		await starting;
		expect(starts()).toEqual([]);
	});

	it("asks after a start that failed, because omp never ran for the chat", async () => {
		answer([LARGE_RESUME_BYTES - 1, LARGE]);
		const succeed = respond!;
		let attempts = 0;
		respond = channel => channel === "host:start" && attempts++ === 0 ? Promise.reject(new Error("omp could not start")) : succeed(channel);
		ask.mockResolvedValue(true);
		const session = new SessionController({ tabId: "grew", projectPath: "/p", sessionFile: "/p/grew.jsonl" });
		await expect(session.ensureLive()).rejects.toThrow("omp could not start");
		await session.ensureLive();
		expect(asked()).toEqual(["/p/grew.jsonl"]);
		expect(starts()).toHaveLength(2);
	});
});

describe("deferred saved-chat file reader", () => {
	afterEach(() => vi.doUnmock("./sessionFiles"));

	it("clears a rejected import sentinel so another ownership check can follow successfully", async () => {
		respond = channel => channel === "sessions:ownership" ? Promise.resolve("elsewhere") : undefined;
		vi.doMock("./sessionFiles", () => { throw new Error("Reader chunk unavailable"); });
		const session = new SessionController({ tabId: "follow-import-retry", projectPath: "/p", sessionFile: "/p/import-retry.jsonl" });
		await session.checkOwnership();
		expect(session.getSnapshot()).toMatchObject({ readOnly: true, follow: { readable: false, ownership: "elsewhere", error: expect.any(String) } });
		const off = vi.fn();
		const watchSessionFile: typeof SessionFiles.watchSessionFile = (file, listener) => {
			listener(null, { file, readable: true, error: null, ownership: "elsewhere" });
			return off;
		};
		const watch = vi.fn(watchSessionFile);
		vi.doMock("./sessionFiles", () => ({ watchSessionFile: watch }));
		await session.checkOwnership();
		expect(watch).toHaveBeenCalledOnce();
		expect(session.getSnapshot()).toMatchObject({ readOnly: true, follow: { readable: true, ownership: "elsewhere", error: null } });
		expect(invoked.some(call => call[0] === "host:start")).toBe(false);
		await session.dispose();
		expect(off).toHaveBeenCalledOnce();
	});

	it("retries a failed reader without rechecking or relaxing unknown ownership", async () => {
		respond = channel => channel === "sessions:ownership" ? Promise.resolve("unknown") : undefined;
		vi.doMock("./sessionFiles", () => { throw new Error("Reader offline"); });
		const session = new SessionController({ tabId: "follow-explicit-retry", projectPath: "/p", sessionFile: "/p/explicit-retry.jsonl" });
		await session.checkOwnership();
		const watchSessionFile: typeof SessionFiles.watchSessionFile = (file, listener) => {
			listener(null, { file, readable: true, error: null, ownership: "unknown" });
			return () => {};
		};
		vi.doMock("./sessionFiles", () => ({ watchSessionFile }));
		await session.retryFollowing();
		expect(session.getSnapshot()).toMatchObject({ readOnly: true, follow: { readable: true, ownership: "unknown", error: null } });
		expect(invoked.filter(call => call[0] === "sessions:ownership")).toHaveLength(1);
		expect(invoked.some(call => call[0] === "host:start")).toBe(false);
		await session.dispose();
	});

	it("does not attach a reader when the chat is disposed during import", async () => {
		respond = channel => channel === "sessions:ownership" ? Promise.resolve("elsewhere") : undefined;
		const started = Promise.withResolvers<void>();
		const loading = Promise.withResolvers<Pick<typeof SessionFiles, "watchSessionFile">>();
		vi.doMock("./sessionFiles", () => { started.resolve(); return loading.promise; });
		const session = new SessionController({ tabId: "follow-disposed-import", projectPath: "/p", sessionFile: "/p/disposed-import.jsonl" });
		const checking = session.checkOwnership();
		await started.promise;
		await session.dispose();
		const watch = vi.fn(() => () => {});
		loading.resolve({ watchSessionFile: watch });
		await checking;
		expect(watch).not.toHaveBeenCalled();
		expect(invoked.some(call => call[0] === "host:start" || call[0] === "sessions:follow")).toBe(false);
	});
});
