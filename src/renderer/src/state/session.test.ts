import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { HostState } from "@shared/ipc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSnapshot } from "../collab/lib/client";
import { liveEntries, liveGuest, SessionController, setSlashDelivery } from "./session";

// vi.mock is hoisted above the imports, so the controller under test builds these fakes.
const fakes = vi.hoisted(() => {
	const guests: FakeGuest[] = [];
	class FakeGuest {
		snapshot = { phase: "connecting", entries: [] } as unknown as GuestSnapshot;
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
		/** What the real client publishes: `waiting` until omp's snapshot arrives, then `live`. */
		emit(phase: GuestSnapshot["phase"], entries: readonly SessionEntry[], working = false): void {
			this.snapshot = { phase, entries, working, uiRequest: null } as unknown as GuestSnapshot;
			for (const listener of this.listeners) listener();
		}
	}
	return { FakeGuest, guests };
});
vi.mock("../collab/lib/client", () => ({ GuestClient: fakes.FakeGuest }));

const hostListeners = new Set<(state: HostState) => void>();
let savedText = "";

beforeEach(() => {
	fakes.guests.length = 0;
	hostListeners.clear();
	savedText = "";
	vi.stubGlobal("window", {
		vomp: {
			on: (channel: string, listener: (state: HostState) => void) => {
				if (channel !== "host:state") return () => undefined;
				hostListeners.add(listener);
				return () => hostListeners.delete(listener);
			},
			invoke: async (channel: string) => (channel === "sessions:read" ? savedText : null),
		},
	});
});

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
});

describe("SessionController queue around omp's own screens", () => {
	const tui = (overlays: number) => ({ overlays, focused: "vw", altScreen: false, overlayKinds: [] });
	/** Let promise callbacks settle (deliveries, holds, whenLive); no timers involved. */
	const flush = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	const queued = (session: SessionController) => session.getSnapshot().queue.map(item => item.text);
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
	/** A live chat in the middle of a turn. */
	function working(tabId: string) {
		const session = new SessionController({ tabId, projectPath: "/p", sessionFile: null });
		session.attach(host({ link: "L1", tui: tui(0) }));
		fakes.guests[0]?.emit("live", [u1], true);
		return session;
	}

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
