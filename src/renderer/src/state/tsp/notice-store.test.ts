import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { HostState } from "@shared/ipc";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { afterEach, expect, it, vi } from "vitest";
import type { GuestSnapshot } from "../../collab/lib/client";
import type { SessionView } from "../../state/session";
import { TspNoticeStore } from "./notice-store";
import { TspNoticeProjection } from "./notices";

const stores: TspNoticeStore[] = [];
function setup(pending = false) {
	let view = { host: null, guest: null } as SessionView;
	const listeners = new Set<() => void>();
	const updates = new Set<(patch: TspHostPatch) => void>();
	const initial = Promise.withResolvers<TspHostSnapshot | null>();
	if (!pending) initial.resolve(null);
	const invoke = vi.fn(() => initial.promise);
	vi.stubGlobal("window", { vomp: { invoke, on: (_channel: string, listener: (patch: TspHostPatch) => void) => { updates.add(listener); return () => updates.delete(listener); } } });
	const session = { getSnapshot: () => view, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
	const store = new TspNoticeStore(session);
	stores.push(store);
	return { store, updates, initial, invoke, set: (patch: Partial<SessionView>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(); }, send: async (snapshot: TspHostSnapshot) => { for (const listener of updates) listener(tspHostPatch(null, snapshot)); await Promise.resolve(); await Promise.resolve(); } };
}
const host = (hostId = "host", generation = 1, sessionId = "session") => ({ hostId, generation, sessionId, transport: "tsp" }) as HostState;
const guest = (id: string) => ({ phase: "live", loading: null, entries: [{ id, parentId: null, type: "message", message: { role: "user", content: "hello" } } as SessionEntry], notices: [] }) as unknown as GuestSnapshot;
function snapshot(content: string, revision: number, epoch = 1, generation = 1, hostId = "host"): TspHostSnapshot {
	return { hostId, generation, revision, epoch, negotiated: true, lifecycle: "live", documentGeneration: generation, availability: { available: true, reason: null }, failure: null,
		surfaces: [{ open: { id: "surface", mode: "inline" }, sequence: revision, closed: false, focus: null, suspended: false, settled: [], documentGeneration: generation,
			document: { id: "surface", k: "col", c: [{ id: "main", k: "col", c: [{ id: "warning", k: "text", p: { role: "omp.notice.warning", spans: [{ t: content }] } }] }] } }],
	};
}
afterEach(async () => { for (const store of stores.splice(0)) store.dispose(); await Promise.resolve(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("subscribes independently of mounted UI, rejects late reads, and detaches on dispose", async () => {
	const test = setup(true);
	test.set({ host: host(), guest: guest("u1") });
	expect(test.invoke).toHaveBeenCalledWith("host:tsp-snapshot", "host");
	await test.send(snapshot("Latest warning.", 2));
	expect(test.store.getSnapshot()).toEqual([]);
	test.initial.resolve(snapshot("Stale warning.", 1)); await test.initial.promise; await Promise.resolve(); await Promise.resolve();
	expect(test.store.getSnapshot()[0]?.content).toBe("Latest warning.");
	await test.send(snapshot("Restart warning.", 3, 2));
	expect(test.store.getSnapshot()).toMatchObject([{ id: "tsp:2:surface:warning", content: "Restart warning." }]);
	test.store.dispose(); await Promise.resolve(); expect(test.updates.size).toBe(0); expect(test.store.getSnapshot()).toEqual([]);
});
it("leaves classic hosts unsubscribed and isolates host replacements", async () => {
	const test = setup();
	test.set({ host: { ...host(), transport: "classic" } }); expect(test.invoke).not.toHaveBeenCalled();
	test.set({ host: host(), guest: guest("old") }); await test.send(snapshot("Old warning.", 1));
	test.set({ host: host("second"), guest: guest("new") });
	expect(test.store.getSnapshot()).toEqual([]);
	await test.send(snapshot("Unrelated host.", 2)); expect(test.store.getSnapshot()).toEqual([]);
	test.set({ guest: guest("new") }); await test.send(snapshot("New host warning.", 1, 1, 1, "second"));
	expect(test.store.getSnapshot()).toMatchObject([{ anchor: "new", content: "New host warning." }]); test.store.dispose();
});
it("clears room and session projections without repeating retained text or using stale guest anchors", async () => {
	const test = setup(); test.set({ host: host(), guest: guest("old") }); await test.send(snapshot("Old warning.", 1));
	test.set({ host: host("host", 2) }); expect(test.store.getSnapshot()).toEqual([]);
	await test.send(snapshot("Old warning.", 2, 1, 2)); expect(test.store.getSnapshot()).toEqual([]);
	test.set({ guest: guest("new") }); await test.send(snapshot("New warning.", 3, 1, 2));
	expect(test.store.getSnapshot()).toMatchObject([{ anchor: "new", content: "New warning." }]);
	test.set({ host: host("host", 2, "other-session") }); expect(test.store.getSnapshot()).toEqual([]);
	await test.send(snapshot("New warning.", 4, 1, 2)); expect(test.store.getSnapshot()).toEqual([]); test.store.dispose();
});
it("defers TSP-first notices until collab sync and suppresses a matching snapshot custom message", async () => {
	const test = setup();
	test.set({ host: host(), guest: { ...guest("u1"), phase: "waiting", loading: { received: 0, total: 2 } } });
	await test.send(snapshot("Already in collab.", 1));
	expect(test.store.getSnapshot()).toEqual([]);
	const duplicate = { id: "custom", parentId: "u1", type: "custom_message", customType: "example", display: true, content: "Already in collab." } as SessionEntry;
	test.set({ guest: { ...guest("u1"), entries: [...guest("u1").entries, duplicate] } });
	expect(test.store.getSnapshot()).toEqual([]);
	await test.send(snapshot("Another warning.", 2));
	expect(test.store.getSnapshot()).toMatchObject([{ anchor: "custom", turn: "u1", content: "Another warning." }]);
	test.store.dispose();
});
it("distinguishes an authoritative empty snapshot from a download and attributes deferred notices", async () => {
	const test = setup(); test.set({ host: host() }); await test.send(snapshot("Startup warning.", 1));
	expect(test.store.getSnapshot()).toEqual([]);
	test.set({ guest: { ...guest("unused"), entries: [] } });
	expect(test.store.getSnapshot()).toMatchObject([{ anchor: null, turn: "startup", content: "Startup warning." }]);
	test.store.dispose();
});
it("discards pending notices when a room changes during snapshot download", async () => {
	const test = setup(); test.set({ host: host(), guest: { ...guest("old"), phase: "waiting" } });
	await test.send(snapshot("Old room warning.", 1));
	test.set({ host: host("host", 2), guest: { ...guest("new"), phase: "waiting", loading: { received: 1, total: 2 } } });
	await test.send(snapshot("New room warning.", 2, 1, 2));
	expect(test.store.getSnapshot()).toEqual([]);
	test.set({ guest: guest("new") });
	expect(test.store.getSnapshot()).toMatchObject([{ anchor: "new", turn: "new", content: "New room warning." }]);
	expect(test.store.getSnapshot()).toHaveLength(1); test.store.dispose();
});
it("uses the displayed rewind leaf before any new entry and preserves assigned anchors while streaming", async () => {
	const test = setup();
	const first = guest("first").entries[0]!;
	const answer = { id: "answer", parentId: "first", type: "message", message: { role: "assistant", content: [] } } as unknown as SessionEntry;
	const abandoned = { ...guest("abandoned").entries[0]!, parentId: "answer" };
	test.set({ host: host(), guest: { ...guest("unused"), entries: [first, answer, abandoned] }, displayLeaf: "answer" });
	await test.send(snapshot("Rewound warning.", 1));
	expect(test.store.getSnapshot()).toMatchObject([{ anchor: "answer", turn: "first" }]);
	test.set({ guest: { ...guest("unused"), entries: [first, answer, abandoned], stream: { role: "assistant", content: [] } as unknown as GuestSnapshot["stream"] } });
	await test.send(snapshot("Updated warning.", 2));
	expect(test.store.getSnapshot()).toMatchObject([{ anchor: "answer", turn: "first", content: "Updated warning." }]);
	test.store.dispose();
});

it("reprojects collab only for transcript, notice, leaf and room changes, not streaming notifications", () => {
	const collab = vi.spyOn(TspNoticeProjection.prototype, "collab");
	const test = setup();
	const initial = guest("user");
	test.set({ host: host(), guest: initial, history: null, carryover: null, displayLeaf: null });
	expect(collab).toHaveBeenCalledTimes(1);
	for (let revision = 0; revision < 100; revision++) test.set({ guest: { ...initial, lastStreamingAt: revision } });
	expect(collab).toHaveBeenCalledTimes(1);
	test.set({ displayLeaf: "user" });
	expect(collab).toHaveBeenCalledTimes(2);
	const notices: GuestSnapshot["notices"] = [{ id: 1, level: "info", message: "New notice", at: 1 }];
	test.set({ guest: { ...initial, notices } });
	expect(collab).toHaveBeenCalledTimes(3);
	test.set({ host: host("host", 2) });
	test.set({ guest: { ...initial, notices } });
	expect(collab).toHaveBeenCalledTimes(4);
	test.store.dispose();
});
