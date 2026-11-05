import { describe, expect, it } from "vitest";
import { compactCompletionDiagnosticSchema, completionDiagnosticSchema, type CompactCompletionDiagnostic, type CompletionDiagnostic } from "./completion-diagnostics";

const diagnostic: CompletionDiagnostic = {
	chatId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	edgeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	cause: "agent_end",
	phase: "live",
	isTerminal: true,
	willContinue: false,
	awaitingAsyncWork: false,
	isStreaming: false,
	sinceStreamingMs: 12,
	runningHelpers: 0,
	finished: "emitted",
	notificationRequested: true,
	suppressedReason: null,
};

describe("completion diagnostic schema", () => {
	it("projects onto the exact public contract, discarding private and spoofed fields", () => {
		expect(completionDiagnosticSchema.parse({
			...diagnostic, event: "main-exception", text: "private chat", token: "secret",
			prompt: { messages: ["private"] }, path: "/private/session.jsonl",
		})).toEqual(diagnostic);
	});
	it("accepts null for every nullable observation without making fields optional", () => {
		expect(completionDiagnosticSchema.safeParse({
			...diagnostic, phase: null, isTerminal: null, willContinue: null, awaitingAsyncWork: null,
			isStreaming: null, sinceStreamingMs: null, suppressedReason: null,
		}).success).toBe(true);
		for (const field of Object.keys(diagnostic)) {
			const incomplete: Record<string, unknown> = { ...diagnostic };
			delete incomplete[field];
			expect(completionDiagnosticSchema.safeParse(incomplete).success).toBe(false);
		}
	});
	it.each(["agent_end", "state", "welcome", "async-wait-settle", "host-exit"])("accepts cause %s", cause => {
		expect(completionDiagnosticSchema.safeParse({ ...diagnostic, cause }).success).toBe(true);
	});
	it.each(["connecting", "waiting", "live", "reconnecting", "ended"])("accepts phase %s", phase => {
		expect(completionDiagnosticSchema.safeParse({ ...diagnostic, phase }).success).toBe(true);
	});
	it.each(["continuing", "resumed", "queued", "host-exit"])("accepts suppression reason %s", suppressedReason => {
		expect(completionDiagnosticSchema.safeParse({ ...diagnostic, finished: "suppressed", suppressedReason }).success).toBe(true);
	});
	it.each([
		{ chatId: "private filename" }, { edgeId: "private text" }, { cause: "private text" },
		{ phase: "private text" }, { isTerminal: "true" }, { willContinue: 1 },
		{ awaitingAsyncWork: {} }, { isStreaming: [] }, { sinceStreamingMs: -1 },
		{ sinceStreamingMs: 0.5 }, { sinceStreamingMs: Infinity }, { sinceStreamingMs: NaN },
		{ runningHelpers: -1 }, { runningHelpers: 0.5 }, { runningHelpers: Infinity },
		{ runningHelpers: NaN }, { runningHelpers: null }, { finished: "private text" },
		{ notificationRequested: null }, { suppressedReason: "private text" },
	])("rejects malformed contract fields: %j", patch => {
		expect(completionDiagnosticSchema.safeParse({ ...diagnostic, ...patch }).success).toBe(false);
	});
	it.each([null, undefined, [], "private text", 42])("rejects non-object payload %j", payload => {
		expect(completionDiagnosticSchema.safeParse(payload).success).toBe(false);
	});
});

describe("compact completion diagnostic schema", () => {
	const tuple: CompactCompletionDiagnostic = [diagnostic.chatId, 123.5, 0, 0, 2, 86, 1234.5, 0, 3];
	it("accepts only the exact compact tuple and projects away private array properties", () => {
		expect(compactCompletionDiagnosticSchema.parse(Object.assign([...tuple], { text: "private", token: "secret" }))).toEqual(tuple);
		expect(compactCompletionDiagnosticSchema.safeParse([...tuple, "private"]).success).toBe(false);
		expect(compactCompletionDiagnosticSchema.safeParse(tuple.slice(0, -1)).success).toBe(false);
		expect(compactCompletionDiagnosticSchema.safeParse(diagnostic).success).toBe(false);
	});
	it.each([
		[0, "private"], [1, -1], [1, Infinity], [1, NaN], [2, -1], [2, 0.5],
		[3, 5], [3, -1], [3, 0.5], [4, 5], [4, null], [5, -1], [5, 256],
		[5, 3], [5, 12], [5, 48], [5, 192], [6, -1], [6, Infinity], [6, "private"],
		[7, -1], [7, 0.5], [8, 20], [8, -1], [8, 0.5],
	])("rejects malformed compact field %s = %s", (index, value) => {
		const payload: unknown[] = [...tuple];
		payload[index as number] = value;
		expect(compactCompletionDiagnosticSchema.safeParse(payload).success).toBe(false);
	});
	it("accepts unknown streaming time and the full result range", () => {
		for (let decision = 0; decision <= 19; decision++) {
			expect(compactCompletionDiagnosticSchema.safeParse([...tuple.slice(0, 6), null, 0, decision]).success).toBe(true);
		}
	});
});
