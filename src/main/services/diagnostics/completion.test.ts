import { describe, expect, it } from "vitest";
import { completionDiagnosticSchema, type CompactCompletionDiagnostic } from "@shared/completion-diagnostics";
import { CompletionDiagnosticIngestor } from "./completion";

function diagnostic(index = 0, epoch = 123.5): CompactCompletionDiagnostic {
	return ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", epoch, index, 1, 2, 84, 999.5, 0, 12];
}

describe("completion diagnostic ingestion", () => {
	it("expands only validated fields, creates a UUID and computes elapsed streaming time", () => {
		const ingestor = new CompletionDiagnosticIngestor();
		const result = ingestor.accept({}, Object.assign(diagnostic(), { text: "private", token: "secret" }), 0, 1100);
		expect(result).toEqual({
			chatId: diagnostic()[0], edgeId: expect.any(String), cause: "state", phase: "live",
			isTerminal: null, willContinue: false, awaitingAsyncWork: false, isStreaming: false,
			sinceStreamingMs: 100, runningHelpers: 0, finished: "suppressed", notificationRequested: false, suppressedReason: "queued",
		});
		expect(completionDiagnosticSchema.safeParse(result).success).toBe(true);
	});
	it("decodes every flag, cause, phase and decision value", () => {
		const ingestor = new CompletionDiagnosticIngestor();
		const renderer = {};
		const causes = ["agent_end", "state", "welcome", "async-wait-settle", "host-exit"];
		const phases = ["connecting", "waiting", "live", "reconnecting", "ended"];
		const reasons = [null, "continuing", "resumed", "queued", "host-exit"];
		for (let index = 0; index < 20; index++) {
			const payload = diagnostic(index);
			payload[3] = index % 5;
			payload[4] = index % 5;
			payload[5] = [0, 85, 170][index % 3]!;
			payload[8] = index;
			const result = ingestor.accept(renderer, payload, 0, 1100)!;
			const flag = [null, false, true][index % 3];
			expect(result).toMatchObject({
				cause: causes[index % 5], phase: phases[index % 5], isTerminal: flag, willContinue: flag,
				awaitingAsyncWork: flag, isStreaming: flag, finished: index & 1 ? "emitted" : "suppressed",
				notificationRequested: Boolean(index & 2), suppressedReason: reasons[index >> 2],
			});
		}
	});
	it("preserves unknown streaming time and clamps future streaming timestamps to zero", () => {
		const ingestor = new CompletionDiagnosticIngestor();
		const unknown = diagnostic();
		unknown[6] = null;
		expect(ingestor.accept({}, unknown, 0, 100)?.sinceStreamingMs).toBeNull();
		expect(ingestor.accept({}, diagnostic(), 0, 100)?.sinceStreamingMs).toBe(0);
	});
	it("rejects malformed data without consuming quota or remembering its edge", () => {
		const ingestor = new CompletionDiagnosticIngestor();
		const renderer = {};
		for (let index = 0; index < 100; index++) {
			const payload = diagnostic(index);
			payload[7] = -1;
			expect(ingestor.accept(renderer, payload, 0, 1100)).toBeNull();
		}
		for (const payload of [null, undefined, "secret", {}, [], [...diagnostic(), "private"]]) {
			expect(ingestor.accept(renderer, payload, 0, 1100)).toBeNull();
		}
		for (let index = 0; index < 30; index++) expect(ingestor.accept(renderer, diagnostic(index), 0, 1100)).not.toBeNull();
	});
	it("deduplicates epoch plus edge across minutes and changed chat or decision fields", () => {
		const ingestor = new CompletionDiagnosticIngestor();
		const renderer = {};
		expect(ingestor.accept(renderer, diagnostic(), 0, 1100)).not.toBeNull();
		const changed = diagnostic();
		changed[0] = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		changed[8] = 3;
		expect(ingestor.accept(renderer, changed, 120_000, 1100)).toBeNull();
		for (let index = 1; index <= 30; index++) expect(ingestor.accept(renderer, diagnostic(index), 120_000, 1100)).not.toBeNull();
	});
	it("separates new renderer epochs and senders without resetting the global quota", () => {
		const ingestor = new CompletionDiagnosticIngestor();
		const renderer = {};
		const first = ingestor.accept(renderer, diagnostic(), 0, 1100)!;
		const reloaded = ingestor.accept(renderer, diagnostic(0, 124.5), 0, 1100)!;
		expect(reloaded).not.toBeNull();
		expect(reloaded.edgeId).not.toBe(first.edgeId);
		expect(ingestor.accept({}, diagnostic(), 0, 1100)).not.toBeNull();
	});
	it("accepts only 30 globally per rolling minute across renderers", () => {
		const ingestor = new CompletionDiagnosticIngestor();
		const first = {};
		const second = {};
		for (let index = 0; index < 15; index++) expect(ingestor.accept(first, diagnostic(index), 0, 1100)).not.toBeNull();
		for (let index = 15; index < 30; index++) expect(ingestor.accept(second, diagnostic(index), 30_000, 1100)).not.toBeNull();
		expect(ingestor.accept(first, diagnostic(30), 59_999, 1100)).toBeNull();
		for (let index = 30; index < 45; index++) expect(ingestor.accept(first, diagnostic(index), 60_000, 1100)).not.toBeNull();
		expect(ingestor.accept(second, diagnostic(45), 60_001, 1100)).toBeNull();
		expect(ingestor.accept(second, diagnostic(45), 89_999, 1100)).toBeNull();
		expect(ingestor.accept(second, diagnostic(45), 90_000, 1100)).not.toBeNull();
	});
	it("bounds per-renderer retention to the most recent 4096 accepted edges", () => {
		const ingestor = new CompletionDiagnosticIngestor();
		const renderer = {};
		for (let index = 0; index <= 4096; index++) expect(ingestor.accept(renderer, diagnostic(index), index * 60_000, 1100)).not.toBeNull();
		expect(ingestor.accept(renderer, diagnostic(1), 4097 * 60_000, 1100)).toBeNull();
		expect(ingestor.accept(renderer, diagnostic(4096), 4097 * 60_000, 1100)).toBeNull();
		expect(ingestor.accept(renderer, diagnostic(0), 4097 * 60_000, 1100)).not.toBeNull();
	});
});
