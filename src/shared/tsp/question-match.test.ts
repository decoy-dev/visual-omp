import { describe, expect, it } from "vitest";
import { hookQuestions, type HookQuestion } from "./hook-questions";
import { matchQuestions, type CollabQuestionState } from "./question-match";
import { QuestionArbitrator } from "./question-arbitrator";
import type { TspNode } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";

const scope = { hostId: "host", generation: 1, epoch: 1 };
const dialog: HookQuestion = { surfaceId: "s", nodeId: "hook", title: "Choose", kind: "select", options: [{ label: "Yes", description: "Continue" }, { label: "No" }] };
const state: CollabQuestionState = { ...scope, revision: 1, connection: 1, connected: true, requests: [{ reqId: 4, kind: "select", title: "Choose", options: [{ label: "Yes", description: "Continue" }, "No"] }] };

const resetCases = (["Claude", "Codex"] as const).flatMap(provider => [1, 2].map(count => ({
	provider,
	count,
	title: count === 1 ? `Spend a saved ${provider} rate-limit reset?` : `Spend ${count} saved ${provider} rate-limit resets?`,
	lines: Array.from({ length: count }, (_, index) => provider === "Claude"
		? `${index ? "personal" : "work"}@example.com (Example): 5h session-only reset covers Claude 5h with about 1h left.`
		: `${index ? "personal" : "work"}@example.com (Example) is blocked by the Codex weekly limit for about 1h.`),
	options: [{ label: "Yes", description: `Redeem now and remember yes for future eligible ${provider} resets.` }, { label: "No", description: `Do not auto-redeem saved ${provider} resets.` }],
})));

const windowResetCases = [
	{ provider: "Codex", window: "5h", key: "codexResets.autoRedeem5h", limit: "Codex 5h" },
	{ provider: "Codex", window: "weekly", key: "codexResets.autoRedeemWeekly", limit: "Codex weekly" },
	{ provider: "Claude", window: "5h", key: "claudeResets.autoRedeem5h", limit: "Claude 5h" },
	{ provider: "Claude", window: "weekly", key: "claudeResets.autoRedeemWeekly", limit: "Claude weekly" },
	{ provider: "Claude", window: "Fable", key: "claudeResets.autoRedeemFable", limit: "Claude Fable weekly" },
].flatMap(({ provider, window, key, limit }) => [1, 2].map(count => ({
	provider, window, count,
	title: count === 1 ? `Spend a saved ${provider} rate-limit reset?` : `Spend ${count} saved ${provider} rate-limit resets?`,
	lines: Array.from({ length: count }, (_, index) => `${index ? "personal" : "work"}@example.com (Example): a saved reset covers ${limit} with about 1h left.`),
	options: [{ label: "Yes", description: `Redeem now and set ${key} to yes.` }, { label: "No", description: `Do not redeem, and set ${key} to no.` }],
})));

