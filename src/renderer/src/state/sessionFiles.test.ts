// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { SessionHistory } from "./history";
import { watchSessionFile } from "./sessionFiles";

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
function bus() {
	const listeners = new Map<string, Set<(event: unknown) => void>>();
	const invoke = vi.fn(async () => undefined);
	window.vomp = { invoke, on: (channel: string, listener: (event: unknown) => void) => {
		let set = listeners.get(channel); if (!set) { set = new Set(); listeners.set(channel, set); }
		set.add(listener); return () => set.delete(listener);
	} } as unknown as typeof window.vomp;
	return { invoke, emit: (channel: string, event: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(event); } };
}

it("shares a followed file and appends new records without duplicating the initial history", () => {
	const file = "/parent/Atlas.jsonl";
	const header = JSON.stringify({ type: "session", id: "helper", cwd: "/project" });
	const prompt = JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-11-05T12:00:00Z", message: { role: "user", content: "Assignment", timestamp: 1 } });
	const events = bus();
	let first: SessionHistory | null = null; let second: SessionHistory | null = null;
	stops.push(watchSessionFile(file, history => { first = history; }));
	events.emit("sessions:tail", { file, text: `${header}\n${prompt}\n`, reset: true });
	stops.push(watchSessionFile(file, history => { second = history; }));
	expect(first).toBe(second);
	expect(events.invoke).toHaveBeenCalledExactlyOnceWith("sessions:follow", [file]);
	const reply = JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-11-05T12:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "New reply" }], timestamp: 2 } });
	events.emit("sessions:tail", { file, text: `${reply}\n`, reset: false });
	expect((first as SessionHistory | null)?.entries.map(entry => entry.id)).toEqual(["u1", "a1"]);
	expect(first).toBe(second);
	stops.shift()!(); expect(events.invoke).toHaveBeenCalledTimes(1);
	stops.shift()!(); expect(events.invoke).toHaveBeenLastCalledWith("sessions:follow", []);
});

it("ignores an unrelated file and appends before the first reset, and reports read failures", () => {
	const events = bus(); const observed = vi.fn();
	stops.push(watchSessionFile("/helper.jsonl", observed));
	events.emit("sessions:tail", { file: "/helper.jsonl", text: "{}\n", reset: false });
	events.emit("sessions:tail", { file: "/other.jsonl", text: "{}\n", reset: true });
	expect(observed).toHaveBeenCalledTimes(1);
	events.emit("sessions:followState", { file: "/helper.jsonl", readable: false, error: "ENOENT", ownership: "unknown" });
	expect(observed).toHaveBeenLastCalledWith(null, expect.objectContaining({ error: "ENOENT" }));
});
