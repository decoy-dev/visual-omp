import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { HostState } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliver } from "../chat/composer/send";
import type { GuestSnapshot } from "../collab/lib/client";
import { useComposerDrafts } from "../chat/composer/drafts";
import { sendSlashCommand } from "../features/session-tools/typed";
import { chatStatus } from "../shell/hooks";
import { toast } from "../ui/toast";
import type * as ToastModule from "../ui/toast";
import { liveEntries, liveGuest, SessionController, setSlashDelivery } from "./session";

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
		sendPrompt = vi.fn(async (_text: string, _images: unknown[], beforeSend?: () => void) => { beforeSend?.(); });
		settleAsyncWait(revision: number): void {
			if (!this.snapshot.awaitingAsyncWork || revision !== (this.snapshot.asyncWaitRevision ?? 0)) return;
			this.snapshot = { ...this.snapshot, awaitingAsyncWork: false };
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
/** Every application `invoke` call after session-file and TSP document reads: channel, then arguments. */
let invoked: unknown[][] = [];
/** Answers for chosen `invoke` calls (a delayed paste, a failed submit); everything else resolves null. */
let respond: ((channel: string) => Promise<unknown> | undefined) | null = null;

beforeEach(() => {
	vi.mocked(toast).mockClear();
	fakes.guests.length = 0;
	fakes.watch.end = Promise.withResolvers<void>();
	hostListeners.clear();
	savedText = "";
	invoked = [];
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
				if (channel !== "sessions:find" && channel !== "host:tsp-snapshot") invoked.push([channel, ...args]);
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

const u1 = message("u1", null, "user");
const a1 = message("a1", "u1", "assistant");
const u2 = message("u2", "a1", "user");

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
const submit = (text: string) => ["host:submit", "h1", text, "steer"];

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

describe("SessionController TSP preview input", () => {
	const preview = (busy: boolean) => {
		const session = busy ? working("preview-working") : idle("preview-idle");
		sendHost({ transport: "tsp", link: "L1", tui: tui(0), tspAvailability: { available: true, reason: null } });
		return session;
	};

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
		expect(invoked).toEqual([["host:submit", "h1", "look", "steer", "/tmp/Screen\\ Shot.png"]]);
		expect(session.getSnapshot().queue).toEqual([]);
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
		failOnce("host:submit", "TSP preview: Image submission needs recovery. omp did not attach the image.");
		await session.send("look", [shot]);
		expect(session.getSnapshot().strandedImages).toBe(true);
		expect(queued(session)).toEqual(["look"]);
		expect(invoked.filter(call => call[0] === "host:submit")).toHaveLength(1);
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
		const reason = `Error invoking remote method 'host:submit': Error: TSP preview: The focused editor is not ready. Relaunch without VOMP_TSP.`;
		failOnce("host:submit", reason);
		await expect(deliver(session, "keep this draft", [], false)).rejects.toThrow("Relaunch without VOMP_TSP");
		expect(session.getSnapshot().queue).toEqual([]);
		expect(session.getSnapshot().inputHistory).toEqual([]);
		expect(session.getSnapshot().error).toBeNull();
		expect(chatStatus(session.getSnapshot())).toBe("live");
	});

	it("keeps an automatically delivered preview message queued and shows an actionable notice without red status", async () => {
		const session = preview(true);
		await session.send("keep this queued");
		failOnce("host:submit", "TSP preview: The editor is not ready. Relaunch without VOMP_TSP.");
		fakes.guests.at(-1)?.emit("live", [u1, a1], false);
		await flush();
		expect(queued(session)).toEqual(["keep this queued"]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({ tone: "warn", message: "TSP preview: The editor is not ready. Relaunch without VOMP_TSP." });
		expect(session.getSnapshot().error).toBeNull();
		expect(chatStatus(session.getSnapshot())).toBe("live");
	});

	it("keeps actual launch failures authoritative even when they quote preview text", async () => {
		const reason = "omp startup failed while processing 'TSP preview:'";
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

	it("does not suppress authoritative omp error status that quotes preview text", () => {
		const session = preview(false);
		const programStatus = { state: "error" as const, msg: "omp task failed while processing 'TSP preview:'" };
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
