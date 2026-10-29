import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptResult } from "../../collab/lib/client";
import { type HelperJobsSnapshot, watchHelperJobs } from "./helperJobs";

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
		const stop = watchHelperJobs(client, "Atlas", "/project", update => updates.push(update));
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
		const stop = watchHelperJobs(client, "Atlas", "/project", update => updates.push(update));
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
		const stop = watchHelperJobs(client, "Atlas", "/project", update);
		stop();
		response.resolve({ kind: "error", message: "Unavailable" });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(update).not.toHaveBeenCalled();
		expect(client.fetchTranscript).toHaveBeenCalledTimes(1);
	});
});
