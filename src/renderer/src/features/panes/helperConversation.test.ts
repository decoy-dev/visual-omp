// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionController, SessionView, SessionEvent } from "../../state/session";
import type { Helper } from "./derive";
import { HelperConversation } from "./helperConversation";

const models: HelperConversation[] = [];
afterEach(() => { for (const model of models.splice(0)) model.dispose(); vi.useRealTimers(); });
const helper = { id: "Atlas", name: "Atlas", status: "running", messageable: true, hasTranscript: true } as Helper;
function fixture(status: "running" | "idle" | "parked" | "aborted" = "running") {
	const listeners = new Set<() => void>();
	const events = new Set<(event: SessionEvent) => void>();
	const fileEvents = new Map<string, Set<(event: never) => void>>();
	let view = {
		mode: "live", readOnly: false, host: { hostId: "host", generation: 1, phase: "live" },
		guest: { phase: "live", readOnly: false, header: { id: "parent" }, agents: [{ id: "Atlas", kind: "sub", status, hasSessionFile: true }], lifecycle: new Map(), progress: new Map(), notices: [] },
	} as unknown as SessionView;
	const send = vi.fn(async (_id: string, _text: string, beforeSend: () => void, dispatched?: () => void) => { beforeSend(); dispatched?.(); });
	const client = { sendHelperPrompt: send };
	window.vomp = { invoke: vi.fn(async (channel: string) => channel === "sessions:helperFile" ? "/parent/Atlas.jsonl" : undefined), on: (channel: string, listener: (event: never) => void) => {
		let set = fileEvents.get(channel); if (!set) { set = new Set(); fileEvents.set(channel, set); }
		set.add(listener); return () => set.delete(listener);
	} } as unknown as typeof window.vomp;
	const session = {
		tabId: "tab", projectPath: "/project", sessionFile: "/parent.jsonl", guestClient: () => client, getSnapshot: () => view,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		onEvent: (listener: (event: SessionEvent) => void) => { events.add(listener); return () => events.delete(listener); },
	} as unknown as SessionController;
	const model = new HelperConversation(session, helper); models.push(model);
	const publish = (patch: Partial<SessionView>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(); };
	const agent = (status: "running" | "idle" | "parked" | "aborted") => publish({ guest: { ...view.guest!, agents: [{ ...view.guest!.agents[0]!, status }] } });
	return { model, send, session, events, listeners, fileEvents, publish, agent, view: () => view };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("helper message queue", () => {
	it("holds messages while working, sends one at idle and waits for its turn to finish before the next", async () => {
		const f = fixture();
		f.model.setDraft("First message"); f.model.enqueue();
		f.model.setDraft("Second message"); f.model.enqueue();
		expect(f.send).not.toHaveBeenCalled();
		expect(f.model.getSnapshot().queue.map(item => item.state)).toEqual(["queued", "queued"]);
		f.agent("idle"); await flush();
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(f.send.mock.calls[0]?.slice(0, 2)).toEqual(["Atlas", "First message"]);
		f.agent("idle"); await flush();
		expect(f.send).toHaveBeenCalledTimes(1);
		f.agent("running"); f.agent("idle"); await flush();
		expect(f.send).toHaveBeenCalledTimes(2);
		expect(f.send.mock.calls[1]?.slice(0, 2)).toEqual(["Atlas", "Second message"]);
	});
	it("can cancel a queued message and retains a separate draft", () => {
		const { model, send } = fixture();
		model.setDraft("Cancel me"); model.enqueue(); model.setDraft("Still typing");
		model.cancel(model.getSnapshot().queue[0]!.id);
		expect(model.getSnapshot().queue).toEqual([]);
		expect(model.getSnapshot().draft).toBe("Still typing");
		expect(send).not.toHaveBeenCalled();
	});
	it("refuses a helper that became busy while the socket was encrypting", async () => {
		const f = fixture("idle");
		f.send.mockImplementationOnce(async (_id, _text, beforeSend) => { f.agent("running"); beforeSend(); });
		f.model.setDraft("Keep waiting"); f.model.enqueue(); await flush();
		expect(f.model.getSnapshot().queue[0]).toMatchObject({ text: "Keep waiting", state: "queued" });
	});
	it("keeps transport and omp errors for explicit retry, without retrying when idle repeats", async () => {
		const f = fixture("parked");
		f.send.mockRejectedValueOnce(new Error("Socket disconnected"));
		f.model.setDraft("Preserve me"); f.model.enqueue(); await flush();
		expect(f.model.getSnapshot().queue[0]).toMatchObject({ text: "Preserve me", state: "error", error: "Socket disconnected" });
		f.agent("idle"); await flush(); expect(f.send).toHaveBeenCalledTimes(1);
		f.model.retry(f.model.getSnapshot().queue[0]!.id); await flush();
		expect(f.send).toHaveBeenCalledTimes(2);
		f.publish({ guest: { ...f.view().guest!, notices: [{ id: 1, at: Date.now(), level: "error", message: "agent Atlas: revive failed" }] } });
		expect(f.model.getSnapshot().queue[0]).toMatchObject({ state: "error", error: "agent Atlas: revive failed" });
	});
	it("never sends a queued message into a later host generation", async () => {
		const f = fixture();
		f.model.setDraft("Old scope"); f.model.enqueue();
		f.publish({ host: { ...f.view().host!, generation: 2 } }); f.agent("idle"); await flush();
		expect(f.send).not.toHaveBeenCalled();
		expect(f.model.getSnapshot().queue[0]?.state).toBe("error");
	});
	it("continues queue delivery without view subscribers and stops all subscriptions on chat disposal", async () => {
		const f = fixture();
		f.model.setDraft("Send after leaving the view"); f.model.enqueue(); f.agent("idle"); await flush();
		expect(f.send).toHaveBeenCalledTimes(1);
		for (const listener of f.events) listener({ kind: "disposed" });
		expect(f.listeners.size).toBe(0);
		expect([...f.fileEvents.values()].every(listeners => listeners.size === 0)).toBe(true);
	});
	it("retains unconfirmed delivery and never sends it twice automatically", async () => {
		vi.useFakeTimers(); const f = fixture("idle");
		f.model.setDraft("Unconfirmed"); f.model.enqueue(); await flush();
		await vi.advanceTimersByTimeAsync(10_001);
		expect(f.model.getSnapshot().queue[0]?.state).toBe("error");
		f.agent("idle"); expect(f.send).toHaveBeenCalledTimes(1);
	});
	it("ignores a running-to-idle cycle while preparing and acknowledges only the dispatched turn", async () => {
		const f = fixture("idle"); const encryption = Promise.withResolvers<void>(); const writes: string[] = [];
		f.send.mockImplementationOnce(async (_id, text, beforeSend, dispatched) => { await encryption.promise; beforeSend(); writes.push(text); dispatched?.(); });
		f.model.setDraft("First"); f.model.enqueue(); f.model.setDraft("Second"); f.model.enqueue();
		f.agent("running"); f.agent("idle");
		expect(f.model.getSnapshot().queue.map(item => item.state)).toEqual(["preparing", "queued"]);
		expect(f.send).toHaveBeenCalledTimes(1);
		encryption.resolve(); await flush();
		expect(writes).toEqual(["First"]);
		f.agent("idle"); expect(f.send).toHaveBeenCalledTimes(1);
		f.agent("running"); f.agent("idle"); await flush();
		expect(f.send).toHaveBeenCalledTimes(2);
	});
	it.each(["cancel", "failure", "dispose", "agents-aborted", "lifecycle-aborted", "ended"] as const)("sends no bytes after %s invalidates a preparation", async action => {
		const f = fixture("idle"); const encryption = Promise.withResolvers<void>(); const writes: string[] = [];
		f.send.mockImplementationOnce(async (_id, text, beforeSend, dispatched) => { await encryption.promise; beforeSend(); writes.push(text); dispatched?.(); });
		f.model.setDraft("Never dispatched"); f.model.enqueue();
		if (action === "cancel") f.model.cancel(f.model.getSnapshot().queue[0]!.id);
		if (action === "dispose") f.model.dispose();
		if (action === "failure") f.publish({ guest: { ...f.view().guest!, notices: [{ id: 1, at: Date.now(), level: "error", message: "agent Atlas: rejected before dispatch" }] } });
		if (action === "agents-aborted") f.agent("aborted");
		if (action === "lifecycle-aborted") f.publish({ guest: { ...f.view().guest!, lifecycle: new Map([["Atlas", { id: "Atlas", agent: "task", status: "aborted", index: 0 }]]) } });
		if (action === "ended") f.publish({ guest: { ...f.view().guest!, phase: "ended" } });
		encryption.resolve(); await flush();
		expect(writes).toEqual([]);
		if (action === "cancel") expect(f.model.getSnapshot().queue).toEqual([]);
		if (action === "failure") expect(f.model.getSnapshot().queue[0]).toMatchObject({ state: "error", error: "agent Atlas: rejected before dispatch" });
	});
	it("never dispatches to a registry-aborted helper despite a later completed lifecycle", async () => {
		const f = fixture("aborted");
		f.publish({ guest: { ...f.view().guest!, lifecycle: new Map([["Atlas", { id: "Atlas", agent: "task", status: "completed", index: 0 }]]) } });
		f.model.setDraft("Do not revive"); f.model.enqueue(); await flush();
		expect(f.send).not.toHaveBeenCalled();
	});
});
