import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptResult } from "../../collab/lib/client";
import { fetchHelperTranscript, type HelperJobsSnapshot, watchHelperJobs } from "./helperJobs";

const transcript = [
	{ type: "session", id: "helper", cwd: "/helper/project" },
	{ type: "message", id: "call", parentId: null, timestamp: "2026-10-29T12:00:00Z", message: { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "make", async: true } }] } },
	{ type: "message", id: "result", parentId: "call", timestamp: "2026-10-29T12:00:01Z", message: { role: "toolResult", toolCallId: "bash", toolName: "bash", timestamp: 2, content: [{ type: "text", text: "Started" }], details: { async: { jobId: "bg_1", state: "running" } } } },
].map(entry => JSON.stringify(entry)).join("\n") + "\n";

afterEach(() => vi.useRealTimers());

describe("helper job readers", () => {
	it("publishes terminal errors once and stops polling that helper", async () => {
		vi.useFakeTimers();
		const client = { fetchTranscript: vi.fn(async (): Promise<TranscriptResult | null> => ({ kind: "error", message: "no transcript available" })) };
		const updates: HelperJobsSnapshot[] = [];
		const stop = watchHelperJobs(client, "Atlas", "/project", true, update => updates.push(update));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(client.fetchTranscript).toHaveBeenCalledTimes(1);
		expect(updates).toEqual([{ jobs: [], error: "no transcript available" }]);
		stop();
	});

	it("retries transient null responses and retains complete rows before a terminal chunk error", async () => {
		vi.useFakeTimers();
		const client = { fetchTranscript: vi.fn<(_: string, offset: number) => Promise<TranscriptResult | null>>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ kind: "rows", text: transcript, newSize: transcript.length })
			.mockResolvedValue({ kind: "error", message: "transcript entry exceeds transcript fetch cap" }) };
		const updates: HelperJobsSnapshot[] = [];
		const stop = watchHelperJobs(client, "Atlas", "/project", true, update => updates.push(update));
		await vi.advanceTimersByTimeAsync(0);
		expect(client.fetchTranscript).toHaveBeenCalledTimes(1);
		expect(updates).toEqual([]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(updates).toMatchObject([{ error: "transcript entry exceeds transcript fetch cap", jobs: [{ jobId: "bg_1", state: "running", cwd: "/helper/project" }] }]);
		expect(client.fetchTranscript.mock.calls.map(([, offset]) => offset)).toEqual([0, 0, transcript.length]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(client.fetchTranscript).toHaveBeenCalledTimes(3);
		stop();
	});

	it("ignores an in-flight response after its reader stops", async () => {
		vi.useFakeTimers();
		const response = Promise.withResolvers<TranscriptResult | null>();
		const client = { fetchTranscript: vi.fn(() => response.promise) };
		const update = vi.fn();
		const stop = watchHelperJobs(client, "Atlas", "/project", true, update);
		await vi.advanceTimersByTimeAsync(0);
		stop();
		response.resolve({ kind: "error", message: "Unavailable" });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(update).not.toHaveBeenCalled();
		expect(client.fetchTranscript).toHaveBeenCalledTimes(1);
	});

	it("keeps one transcript request in flight per connection, so omp never queues several large replies", async () => {
		const pending: { resolve(result: TranscriptResult | null): void }[] = [];
		const client = { fetchTranscript: vi.fn((_: string, _offset: number) => {
			const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
			pending.push({ resolve });
			return promise;
		}) };
		const first = fetchHelperTranscript(client, "Atlas", 0);
		const second = fetchHelperTranscript(client, "Boreas", 0);
		await Promise.resolve(); await Promise.resolve();
		expect(client.fetchTranscript.mock.calls.map(([id]) => id)).toEqual(["Atlas"]);
		pending[0]!.resolve({ kind: "rows", text: "", newSize: 0 });
		await first;
		await Promise.resolve(); await Promise.resolve();
		expect(client.fetchTranscript.mock.calls.map(([id]) => id)).toEqual(["Atlas", "Boreas"]);
		pending[1]!.resolve(null);
		await expect(second).resolves.toBeNull();
	});

	it("sends nothing for a reader cancelled while it waits in the queue", async () => {
		const blocker = Promise.withResolvers<TranscriptResult | null>();
		const client = { fetchTranscript: vi.fn((id: string) => (id === "Atlas" ? blocker.promise : Promise.resolve(null))) };
		let cancelled = false;
		void fetchHelperTranscript(client, "Atlas", 0);
		const waiting = fetchHelperTranscript(client, "Boreas", 0, () => cancelled);
		cancelled = true;
		blocker.resolve(null);
		await expect(waiting).resolves.toBeNull();
		expect(client.fetchTranscript.mock.calls.map(([id]) => id)).toEqual(["Atlas"]);
	});

	it("reads a finished helper to the end once and does not poll it again", async () => {
		vi.useFakeTimers();
		const client = { fetchTranscript: vi.fn(async (_: string, offset: number): Promise<TranscriptResult | null> =>
			offset === 0 ? { kind: "rows", text: transcript, newSize: transcript.length } : { kind: "rows", text: "", newSize: transcript.length }) };
		const updates: HelperJobsSnapshot[] = [];
		const stop = watchHelperJobs(client, "Atlas", "/project", false, update => updates.push(update));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(client.fetchTranscript.mock.calls.map(([, offset]) => offset)).toEqual([0, transcript.length]);
		expect(updates).toMatchObject([{ error: null, jobs: [{ jobId: "bg_1" }] }]);
		stop();
	});
});