function resetFixture<Option extends { label: string; description?: string }>(value: { title: string; lines: string[]; options: Option[] }, shape: "picker" | "card") {
	const items = value.options.map((option, index) => ({ id: String(index), label: option.label, detail: option.description }));
	const node: TspNode = shape === "picker"
		? { id: "hook", k: "picker", p: { title: value.title, subtitle: value.lines.join("\n"), noun: "options", size: "md", layout: "rows", preview: "none", query: null, items, selected: "0", total: 2, empty: "No matching options", actions: [{ id: "confirm", label: "Select", keys: ["enter"], primary: true }, { id: "close", label: "Close", keys: ["esc"], end: true }] } }
		: { id: "hook", k: "card", p: { role: "omp.overlay.hook-select", head: value.title }, c: [
			{ id: "hook.detail", k: "text", p: { spans: [{ t: value.lines.join("\n"), s: "accent" }], wrap: "word" } },
			{ id: "hook.list", k: "list", p: { selected: "0" }, c: items.map(item => ({ id: `hook.list/${item.id}`, k: "item", p: { key: item.id, label: [{ t: item.label }], ...(item.detail === undefined ? {} : { detail: [{ t: item.detail, s: "muted" }] }) } })) },
		] };
	const surface: TspSurfaceSnapshot & { documentGeneration: number } = { open: { id: "s", mode: "inline" }, documentGeneration: 1, sequence: 1, closed: false, suspended: false, focus: null, settled: [], document: { id: "s", k: "col", c: [{ id: "layer", k: "col", c: [node] }] } };
	return { surface, request: { reqId: 9, kind: "select" as const, title: [value.title, ...value.lines].join("\n"), options: value.options } };
}
describe("hook-collab question arbitration", () => {
	it("matches only mutual unique title, field and option data", () => {
		expect(matchQuestions(scope, state, [dialog])).toMatchObject([{ status: "matched", reqId: 4 }]);
		for (const changed of [{ ...dialog, title: "Other" }, { ...dialog, options: [{ label: "Yes" }] }, { ...dialog, options: [{ label: "Yes", description: "Different" }, { label: "No" }] }]) expect(matchQuestions(scope, state, [changed])[0]?.status).toBe("ambiguous");
		const editor: HookQuestion = { ...dialog, kind: "editor", field: "draft" };
		const request = { reqId: 7, kind: "editor" as const, title: "Choose", prefill: "draft" };
		expect(matchQuestions(scope, { ...state, requests: [request] }, [editor])[0]?.status).toBe("matched");
		expect(matchQuestions(scope, { ...state, requests: [request] }, [{ ...editor, field: "changed" }])[0]?.status).toBe("ambiguous");
	});
	// omp v18.18.6: agent-session.ts #confirmAutoRedeem and hook-selector.ts describe().
	it.each(resetCases.flatMap(value => (["picker", "card"] as const).map(shape => ({ ...value, shape }))))("matches $count saved $provider resets in the native $shape with the full collab title", value => {
		const { surface, request } = resetFixture(value, value.shape);
		expect(matchQuestions(scope, { ...state, requests: [request] }, hookQuestions([surface], 1))).toMatchObject([{ status: "matched", reqId: 9 }]);
	});
	// omp v18.18.7 keeps the same identity contract while descriptions name the governing window keys.
	it.each(windowResetCases.flatMap(value => (["picker", "card"] as const).map(shape => ({ ...value, shape }))))("matches $count saved $provider $window resets in the native $shape", value => {
		const { surface, request } = resetFixture(value, value.shape);
		expect(matchQuestions(scope, { ...state, requests: [request] }, hookQuestions([surface], 1))).toMatchObject([{ status: "matched", reqId: 9 }]);
		const changedWindow = { ...request, options: request.options.map(option => ({ ...option, description: option.description.replace(/autoRedeem\w+/g, "autoRedeemOther") })) };
		expect(matchQuestions(scope, { ...state, requests: [changedWindow] }, hookQuestions([surface], 1))).toMatchObject([{ status: "ambiguous" }]);
	});
	it.each(["picker", "card"] as const)("distinguishes saved resets from another pending question in a %s", shape => {
		const { surface, request } = resetFixture(resetCases[0]!, shape);
		const dialogs = hookQuestions([surface], 1);
		const unrelated = { ...request, reqId: 10, title: "Continue with this task?" };
		const otherAccount = { ...request, reqId: 11, title: request.title.replace("work@example.com", "another@example.com") };
		expect(matchQuestions(scope, { ...state, requests: [unrelated, otherAccount, request] }, dialogs)).toMatchObject([{ status: "matched", reqId: 9 }]);
		expect(matchQuestions(scope, { ...state, requests: [unrelated, otherAccount] }, dialogs)).toMatchObject([{ status: "ambiguous" }]);
		expect(matchQuestions(scope, { ...state, requests: [request, { ...request, reqId: 12 }] }, dialogs)).toMatchObject([{ status: "ambiguous" }]);
		const changedDescription = { ...request, options: request.options.map(option => ({ ...option, description: "A different consequence." })) };
		expect(matchQuestions(scope, { ...state, requests: [changedDescription] }, dialogs)).toMatchObject([{ status: "ambiguous" }]);
	});
	// omp v18.18.8: interactive-mode.ts #promptCfgChange; hook-selector.ts renders the first line as inline Markdown.
	it.each(["picker", "card"] as const)("matches a config change approval whose collab title keeps Markdown code marks in a %s", shape => {
		const change = { title: "Your agent wants to save task.agentModelOverrides to your config.", lines: ['{"task":"fixture/model-a:high"} → {"task":"fixture/model-b:high"}'], options: [{ label: "Always for this session" }, { label: "Allow once" }, { label: "Deny" }] };
		const { surface, request } = resetFixture(change, shape);
		const dialogs = hookQuestions([surface], 1);
		const sourceTitle = (path: string) => [`Your agent wants to save \`${path}\` to your config.`, ...change.lines].join("\n");
		expect(matchQuestions(scope, { ...state, requests: [{ ...request, title: sourceTitle("task.agentModelOverrides") }] }, dialogs)).toMatchObject([{ status: "matched", reqId: 9 }]);
		expect(matchQuestions(scope, { ...state, requests: [{ ...request, title: sourceTitle("task.agentModelDefaults") }] }, dialogs)).toMatchObject([{ status: "ambiguous" }]);
	});
	it("matches option labels and descriptions omp rendered from inline Markdown", () => {
		const markdown = { ...state.requests[0]!, options: [{ label: "**Yes**", description: "Continue with [the plan (draft)](https://example.com/plan_(v2))" }, "_No_"] };
		const rendered: HookQuestion = { ...dialog, options: [{ label: "Yes", description: "Continue with the plan (draft)" }, { label: "No" }] };
		expect(matchQuestions(scope, { ...state, requests: [markdown] }, [rendered])).toMatchObject([{ status: "matched", reqId: 4 }]);
	});
	it.each([
		["Remove api_key from your config?", "Remove apikey from your config?"],
		["Open ~/config?", "Open /config?"],
		["Use a*b?", "Use ab?"],
		["Use a*b?", "Use `a b`?"],
		["Use AB?", "Use A<br>B?"],
		["Solve (x)?", "Solve \\(x\\)?"],
		["Keep old?", "Keep ~~old~~?"],
	])("keeps literal characters distinct: %s against %s", (native, source) => {
		expect(matchQuestions(scope, { ...state, requests: [{ ...state.requests[0]!, title: source }] }, [{ ...dialog, title: native }])).toMatchObject([{ status: "ambiguous" }]);
	});
	it("renders only the heading, so code inside the source heading matches its literal text", () => {
		expect(matchQuestions(scope, { ...state, requests: [{ ...state.requests[0]!, title: "Use `a*b`?" }] }, [{ ...dialog, title: "Use a*b?" }])).toMatchObject([{ status: "matched" }]);
	});
	it.each(["picker", "card"] as const)("compares selector detail lines literally in a %s", shape => {
		const question = { title: "Save the folder?", lines: ["C:\\work_dir\\`notes`"], options: [{ label: "Yes" }, { label: "No" }] };
		const { surface, request } = resetFixture(question, shape);
		const dialogs = hookQuestions([surface], 1);
		expect(matchQuestions(scope, { ...state, requests: [request] }, dialogs)).toMatchObject([{ status: "matched", reqId: 9 }]);
		for (const detail of ["C:work_dir\\`notes`", "C:\\work_dir\\notes"]) {
			expect(matchQuestions(scope, { ...state, requests: [{ ...request, title: `Save the folder?\n${detail}` }] }, dialogs)).toMatchObject([{ status: "ambiguous" }]);
		}
	});
	it("compares text-entry titles literally, as omp shows them", () => {
		const editor: HookQuestion = { ...dialog, kind: "editor", title: "Name for `branch`", field: "" };
		const request = { reqId: 7, kind: "editor" as const, title: "Name for `branch`" };
		expect(matchQuestions(scope, { ...state, requests: [request] }, [editor])).toMatchObject([{ status: "matched", reqId: 7 }]);
		expect(matchQuestions(scope, { ...state, requests: [request] }, [{ ...editor, title: "Name for branch" }])).toMatchObject([{ status: "ambiguous" }]);
	});
	it("handles collab first and TSP first without treating absence as identity", () => {
		for (const first of ["collab", "tsp"]) {
			const arb = new QuestionArbitrator();
			if (first === "collab") { arb.update(scope, state); expect(arb.matches(scope, [])).toEqual([]); }
			else expect(arb.matches(scope, [dialog])[0]?.status).toBe("unavailable");
			arb.update(scope, state);
			expect(arb.matches(scope, [dialog])[0]?.status).toBe("matched");
		}
	});
	it("disables local answers for duplicate requests or duplicate live dialogs", () => {
		expect(matchQuestions(scope, { ...state, requests: [...state.requests, { ...state.requests[0]!, reqId: 5 }] }, [dialog])[0]?.status).toBe("ambiguous");
		expect(matchQuestions(scope, state, [dialog, { ...dialog, nodeId: "other" }]).map(match => match.status)).toEqual(["ambiguous", "ambiguous"]);
	});
	it("marks local questions unmatched only with an authoritative empty collab mirror", () => {
		expect(matchQuestions(scope, { ...state, requests: [] }, [dialog])[0]?.status).toBe("unmatched");
		expect(matchQuestions(scope, null, [dialog])[0]?.status).toBe("unavailable");
		expect(matchQuestions(scope, { ...state, connected: false }, [dialog])[0]?.status).toBe("unavailable");
	});
	it("rejects stale host, generation, epoch and revision updates", () => {
		const arb = new QuestionArbitrator();
		arb.update(scope, state);
		for (const stale of [{ ...state, hostId: "other" }, { ...state, generation: 0 }, { ...state, epoch: 0 }, { ...state, requests: [] }]) expect(arb.update(scope, stale)).toBe(false);
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("matched");
		for (const changed of [{ ...scope, epoch: 2 }, { ...scope, generation: 2 }]) expect(arb.matches(changed, [dialog])[0]?.status).toBe("unavailable");
	});
	it("keeps strict mirror validation and strips unknown request fields", () => {
		for (const invalid of [
			null, { ...state, extra: true }, { ...state, connection: -1 }, { ...state, revision: 1.5 },
			{ ...state, requests: [{ ...state.requests[0], reqId: -1 }] },
		]) expect(new QuestionArbitrator().update(scope, invalid)).toBe(false);
		const arb = new QuestionArbitrator();
		expect(arb.update(scope, { ...state, requests: [{ ...state.requests[0], extra: true }] })).toBe(true);
		expect(arb.matches(scope, [dialog])[0]).toMatchObject({ status: "matched", reqId: 4 });
	});
	it("invalidates match authority on disconnect while preserving a bound dialog's completion guard", () => {
		const arb = new QuestionArbitrator();
		arb.update(scope, state); arb.matches(scope, [dialog]);
		arb.update(scope, { ...state, revision: 2, connected: false, requests: [] });
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("unavailable");
		arb.update(scope, { ...state, revision: 3, connection: 2, requests: [] });
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("settling");
		expect(() => arb.answer(scope, [dialog], "s", "hook")).toThrow("settling");
		expect(arb.matches(scope, [])).toEqual([]);
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("unmatched");
		expect(arb.canAnswerShutdown(scope, [dialog], "s", "hook")).toBe(true);
	});
	it("shares local and shutdown answer ownership without requiring a connected shutdown mirror", () => {
		const arb = new QuestionArbitrator();
		expect(arb.canAnswerShutdown(scope, [dialog], "s", "hook")).toBe(true);
		arb.answer(scope, [dialog], "s", "hook", "shutdown");
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("answering");
		expect(arb.canAnswerShutdown(scope, [dialog], "s", "hook")).toBe(false);
		expect(() => arb.answer(scope, [dialog], "s", "hook", "shutdown")).toThrow("answering");
		arb.matches(scope, []);
		arb.update(scope, { ...state, requests: [] });
		arb.answer(scope, [dialog], "s", "hook");
		expect(arb.canAnswerShutdown(scope, [dialog], "s", "hook")).toBe(false);
	});
	it("retains answer ownership when input authority ends before physical node departure", () => {
		const arb = new QuestionArbitrator();
		arb.answer(scope, [dialog], "s", "hook", "shutdown");
		expect(arb.matches(scope, [], [dialog])).toEqual([]);
		expect(arb.canAnswerShutdown(scope, [dialog], "s", "hook")).toBe(false);
		arb.matches(scope, [], []);
		expect(arb.canAnswerShutdown(scope, [dialog], "s", "hook")).toBe(true);
	});
	it.each(["matched", "ambiguous", "settling"])("retains %s shutdown exclusion across a disconnected empty mirror", status => {
		const arb = new QuestionArbitrator();
		arb.update(scope, { ...state, requests: status === "ambiguous" ? [...state.requests, { ...state.requests[0]!, reqId: 5 }] : state.requests });
		arb.matches(scope, [dialog]);
		if (status === "settling") arb.update(scope, { ...state, revision: 2, requests: [] });
		expect(arb.matches(scope, [dialog])[0]?.status).toBe(status);
		arb.update(scope, { ...state, revision: 3, connected: false, requests: [] });
		expect(arb.canAnswerShutdown(scope, [dialog], "s", "hook")).toBe(false);
		expect(() => arb.answer(scope, [dialog], "s", "hook", "shutdown")).toThrow("unavailable");
	});
	it("waits for remote settlement AND node departure in either order", () => {
		for (const first of ["node", "request"]) {
			const arb = new QuestionArbitrator(); arb.update(scope, state); arb.matches(scope, [dialog]);
			if (first === "node") expect(arb.matches(scope, [])).toEqual([]);
			arb.update(scope, { ...state, revision: 2, requests: [] });
			if (first === "request") expect(arb.matches(scope, [dialog])[0]?.status).toBe("settling");
			expect(arb.matches(scope, [])).toEqual([]);
			expect(arb.matches(scope, [dialog])[0]?.status).toBe("unmatched");
		}
	});
	it("keeps an ordinary hook settling when its request is replaced before the node departs", () => {
		const arb = new QuestionArbitrator();
		arb.update(scope, state);
		expect(arb.matches(scope, [dialog])[0]).toMatchObject({ status: "matched", reqId: 4 });
		arb.update(scope, { ...state, revision: 2, requests: [{ ...state.requests[0]!, reqId: 5 }] });
		expect(arb.matches(scope, [dialog])[0]).toMatchObject({ status: "settling", reqId: 4 });
		expect(() => arb.answer(scope, [dialog], "s", "hook")).toThrow("settling");
		arb.matches(scope, []);
		expect(arb.matches(scope, [dialog])[0]).toMatchObject({ status: "matched", reqId: 5 });
	});
	it("extracts only live current-generation hook data", () => {
		const surface = { open: { id: "s", mode: "inline" as const }, sequence: 1, closed: false, suspended: false, focus: null, settled: [], documentGeneration: 1, document: { id: "hook", k: "overlay" as const, p: { role: "omp.overlay.hook-select", head: "Choose" }, c: [{ id: "picker", k: "picker" as const, p: { items: [{ id: "yes", label: "Yes", detail: "Continue" }, { id: "no", label: "No" }] } }] } };
		expect(hookQuestions([surface], 1)).toEqual([{ ...dialog, field: undefined }]);
		for (const changed of [{ ...surface, closed: true }, { ...surface, suspended: true }, { ...surface, documentGeneration: 0 }]) expect(hookQuestions([changed], 1)).toEqual([]);
	});
	it("keeps a local answer blocked until its node departs, including reconnects", () => {
		const arb = new QuestionArbitrator();
		arb.update(scope, { ...state, requests: [] });
		arb.answer(scope, [dialog], "s", "hook");
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("answering");
		expect(() => arb.answer(scope, [dialog], "s", "hook")).toThrow("answering");
		arb.update(scope, { ...state, revision: 2, connected: false, requests: [] });
		arb.update(scope, { ...state, revision: 3, connection: 2, requests: [] });
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("answering");
		expect(arb.matches(scope, [])).toEqual([]);
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("unmatched");
		expect(arb.matches({ ...scope, epoch: 2 }, [dialog])[0]?.status).toBe("unavailable");
	});
	it.each(["node", "request"])("records stable monotonic observation times when %s arrives first", first => {
		let now = 10;
		const arb = new QuestionArbitrator(() => now);
		if (first === "node") expect(arb.matches(scope, [dialog])[0]).toMatchObject({ nodeFirstSeenMs: 10, status: "unavailable" });
		else arb.update(scope, state);
		now = 25;
		if (first === "node") arb.update(scope, state);
		const match = arb.matches(scope, [dialog])[0]!;
		expect(match).toMatchObject({ status: "matched", nodeFirstSeenMs: first === "node" ? 10 : 25, requestFirstSeenMs: first === "node" ? 25 : 10 });
		now = 40; arb.update(scope, { ...state, revision: 2 });
		expect(arb.matches(scope, [dialog])[0]).toEqual(match);
		arb.update(scope, { ...state, revision: 3, requests: [] });
		expect(arb.matches(scope, [dialog])[0]).toMatchObject({ status: "settling", nodeFirstSeenMs: match.nodeFirstSeenMs, requestFirstSeenMs: match.requestFirstSeenMs });
		arb.matches(scope, []);
		now = 60;
		expect(arb.matches(scope, [dialog])[0]).toMatchObject({ status: "unmatched", nodeFirstSeenMs: 60 });
		expect(arb.matches(scope, [dialog])[0]?.requestFirstSeenMs).toBeUndefined();
	});
});
