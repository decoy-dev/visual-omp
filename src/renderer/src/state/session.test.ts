import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { HostState } from "@shared/ipc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSnapshot } from "../collab/lib/client";
import { liveEntries, liveGuest, SessionController } from "./session";

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
		emit(phase: GuestSnapshot["phase"], entries: readonly SessionEntry[]): void {
			this.snapshot = { phase, entries, working: false, uiRequest: null } as unknown as GuestSnapshot;
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
