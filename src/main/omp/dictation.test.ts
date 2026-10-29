import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { DictationUpdate } from "@shared/contracts/composer";
import { closeDictation, startDictation, stopDictation } from "./dictation";

const fake = vi.hoisted(() => ({ clients: [] as { onMessage: (frame: unknown) => void; onTerminated: (error: Error) => void; request: Mock; close: Mock }[] }));
vi.mock("node:fs/promises", () => ({ mkdtemp: async () => "/tmp/voice-capture", writeFile: async () => {}, rm: async () => {} }));
vi.mock("./rpc", () => ({ PersistentRpc: class {
	request = vi.fn(async () => undefined);
	close = vi.fn();
	constructor(_folder: string, readonly flags: string[], readonly onMessage: (frame: unknown) => void, readonly onTerminated: (error: Error) => void) { fake.clients.push(this); }
} }));
let updates: DictationUpdate[];
beforeEach(() => { fake.clients.length = 0; updates = []; });
afterEach(() => closeDictation());
describe("draft dictation", () => {
	it("stays Starting until omp explicitly reports recording and accepts only this capture's frames", async () => {
		startDictation("/project", "one", update => updates.push(update));
		await vi.waitFor(() => expect(fake.clients).toHaveLength(1));
		expect(updates.map(update => update.state)).toEqual(["starting"]);
		fake.clients[0]!.onMessage({ type: "dictation_state", captureId: "other", state: "recording" });
		expect(updates).toHaveLength(1);
		fake.clients[0]!.onMessage({ type: "dictation_state", captureId: "one", state: "recording" });
		expect(updates.at(-1)?.state).toBe("recording");
		fake.clients[0]!.onMessage({ type: "dictation_transcript", captureId: "one", text: "hello" });
		fake.clients[0]!.onMessage({ type: "dictation_end", captureId: "one", text: "hello world" });
		expect(updates.at(-1)).toEqual({ captureId: "one", state: "ended", text: "hello world" });
		expect(fake.clients[0]!.close).toHaveBeenCalledOnce();
	});
	it("sends stop while start has not reached recording, including a stop requested during process setup", async () => {
		startDictation("/project", "one", update => updates.push(update));
		const stopping = stopDictation("one");
		await stopping;
		expect(fake.clients[0]!.request.mock.calls.map(call => call[0])).toEqual(["dictation_start", "dictation_stop"]);
		fake.clients[0]!.onMessage({ type: "dictation_end", captureId: "one", text: "" });
		expect(updates.at(-1)?.state).toBe("ended");
	});
	it("refuses another microphone and leaves stale stop requests harmless", async () => {
		startDictation("/project", "one", update => updates.push(update));
		expect(() => startDictation("/other", "two", () => {})).toThrow("Another dictation");
		await stopDictation("other");
		await vi.waitFor(() => expect(fake.clients).toHaveLength(1));
		expect(fake.clients[0]!.request.mock.calls.map(call => call[0])).toEqual(["dictation_start"]);
	});
	it("publishes one terminal error and releases the microphone if the child dies after recording starts", async () => {
		startDictation("/project", "one", update => updates.push(update));
		await vi.waitFor(() => expect(fake.clients).toHaveLength(1));
		const child = fake.clients[0]!;
		await child.request.mock.results[0]!.value;
		child.onMessage({ type: "dictation_state", captureId: "one", state: "recording" });
		child.onMessage({ type: "dictation_transcript", captureId: "one", text: "partial words" });
		child.onTerminated(new Error("Speech process stopped."));
		child.onTerminated(new Error("Duplicate stop."));
		expect(updates.filter(update => update.state === "ended")).toEqual([{ captureId: "one", state: "ended", text: "partial words", error: "Speech process stopped." }]);
		expect(child.close).toHaveBeenCalledOnce();
		expect(() => startDictation("/project", "two", update => updates.push(update))).not.toThrow();
	});
});
