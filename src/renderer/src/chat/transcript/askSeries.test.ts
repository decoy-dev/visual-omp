import type { CollabUiRequest, CollabUiRequestDraft, CollabUiSelectItem, SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import {
	ASK_CHAT,
	ASK_NEXT,
	ASK_OTHER,
	type AskAnswer,
	type AskQuestion,
	defaultAnswer,
	findSeriesAsk,
	isAskRunning,
	isSeriesStart,
	parseAskQuestions,
	REPLAY_START,
	type ReplayCursor,
	type ReplayStep,
	replayStep,
} from "./askSeries";

// ---------------- A copy of omp's guest ask (extension-ui-controller.ts #runGuestAskQuestion, v18.10.2) ----------------

interface OmpResultItem {
	id: string;
	selectedOptions: string[];
	customInput?: string;
}
type OmpResult = { kind: "submit"; results: OmpResultItem[] } | { kind: "chat" } | undefined;

function sanitize(text: string): string {
	return text.includes("\r") ? text.replaceAll("\r\n", "\n").replace(/\r+/g, " ") : text;
}

function disambiguate(raw: string[], reserved: string[]): string[] {
	const taken = new Set(reserved);
	return raw.map(label => {
		const base = sanitize(label);
		let candidate = base;
		for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base} (${suffix})`;
		taken.add(candidate);
		return candidate;
	});
}

/** Yields each guest request and receives the reply (undefined = cancelled), like omp's loop. */
function* ompGuestAsk(questions: AskQuestion[]): Generator<CollabUiRequestDraft, OmpResult, string | undefined> {
	const results: OmpResultItem[] = [];
	for (const question of questions) {
		const selected = new Set<string>();
		let customInput: string | undefined;
		const display = disambiguate(
			question.options.map(option => option.label),
			[ASK_OTHER, ASK_CHAT, ASK_NEXT],
		);
		const original = new Map(question.options.map((option, index) => [display[index], option.label]));
		const resolve = (value: string) => original.get(value) ?? value;
		const title = sanitize(question.question);
		const base: CollabUiSelectItem[] = question.options.map((option, index) =>
			option.description?.trim() ? { label: display[index] ?? "", description: option.description.trim() } : (display[index] ?? ""),
		);
		if (question.multi) {
			while (true) {
				const checkedIndices = question.options.map((option, index) => (selected.has(option.label) ? index : -1)).filter(index => index >= 0);
				const hasAnswer = selected.size > 0 || customInput !== undefined;
				const options = [...base, ASK_OTHER];
				if (hasAnswer) options.push(ASK_NEXT);
				options.push(ASK_CHAT);
				const choice = yield { kind: "select", title, options, selectionMarker: "checkbox", checkedIndices, markableCount: question.options.length, helpText: "keys" };
				if (choice === undefined) return undefined;
				if (choice === ASK_CHAT) return { kind: "chat" };
				if (choice === ASK_NEXT) break;
				if (choice === ASK_OTHER) {
					const input = yield { kind: "editor", title: `Custom answer: ${title}`.replace(/\s+/g, " ").trim() };
					if (input === undefined) continue;
					customInput = input;
					break;
				}
				const picked = resolve(choice);
				if (selected.has(picked)) selected.delete(picked);
				else selected.add(picked);
			}
		} else {
			const initialIndex = Math.max(0, Math.min(question.recommended ?? 0, Math.max(0, question.options.length - 1)));
			while (true) {
				const choice = yield { kind: "select", title, options: [...base, ASK_OTHER, ASK_CHAT], initialIndex, selectionMarker: "radio", markableCount: question.options.length, helpText: "keys" };
				if (choice === undefined) return undefined;
				if (choice === ASK_CHAT) return { kind: "chat" };
				if (choice === ASK_OTHER) {
					const input = yield { kind: "editor", title: `Custom answer: ${title}` };
					if (input === undefined) continue;
					customInput = input;
				} else selected.add(resolve(choice));
				break;
			}
		}
		results.push({ id: question.id, selectedOptions: question.options.map(option => option.label).filter(label => selected.has(label)), customInput });
	}
	return { kind: "submit", results };
}

/** Replays `answers` against the omp copy; returns omp's result, the replies sent, and a mismatch if one stopped the replay. */
function replay(questions: AskQuestion[], answers: AskAnswer[]): { result: OmpResult | "stopped"; sent: string[]; mismatch?: string } {
	const omp = ompGuestAsk(questions);
	const sent: string[] = [];
	let cursor: ReplayCursor = REPLAY_START;
	let next = omp.next();
	let reqId = 1;
	while (!next.done) {
		const request = { ...next.value, reqId: reqId++ } as CollabUiRequest;
		if (reqId > 100) throw new Error("replay did not finish");
		const step = replayStep(questions, answers, cursor, request);
		if (step.kind === "mismatch") return { result: "stopped", sent, mismatch: step.reason };
		sent.push(step.value);
		cursor = step.cursor;
		next = omp.next(step.value);
		if (step.done && !next.done) return { result: "stopped", sent, mismatch: "omp kept asking after done" };
	}
	return { result: next.value, sent };
}

const q = (id: string, labels: string[], extra: Partial<AskQuestion> = {}): AskQuestion => ({
	id,
	question: `Which ${id}?`,
	options: labels.map(label => ({ label })),
	multi: false,
	...extra,
});

describe("replayStep against omp's guest ask", () => {
	it("answers single choices by index, including disambiguated labels", () => {
		// Two options sanitize alike, and one collides with a sentinel: omp suffixes both display labels.
		const questions = [q("db", ["SQLite", "Postgres"]), q("retry", ["Retry\rnow", "Retry now", "Other (type your own)"])];
		const { result, sent } = replay(questions, [
			{ selected: [1], custom: "" },
			{ selected: [1], custom: "" },
		]);
		expect(sent).toEqual(["Postgres", "Retry now (2)"]);
		expect(result).toEqual({
			kind: "submit",
			results: [
				{ id: "db", selectedOptions: ["Postgres"], customInput: undefined },
				{ id: "retry", selectedOptions: ["Retry now"], customInput: undefined },
			],
		});
		const sentinel = replay(questions, [
			{ selected: [0], custom: "" },
			{ selected: [2], custom: "" },
		]);
		expect(sentinel.sent[1]).toBe("Other (type your own) (2)");
		expect(sentinel.result).toMatchObject({ results: [{}, { selectedOptions: ["Other (type your own)"] }] });
	});

	it("toggles each checked option once, then sends Next only after the first check made it appear", () => {
		const questions = [q("lang", ["TS", "Go", "Rust"], { multi: true }), q("db", ["SQLite", "Postgres"])];
		const steps: { value: string; options: number; checked: readonly number[] }[] = [];
		const omp = ompGuestAsk(questions);
		let cursor = REPLAY_START;
		let next = omp.next();
		const answers = [
			{ selected: [0, 2], custom: "" },
			{ selected: [0], custom: "" },
		];
		while (!next.done) {
			const request = { ...next.value, reqId: steps.length + 1 } as CollabUiRequest;
			const step = replayStep(questions, answers, cursor, request);
			if (step.kind !== "answer") throw new Error(step.reason);
			steps.push({ value: step.value, options: request.kind === "select" ? request.options.length : 0, checked: request.kind === "select" ? (request.checkedIndices ?? []) : [] });
			cursor = step.cursor;
			next = omp.next(step.value);
		}
		expect(steps.map(step => step.value)).toEqual(["TS", "Rust", ASK_NEXT, "SQLite"]);
		// 3 options + Other + Chat before anything is checked; Next joins once TS is checked.
		expect(steps.slice(0, 3).map(step => step.options)).toEqual([5, 6, 6]);
		expect(steps[2]?.checked).toEqual([0, 2]);
		expect(next.value).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["TS", "Rust"] }, { selectedOptions: ["SQLite"] }] });
	});

	it("never toggles an option that was checked and then unchecked before sending", () => {
		// The user checked Go, went back later and unchecked it: only the final answer is replayed.
		const questions = [q("lang", ["TS", "Go", "Rust"], { multi: true }), q("db", ["SQLite"])];
		const { result, sent } = replay(questions, [
			{ selected: [2], custom: "" },
			{ selected: [0], custom: "" },
		]);
		expect(sent).toEqual(["Rust", ASK_NEXT, "SQLite"]);
		expect(result).toMatchObject({ results: [{ selectedOptions: ["Rust"] }, {}] });
	});

	it("unchecks an option omp reports as checked that the answer leaves out", () => {
		const question = q("lang", ["TS", "Go"], { multi: true });
		const request: CollabUiRequest = {
			reqId: 1,
			kind: "select",
			title: "Which lang?",
			options: ["TS", "Go", ASK_OTHER, ASK_NEXT, ASK_CHAT],
			selectionMarker: "checkbox",
			checkedIndices: [0, 1],
			markableCount: 2,
		};
		const step = replayStep([question, q("db", ["SQLite"])], [{ selected: [1], custom: "" }, defaultAnswer(q("db", ["SQLite"]))], REPLAY_START, request);
		expect(step).toMatchObject({ kind: "answer", value: "TS", done: false });
	});

	it("sends Other and then the text when omp opens the custom answer editor", () => {
		const questions = [q("db", ["SQLite", "Postgres"]), q("lang", ["TS", "Go"], { multi: true }), q("name", ["app"])];
		const { result, sent } = replay(questions, [
			{ selected: [0], custom: "DuckDB" },
			{ selected: [1], custom: "Zig" },
			{ selected: [], custom: "  web  " },
		]);
		expect(sent).toEqual([ASK_OTHER, "DuckDB", "Go", ASK_OTHER, "Zig", ASK_OTHER, "web"]);
		expect(result).toEqual({
			kind: "submit",
			results: [
				{ id: "db", selectedOptions: [], customInput: "DuckDB" },
				{ id: "lang", selectedOptions: ["Go"], customInput: "Zig" },
				{ id: "name", selectedOptions: [], customInput: "web" },
			],
		});
	});

	it("stops when a request does not match the expected question", () => {
		const questions = [q("db", ["SQLite", "Postgres"]), q("lang", ["TS", "Go"])];
		const answers = [
			{ selected: [0], custom: "" },
			{ selected: [1], custom: "" },
		];
		const select = (patch: Partial<CollabUiRequest & { kind: "select" }>): CollabUiRequest => ({
			reqId: 1,
			kind: "select",
			title: "Which db?",
			options: ["SQLite", "Postgres", ASK_OTHER, ASK_CHAT],
			selectionMarker: "radio",
			markableCount: 2,
			...patch,
		});
		expect(replayStep(questions, answers, REPLAY_START, select({}))).toMatchObject({ kind: "answer", value: "SQLite" });
		expect(replayStep(questions, answers, REPLAY_START, select({ title: "Which lang?" }))).toMatchObject({ kind: "mismatch" });
		expect(replayStep(questions, answers, REPLAY_START, select({ options: ["SQLite", "Postgres", "MySQL", ASK_OTHER, ASK_CHAT], markableCount: 3 }))).toMatchObject({ kind: "mismatch" });
		expect(replayStep(questions, answers, REPLAY_START, select({ selectionMarker: "checkbox" }))).toMatchObject({ kind: "mismatch" });
		expect(replayStep(questions, answers, REPLAY_START, { reqId: 1, kind: "editor", title: "Notes" })).toMatchObject({ kind: "mismatch" });
		// A Next row before anything is checked is not omp's multi-select shape.
		const multi = [q("lang", ["TS", "Go"], { multi: true }), q("db", ["SQLite"])];
		const early: CollabUiRequest = { reqId: 1, kind: "select", title: "Which lang?", options: ["TS", "Go", ASK_OTHER, ASK_NEXT, ASK_CHAT], selectionMarker: "checkbox", checkedIndices: [], markableCount: 2 };
		expect(replayStep(multi, [{ selected: [0], custom: "" }, defaultAnswer(multi[1] as AskQuestion)], REPLAY_START, early)).toMatchObject({ kind: "mismatch" });
		// After the last answer, any further request is unexpected.
		expect(replayStep(questions, answers, { question: 2, awaiting: "select", steps: 0 }, select({}))).toMatchObject({ kind: "mismatch" });
		// The editor is expected after Other; a select instead stops the replay.
		expect(replayStep(questions, [{ selected: [], custom: "x" }, answers[1]], { question: 0, awaiting: "editor", steps: 1 }, select({}))).toMatchObject({
			kind: "mismatch",
		});
	});

	it("stops when the options under the same title are reordered or replaced", () => {
		const questions = [q("db", ["SQLite", "Postgres"]), q("lang", ["TS", "Go"])];
		const answers = [
			{ selected: [1], custom: "" },
			{ selected: [0], custom: "" },
		];
		const select = (options: string[]): CollabUiRequest => ({ reqId: 1, kind: "select", title: "Which db?", options: [...options, ASK_OTHER, ASK_CHAT], selectionMarker: "radio", markableCount: 2 });
		expect(replayStep(questions, answers, REPLAY_START, select(["SQLite", "Postgres"]))).toMatchObject({ kind: "answer", value: "Postgres" });
		// Answering by position here would pick SQLite, or MySQL.
		expect(replayStep(questions, answers, REPLAY_START, select(["Postgres", "SQLite"]))).toMatchObject({ kind: "mismatch", reason: "the options differ" });
		expect(replayStep(questions, answers, REPLAY_START, select(["SQLite", "MySQL"]))).toMatchObject({ kind: "mismatch", reason: "the options differ" });
		// A repeated label must carry omp's suffix, as in the duplicate-label replay above.
		const twins = [q("retry", ["Retry", "Retry"]), q("db", ["SQLite"])];
		const twinSelect = (options: string[]): CollabUiRequest => ({ reqId: 1, kind: "select", title: "Which retry?", options: [...options, ASK_OTHER, ASK_CHAT], selectionMarker: "radio", markableCount: 2 });
		const twinAnswers = [{ selected: [1], custom: "" }, defaultAnswer(twins[1] as AskQuestion)];
		expect(replayStep(twins, twinAnswers, REPLAY_START, twinSelect(["Retry", "Retry (2)"]))).toMatchObject({ kind: "answer", value: "Retry (2)" });
		expect(replayStep(twins, twinAnswers, REPLAY_START, twinSelect(["Retry", "Retry"]))).toMatchObject({ kind: "mismatch" });
	});

	it("accepts only the custom answer editor for the question being answered", () => {
		const questions = [q("db", ["SQLite"]), q("lang", ["TS"]), { ...q("long", ["x"]), question: "Which long question about the database layer and its migrations should we settle first?" }];
		const answers = [
			{ selected: [], custom: "DuckDB" },
			{ selected: [], custom: "Zig" },
			{ selected: [], custom: "Later" },
		];
		const editor = (title: string): CollabUiRequest => ({ reqId: 2, kind: "editor", title });
		const atEditor = (question: number): ReplayCursor => ({ question, awaiting: "editor", steps: 1 });
		expect(replayStep(questions, answers, atEditor(0), editor("Custom answer: Which db?"))).toMatchObject({ kind: "answer", value: "DuckDB" });
		// omp wraps the title at the terminal width.
		expect(replayStep(questions, answers, atEditor(0), editor("Custom answer: Which\ndb?"))).toMatchObject({ kind: "answer", value: "DuckDB" });
		// Another question's editor, or any other "Custom answer: " editor, is not this one.
		expect(replayStep(questions, answers, atEditor(0), editor("Custom answer: Which lang?"))).toMatchObject({ kind: "mismatch" });
		expect(replayStep(questions, answers, atEditor(0), editor("Custom answer: Something else entirely"))).toMatchObject({ kind: "mismatch" });
		// A title cut with "…" passes while it still names one question, and stops once it could be several.
		expect(replayStep(questions, answers, atEditor(2), editor("Custom answer: Which long question\nabout the database layer and…"))).toMatchObject({ kind: "answer", value: "Later" });
		expect(replayStep(questions, answers, atEditor(2), editor("Custom answer: Which…"))).toMatchObject({ kind: "mismatch" });
	});

	it("stops a multi-select whose toggles never take effect", () => {
		const questions = [q("lang", ["TS", "Go"], { multi: true }), q("db", ["SQLite"])];
		const stuck: CollabUiRequest = { reqId: 1, kind: "select", title: "Which lang?", options: ["TS", "Go", ASK_OTHER, ASK_CHAT], selectionMarker: "checkbox", checkedIndices: [], markableCount: 2 };
		const answers = [{ selected: [0], custom: "" }, defaultAnswer(questions[1] as AskQuestion)];
		let cursor = REPLAY_START;
		let last: ReplayStep | undefined;
		for (let round = 0; round < 20; round++) {
			last = replayStep(questions, answers, cursor, stuck);
			if (last.kind === "mismatch") break;
			cursor = last.cursor;
		}
		expect(last).toMatchObject({ kind: "mismatch" });
	});

	it("does not start a series for one question or a request past question 1", () => {
		const questions = [q("lang", ["TS", "Go"], { multi: true }), q("db", ["SQLite"])];
		const first: CollabUiRequest = { reqId: 1, kind: "select", title: "Which lang?", options: ["TS", "Go", ASK_OTHER, ASK_CHAT], selectionMarker: "checkbox", checkedIndices: [], markableCount: 2 };
		expect(isSeriesStart(questions, first)).toBe(true);
		expect(isSeriesStart(questions.slice(0, 1), first)).toBe(false);
		expect(isSeriesStart(questions, { ...first, options: ["TS", "Go", ASK_OTHER, ASK_NEXT, ASK_CHAT], checkedIndices: [0] })).toBe(false);
		expect(isSeriesStart(questions, { reqId: 2, kind: "select", title: "Which db?", options: ["SQLite", ASK_OTHER, ASK_CHAT], selectionMarker: "radio", markableCount: 1 })).toBe(false);
	});
});

describe("defaultAnswer and parseAskQuestions", () => {
	it("preselects omp's clamped recommended option for a single choice", () => {
		expect(defaultAnswer(q("a", ["x", "y", "z"], { recommended: 2 })).selected).toEqual([2]);
		expect(defaultAnswer(q("a", ["x", "y"], { recommended: 9 })).selected).toEqual([1]);
		expect(defaultAnswer(q("a", ["x"], { multi: true, recommended: 0 })).selected).toEqual([]);
	});

	it("coerces the tool call's arguments like omp's normalizeDialogQuestions", () => {
		expect(parseAskQuestions({ questions: [] })).toBeNull();
		expect(parseAskQuestions("nope")).toBeNull();
		expect(
			parseAskQuestions({
				questions: [{ id: "a", question: "Q?", options: [{ label: "x", description: "  why  " }, { label: 3 }, null], multi: true, recommended: 1.5 }, 7],
			}),
		).toEqual([{ id: "a", question: "Q?", options: [{ label: "x", description: "why" }, { label: "" }], multi: true }]);
	});
});

describe("findSeriesAsk", () => {
	const args = { questions: [{ id: "db", question: "Which\r\ndb?", options: [{ label: "SQLite" }] }, { id: "x", question: "Next?", options: [] }] };
	const assistant = (id: string, toolArgs: unknown): SessionEntry =>
		({ type: "message", id: `m-${id}`, parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id, name: "ask", arguments: toolArgs }] } }) as SessionEntry;
	const result = (id: string): SessionEntry =>
		({ type: "message", id: `r-${id}`, parentId: null, timestamp: "", message: { role: "toolResult", toolCallId: id, toolName: "ask", content: [], isError: false, timestamp: 0 } }) as SessionEntry;

	it("matches the running ask whose first question is the request title", () => {
		const activeTools = new Map([["call-1", { toolCallId: "call-1", toolName: "ask", args }]]);
		expect(findSeriesAsk({ activeTools, entries: [], stream: null, working: true }, "Which\ndb?")?.toolCallId).toBe("call-1");
		expect(findSeriesAsk({ activeTools, entries: [], stream: null, working: true }, "Next?")).toBeNull();
	});

	it("falls back to the turn's saved tool call when the running tools were dropped", () => {
		const source = { activeTools: new Map(), entries: [assistant("old", args), result("old"), assistant("call-2", args)], stream: null, working: true };
		expect(findSeriesAsk(source, "Which\ndb?")?.toolCallId).toBe("call-2");
		expect(isAskRunning(source, "call-2")).toBe(true);
		expect(isAskRunning(source, "old")).toBe(false);
		expect(isAskRunning({ ...source, working: false }, "call-2")).toBe(false);
		// Without the running tools, only the call itself in the mirror counts as evidence.
		expect(isAskRunning(source, "call-from-another-room")).toBe(false);
	});
});
