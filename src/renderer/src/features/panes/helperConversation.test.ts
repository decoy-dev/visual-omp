// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController, SessionView, SessionEvent } from "../../state/session";
import type { Helper } from "./derive";
import { HelperConversation } from "./helperConversation";
import { i18n } from "../../i18n";

beforeEach(async () => { await i18n.loadNamespaces(["helperFocus"]); });

const models: HelperConversation[] = [];
afterEach(() => { for (const model of models.splice(0)) model.dispose(); vi.useRealTimers(); });
const helper = { id: "Atlas", name: "Atlas", status: "running", messageable: true, hasTranscript: true } as Helper;
function fixture(status: "running" | "idle" | "parked" | "aborted" = "running", hasTranscript = true) {
	const listeners = new Set<() => void>();
	const events = new Set<(event: SessionEvent) => void>();
	const fileEvents = new Map<string, Set<(event: never) => void>>();
	let view = {
		mode: "live", readOnly: false, host: { hostId: "host", generation: 1, phase: "live" },
		guest: { phase: "live", readOnly: false, header: { id: "parent" }, agents: [{ id: "Atlas", kind: "sub", status, hasSessionFile: hasTranscript }], lifecycle: new Map(), progress: new Map(), notices: [] },
	} as unknown as SessionView;
	const send = vi.fn(async (_id: string, _text: string, beforeSend: () => void, dispatched?: () => void) => { beforeSend(); dispatched?.(); });
	const client = { sendHelperPrompt: send };
	let file = hasTranscript ? "/parent/Atlas.jsonl" : null;
	const invoke = vi.fn(async (channel: string) => channel === "sessions:helperFile" ? file : undefined);
	window.vomp = { invoke, on: (channel: string, listener: (event: never) => void) => {
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
	return { model, send, session, events, listeners, fileEvents, publish, agent, invoke, makeFileAvailable: () => { file = "/parent/Atlas.jsonl"; }, view: () => view };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("helper conversation discovery", () => {
	it("waits before a transcript exists, delivers a message, then reads the conversation automatically", async () => {
		vi.useFakeTimers();
		const f = fixture("running", false);
		const off = f.model.subscribe(() => {});
		await flush();
		expect(f.model.getSnapshot()).toMatchObject({ file: null, history: null, error: null, waitingForFile: true, helper: { messageable: true } });
		f.model.setDraft("Please check the tests"); f.model.enqueue();
		expect(f.model.getSnapshot().queue[0]?.state).toBe("queued");
		f.agent("idle"); await flush();
		expect(f.send.mock.calls[0]?.slice(0, 2)).toEqual(["Atlas", "Please check the tests"]);
		f.makeFileAvailable();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(f.model.getSnapshot()).toMatchObject({ file: "/parent/Atlas.jsonl", error: null, waitingForFile: false });
		const text = [
			{ type: "session", id: "child", cwd: "/project" },
			{ type: "message", id: "reply", parentId: null, timestamp: "2026-11-06T12:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "The tests passed." }], timestamp: 1 } },
		].map(entry => JSON.stringify(entry)).join("\n") + "\n";
		for (const listener of f.fileEvents.get("sessions:tail") ?? []) listener({ file: "/parent/Atlas.jsonl", text, reset: true } as never);
		expect(f.model.getSnapshot().history?.entries[0]).toMatchObject({ id: "reply" });
		off();
	});
	it("stops waiting discovery when the view closes and preserves genuine discovery failures for explicit retry", async () => {
		vi.useFakeTimers();
		const f = fixture("idle", false);
		const off = f.model.subscribe(() => {});
		await flush();
		off();
		const calls = f.invoke.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2_000);
		expect(f.invoke).toHaveBeenCalledTimes(calls);
		f.invoke.mockRejectedValueOnce(new Error("Permission denied"));
		const stop = f.model.subscribe(() => {});
		await flush();
		expect(f.model.getSnapshot()).toMatchObject({ waitingForFile: false, error: "Error: Permission denied" });
		const failedCalls = f.invoke.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2_000);
		expect(f.invoke).toHaveBeenCalledTimes(failedCalls);
		f.makeFileAvailable(); f.model.reload(); await flush();
		expect(f.model.getSnapshot()).toMatchObject({ file: "/parent/Atlas.jsonl", error: null, waitingForFile: false });
		for (const listener of f.fileEvents.get("sessions:followState") ?? []) listener({ file: "/parent/Atlas.jsonl", readable: false, ownership: "unknown", error: "File cannot be read" } as never);
		expect(f.model.getSnapshot().error).toBe("File cannot be read");
		stop();
	});
});

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
	it("fails an already queued message visibly when the guest ends, retaining it for an explicit retry", async () => {
		const f = fixture();
		f.model.setDraft("great, can I preview this?"); f.model.enqueue();
		const id = f.model.getSnapshot().queue[0]!.id;
		f.publish({ guest: { ...f.view().guest!, phase: "ended" } });
		expect(f.model.getSnapshot()).toMatchObject({ helper: { status: "stopped", messageable: false }, queue: [{ text: "great, can I preview this?", state: "error", error: expect.stringContaining("Copy this message before restarting omp") }] });
		f.model.retry(id);
		expect(f.model.getSnapshot().queue[0]?.state).toBe("error");
		expect(f.send).not.toHaveBeenCalled();
		f.publish({ guest: { ...f.view().guest!, phase: "live", agents: [{ ...f.view().guest!.agents[0]!, status: "idle" }] } });
		expect(f.send).not.toHaveBeenCalled();
		f.model.retry(id); await flush();
		expect(f.send.mock.calls[0]?.slice(0, 2)).toEqual(["Atlas", "great, can I preview this?"]);
	});

	it("keeps a queued message and running helper intact during an ordinary reconnect", async () => {
		const f = fixture();
		f.model.setDraft("Keep waiting"); f.model.enqueue();
		f.publish({ guest: { ...f.view().guest!, phase: "reconnecting" } });
		expect(f.model.getSnapshot()).toMatchObject({ helper: { status: "running", messageable: true }, queue: [{ state: "queued" }] });
		expect(f.send).not.toHaveBeenCalled();
		f.agent("idle"); await flush();
		expect(f.send).not.toHaveBeenCalled();
		f.publish({ guest: { ...f.view().guest!, phase: "live" } }); await flush();
		expect(f.send).toHaveBeenCalledOnce();
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
	it("retains a failed message for copying across restart without resending into the new helper scope", async () => {
		const f = fixture();
		f.model.setDraft("Keep this message for the current helper"); f.model.enqueue();
		const id = f.model.getSnapshot().queue[0]!.id;
		f.publish({ guest: { ...f.view().guest!, phase: "ended" } });
		expect(f.model.getSnapshot().queue[0]?.error).toContain("Copy this message");
		f.publish({ host: { ...f.view().host!, hostId: "restarted-host", generation: 2 }, guest: { ...f.view().guest!, phase: "live", agents: [{ ...f.view().guest!.agents[0]!, status: "idle" }] } });
		f.model.retry(id); f.agent("idle"); await flush();
		expect(f.model.getSnapshot()).toMatchObject({ stale: true, queue: [{ id, text: "Keep this message for the current helper", state: "error" }] });
		expect(f.send).not.toHaveBeenCalled();
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
