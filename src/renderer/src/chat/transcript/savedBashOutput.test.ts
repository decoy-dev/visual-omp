// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SavedToolOutput } from "@shared/session-output";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResultLike } from "../../tool-render/types";
import { SavedToolOutputContext, useSavedBashOutput, type SavedBashOutput, type SavedBashOutputInput } from "./savedBashOutput";
type Scope = { file: string | null; identity: string } | null;
let scope: Scope;
let generation = 0;
const clipped = (text = "partial"): ToolResultLike => ({ content: [{ type: "text", text: `${text}\n…[123 chars elided for collab session]` }] });
const saved = (text: string): SavedToolOutput => ({ status: "ready", content: [{ type: "text", text }] });
const deferred = () => Promise.withResolvers<SavedToolOutput>();

let element: HTMLDivElement, root: Root;
let current: SavedBashOutput;
const invoke = vi.fn<(...args: unknown[]) => Promise<SavedToolOutput>>();
const consumed = vi.fn();
function Consumer(props: SavedBashOutputInput) {
	current = useSavedBashOutput(props);
	consumed(current);
	return createElement("output", null, JSON.stringify(current.result?.content));
}
const cards = new Map<string, SavedBashOutput>();
function Card({ id, ...input }: SavedBashOutputInput & { id: string }) {
	const output = useSavedBashOutput(input);
	cards.set(id, output);
	return createElement("output", { "data-card": id }, JSON.stringify(output.result?.content));
}
async function renderCards(ids: string[], context: Scope = scope, result: ToolResultLike = clipped(), toolCallId?: string) {
	await act(async () => root.render(createElement(SavedToolOutputContext.Provider, { value: context },
		ids.map(id => createElement(Card, { key: id, id, name: "bash", running: false, toolCallId: toolCallId ?? id, result })))));
}
async function render(input: Partial<SavedBashOutputInput> = {}, context: Scope = scope, strict = false) {
	const consumer = createElement(SavedToolOutputContext.Provider, { value: context }, createElement(Consumer, {
		name: "bash", running: false, toolCallId: "call-1", ...input,
	}));
	await act(async () => root.render(strict ? createElement(StrictMode, null, consumer) : consumer));
}
async function settle(pending: PromiseWithResolvers<SavedToolOutput>, value: SavedToolOutput) {
	await act(async () => pending.resolve(value));
}

beforeEach(() => {
	scope = { file: "/sessions/current.jsonl", identity: `chat:${++generation}` };
	cards.clear();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	invoke.mockReset();
	invoke.mockResolvedValue({ status: "unavailable" });
	consumed.mockClear();
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
	Reflect.deleteProperty(window, "vomp");
});

describe("saved bash output", () => {
	it("keeps the caller's result until saved content is ready, preserving metadata and errors", async () => {
		const pending = deferred();
		invoke.mockReturnValue(pending.promise);
		const details = { exitCode: 1, trace: { text: "original trace" } };
		const result = { ...clipped(), details, isError: true };
		await render({ result });
		expect(invoke).toHaveBeenCalledExactlyOnceWith("sessions:toolOutput", scope!.file, "call-1", false);
		expect(current).toMatchObject({ result, needed: true, canLoad: true, loading: true, status: "loading" });
		expect(current.result).toBe(result);
		expect(element.textContent).toContain("partial");
		await settle(pending, saved("full saved output"));
		expect(current).toMatchObject({ needed: true, canLoad: true, loading: false, status: "ready" });
		expect(current.result).toEqual({ ...result, content: [{ type: "text", text: "full saved output" }] });
		expect(current.result?.details).toBe(details);
		expect(element.textContent).toContain("full saved output");
		await render({ result }, { ...scope! });
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("recognizes collab's primitive trailing array marker safely", async () => {
		const result = { content: [null, 42, false, { type: "image", text: "ignored" }, "…[3 items elided for collab session]"] } as unknown as ToolResultLike;
		invoke.mockResolvedValue(saved("recovered array"));
		await render({ result });
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(current.status).toBe("ready");
		expect(element.textContent).toContain("recovered array");
	});

	it.each([
		["long output", { content: [{ type: "text", text: "x".repeat(300_000) }] }],
		["trace-only text shrink", { content: [{ type: "text", text: "ordinary" }], details: { trace: clipped().content } }],
		["trace-only array shrink", { content: [], details: { trace: ["…[2 items elided for collab session]"] } }],
		["non-text content", { content: [{ type: "image", text: "image\n…[123 chars elided for collab session]" }] }],
		["non-suffix text", { content: [{ type: "text", text: "partial\n…[123 chars elided for collab session]\nmore" }] }],
		["missing appended newline", { content: [{ type: "text", text: "…[123 chars elided for collab session]" }] }],
		["inexact marker", { content: [{ type: "text", text: "partial\n...[123 chars elided for collab session]" }] }],
		["non-trailing array marker", { content: ["…[3 items elided for collab session]", { type: "text", text: "after" }] }],
		["malformed primitives", { content: [null, 42, true, {}, "ordinary"] }],
	] as const)("does not recover %s", async (_label, value) => {
		const result = value as unknown as ToolResultLike;
		await render({ result });
		expect(current).toMatchObject({ needed: false, canLoad: false, loading: false, status: "none" });
		expect(current.result).toBe(result);
		await act(async () => current.load());
		expect(invoke).not.toHaveBeenCalled();
	});

	it.each(["functions.bash", "Bash", "shell", "eval", "write"])("does not recover noncanonical tool %s", async name => {
		await render({ name, result: clipped() });
		expect(current.needed).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("does no streaming work and attempts recovery once the result settles", async () => {
		const result = clipped();
		await render({ running: true, result });
		await act(async () => current.load());
		expect(current).toMatchObject({ needed: false, loading: false, status: "none" });
		expect(invoke).not.toHaveBeenCalled();
		await render({ running: false, result });
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("does not request output without a result", async () => {
		await render();
		expect(current.result).toBeUndefined();
		expect(current.status).toBe("none");
		expect(invoke).not.toHaveBeenCalled();
	});

	it.each(["unavailable", "too-large"] as const)("keeps original content after %s and allows an explicit manual request", async status => {
		const result = clipped();
		invoke.mockResolvedValueOnce({ status });
		await render({ result });
		expect(current).toMatchObject({ needed: true, canLoad: true, loading: false, status });
		expect(current.result).toBe(result);
		await render({ result });
		expect(invoke).toHaveBeenCalledTimes(1);
		const manual = deferred();
		invoke.mockReturnValueOnce(manual.promise);
		await act(async () => current.load());
		expect(invoke).toHaveBeenLastCalledWith("sessions:toolOutput", scope!.file, "call-1", true);
		expect(current.status).toBe("loading");
		expect(current.result).toBe(result);
		await settle(manual, saved("manually loaded"));
		expect(current.status).toBe("ready");
		expect(element.textContent).toContain("manually loaded");
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it.each(["text", "array"])("keeps the original when the saved %s content is still collab-shrunk", async kind => {
		const result = clipped();
		const replica = kind === "text" ? clipped("saved replica").content : ["…[2 items elided for collab session]"];
		invoke.mockResolvedValue({ status: "ready", content: replica } as SavedToolOutput);
		await render({ result });
		expect(current).toMatchObject({ needed: true, canLoad: true, loading: false, status: "unavailable" });
		expect(current.result).toBe(result);
		await render({ result });
		expect(invoke).toHaveBeenCalledTimes(1);
		await act(async () => current.load());
		expect(invoke).toHaveBeenLastCalledWith("sessions:toolOutput", scope!.file, "call-1", true);
		expect(current.status).toBe("unavailable");
		expect(current.result).toBe(result);
	});

	it.each(["rejected promise", "synchronous throw", "missing bridge"])("reports unavailable for %s without retrying", async failure => {
		if (failure === "missing bridge") Reflect.deleteProperty(window, "vomp");
		else if (failure === "synchronous throw") invoke.mockImplementation(() => { throw new Error("closed"); });
		else invoke.mockRejectedValue(new Error("closed"));
		const result = clipped();
		await render({ result });
		expect(current.status).toBe("unavailable");
		expect(current.result).toBe(result);
		await render({ result });
		expect(invoke).toHaveBeenCalledTimes(failure === "missing bridge" ? 0 : 1);
	});

	it.each(["file", "toolCallId", "context"])("waits for missing %s before enabling recovery", async missing => {
		const result = clipped();
		await render({ result, toolCallId: missing === "toolCallId" ? undefined : "call-1" },
			missing === "context" ? null : missing === "file" ? { ...scope!, file: null } : scope);
		expect(current).toMatchObject({ needed: true, canLoad: false, loading: false, status: "unavailable" });
		expect(current.result).toBe(result);
		await act(async () => current.load());
		expect(invoke).not.toHaveBeenCalled();
		await render({ result });
		expect(current.canLoad).toBe(true);
		expect(invoke).toHaveBeenCalledExactlyOnceWith("sessions:toolOutput", scope!.file, "call-1", false);
	});

	it.each(["file", "identity", "toolCallId"])("ignores an old reply after changing %s", async changed => {
		const old = deferred(), next = deferred();
		invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
		const result = clipped("old source");
		await render({ result });
		const oldLoad = current.load;
		const nextResult = result;
		const nextScope = { ...scope!, ...(changed === "file" ? { file: "/sessions/next.jsonl" } : {}), ...(changed === "identity" ? { identity: `${scope!.identity}:next` } : {}) };
		await render({ result: nextResult, toolCallId: changed === "toolCallId" ? "call-2" : "call-1" }, nextScope);
		expect(invoke).toHaveBeenCalledTimes(2);
		await act(async () => oldLoad());
		expect(invoke).toHaveBeenCalledTimes(2);
		await settle(old, saved("stale saved output"));
		expect(current.status).toBe("loading");
		expect(current.result).toBe(nextResult);
		await settle(next, saved("current saved output"));
		expect(current.status).toBe("ready");
		expect(element.textContent).toContain("current saved output");
		expect(element.textContent).not.toContain("stale saved output");
	});

	it("invalidates recovery when a result starts streaming again or loses its marker", async () => {
		const pending = deferred();
		invoke.mockReturnValueOnce(pending.promise);
		const result = clipped();
		await render({ result });
		await render({ result, running: true });
		await settle(pending, saved("stale output"));
		expect(current.status).toBe("none");
		expect(current.result).toBe(result);
		const complete: ToolResultLike = { content: [{ type: "text", text: "complete" }] };
		await render({ result: complete });
		expect(current.result).toBe(complete);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("allows only the newest request to replace content", async () => {
		const automatic = deferred(), manual = deferred();
		invoke.mockReturnValueOnce(automatic.promise).mockReturnValueOnce(manual.promise);
		const result = clipped();
		await render({ result });
		await act(async () => current.load());
		await settle(manual, saved("newest output"));
		await settle(automatic, { status: "too-large" });
		expect(current.status).toBe("ready");
		expect(element.textContent).toContain("newest output");
	});

	it("retains each scope independently when returning to the same file and generation", async () => {
		const result = clipped();
		invoke.mockResolvedValueOnce(saved("first chat output"));
		await render({ result });
		const next = deferred();
		invoke.mockReturnValueOnce(next.promise);
		await render({ result }, { ...scope!, identity: "different chat" });
		expect(current.result).toBe(result);
		expect(current.status).toBe("loading");
		await render({ result });
		expect(current.status).toBe("ready");
		expect(element.textContent).toContain("first chat output");
		await settle(next, saved("different chat output"));
		expect(element.textContent).toContain("first chat output");
		expect(invoke).toHaveBeenCalledTimes(2);
		await render({ result }, { ...scope!, identity: "different chat" });
		expect(element.textContent).toContain("different chat output");
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("makes one automatic attempt through strict effect replay", async () => {
		const pending = deferred();
		invoke.mockReturnValue(pending.promise);
		await render({ result: clipped() }, scope, true);
		expect(invoke).toHaveBeenCalledTimes(1);
		await settle(pending, saved("strict saved output"));
		expect(current.status).toBe("ready");
	});

	it("ignores delayed failures after unmount", async () => {
		const pending = deferred();
		invoke.mockReturnValue(pending.promise);
		await render({ result: clipped() });
		await act(async () => root.render(null));
		const renders = consumed.mock.calls.length;
		await act(async () => pending.reject(new Error("closed")));
		expect(consumed).toHaveBeenCalledTimes(renders);
		expect(element.textContent).toBe("");
	});

	it("shares pending recovery across cards and reuses it for new source result objects", async () => {
		const pending = deferred();
		invoke.mockReturnValueOnce(pending.promise);
		const original = clipped();
		await renderCards(["first", "second"], scope, original, "shared-call");
		expect(invoke).toHaveBeenCalledExactlyOnceWith("sessions:toolOutput", scope!.file, "shared-call", false);
		expect(cards.get("first")?.result).toBe(original);
		expect(cards.get("second")?.status).toBe("loading");
		const details = { exitCode: 9 };
		const replacement = { ...clipped("new source"), details, isError: true };
		await renderCards(["first", "second"], scope, replacement, "shared-call");
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(cards.get("first")?.result).toBe(replacement);
		await settle(pending, saved("shared output"));
		for (const id of ["first", "second"]) {
			expect(cards.get(id)?.status).toBe("ready");
			expect(cards.get(id)?.result).toEqual({ ...replacement, content: [{ type: "text", text: "shared output" }] });
			expect(cards.get(id)?.result?.details).toBe(details);
		}
		await renderCards(["first", "second"], scope, { ...replacement }, "shared-call");
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("retains pending work and its result while every card is unmounted", async () => {
		const pending = deferred();
		invoke.mockReturnValueOnce(pending.promise);
		await render({ result: clipped() });
		await act(async () => root.render(null));
		await render({ result: clipped("remounted source") });
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(current.status).toBe("loading");
		await act(async () => root.render(null));
		await settle(pending, saved("saved while unmounted"));
		const details = { exitCode: 3 };
		await render({ result: { ...clipped(), details } });
		expect(current.status).toBe("ready");
		expect(current.result?.details).toBe(details);
		expect(element.textContent).toContain("saved while unmounted");
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it.each(["unavailable", "too-large"] as const)("retains %s across remounts but allows fresh manual retries", async status => {
		invoke.mockResolvedValueOnce({ status });
		await render({ result: clipped() });
		await act(async () => root.render(null));
		await render({ result: clipped("remounted source") });
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(current.status).toBe(status);
		invoke.mockResolvedValueOnce({ status: "unavailable" });
		await act(async () => current.load());
		expect(invoke).toHaveBeenLastCalledWith("sessions:toolOutput", scope!.file, "call-1", true);
		expect(current.status).toBe("unavailable");
		invoke.mockResolvedValueOnce(saved("manual retry output"));
		await act(async () => current.load());
		expect(current.status).toBe("ready");
		await act(async () => root.render(null));
		await render({ result: clipped() });
		expect(element.textContent).toContain("manual retry output");
		expect(invoke).toHaveBeenCalledTimes(3);
	});

	it.each(["automatic first", "manual first"])("coalesces manual upgrades and retains only the newest outcome: %s", async order => {
		const automatic = deferred(), manual = deferred();
		invoke.mockReturnValueOnce(automatic.promise).mockReturnValueOnce(manual.promise);
		const result = clipped();
		await renderCards(["first", "second"], scope, result, "shared-call");
		await act(async () => {
			cards.get("first")!.load();
			cards.get("second")!.load();
		});
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(invoke).toHaveBeenLastCalledWith("sessions:toolOutput", scope!.file, "shared-call", true);
		await renderCards(["first", "second", "third"], scope, clipped("new consumer"), "shared-call");
		expect(invoke).toHaveBeenCalledTimes(2);
		if (order === "automatic first") {
			await settle(automatic, saved("outdated automatic output"));
			expect(cards.get("third")?.status).toBe("loading");
			expect(element.textContent).not.toContain("outdated automatic output");
		}
		await settle(manual, saved("manual shared output"));
		await act(async () => root.render(null));
		if (order === "manual first") await settle(automatic, { status: "too-large" });
		await renderCards(["remount"], scope, clipped(), "shared-call");
		expect(cards.get("remount")?.status).toBe("ready");
		expect(element.textContent).toContain("manual shared output");
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("does not let stale automatic success replace a settled manual failure", async () => {
		const automatic = deferred(), manual = deferred();
		invoke.mockReturnValueOnce(automatic.promise).mockReturnValueOnce(manual.promise);
		await render({ result: clipped() });
		await act(async () => current.load());
		await settle(manual, { status: "unavailable" });
		await act(async () => root.render(null));
		await settle(automatic, saved("stale automatic success"));
		const result = clipped("current original");
		await render({ result });
		expect(current.status).toBe("unavailable");
		expect(current.result).toBe(result);
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it.each(["file", "identity", "toolCallId"])("isolates retained content by exact %s", async changed => {
		invoke.mockResolvedValueOnce(saved("first scope output"));
		await render({ result: clipped() });
		invoke.mockResolvedValueOnce(saved("second scope output"));
		await render({ result: clipped(), toolCallId: changed === "toolCallId" ? "CALL-1" : "call-1" }, {
			...scope!,
			...(changed === "file" ? { file: "/sessions/Current.jsonl" } : {}),
			...(changed === "identity" ? { identity: `${scope!.identity}:next` } : {}),
		});
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(element.textContent).toContain("second scope output");
		await render({ result: clipped() });
		expect(element.textContent).toContain("first scope output");
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("evicts the oldest retained entries at the entry bound without exposing old content", async () => {
		invoke.mockResolvedValue(saved("retained output"));
		await renderCards(["oldest"]);
		await renderCards(Array.from({ length: 127 }, (_, index) => `entry-${index}`));
		await renderCards(["oldest"]);
		expect(invoke).toHaveBeenCalledTimes(128);
		await renderCards(["overflow"]);
		const pending = deferred();
		invoke.mockReturnValueOnce(pending.promise);
		const result = clipped("evicted original");
		// Reusing oldest above refreshed its recency, so entry-0 is now the oldest.
		await renderCards(["entry-0"], scope, result);
		expect(invoke).toHaveBeenCalledTimes(130);
		expect(cards.get("entry-0")?.result).toBe(result);
		expect(cards.get("entry-0")?.status).toBe("loading");
		expect(element.textContent).not.toContain("retained output");
		await settle(pending, saved("newly recovered output"));
	});

	it("bounds retained UTF-8 serialized content and invalidates mounted evicted results", async () => {
		const large = saved("é".repeat(2 * 1024 * 1024));
		invoke.mockResolvedValue(large);
		await renderCards(["large-first"]);
		const result = clipped("original after eviction");
		await renderCards(["large-first", "large-second"], scope, result);
		// Each serialized content value is just over 4 MiB, so two exceed 8 MiB.
		expect(cards.get("large-first")?.result).toBe(result);
		expect(cards.get("large-first")?.status).toBe("none");
		expect(cards.get("large-second")?.status).toBe("ready");
		expect(invoke).toHaveBeenCalledTimes(2);
		await renderCards(["large-second"]);
		expect(invoke).toHaveBeenCalledTimes(2);
		const pending = deferred();
		invoke.mockReturnValueOnce(pending.promise);
		await renderCards(["large-first"], scope, result);
		expect(cards.get("large-first")?.status).toBe("loading");
		expect(cards.get("large-first")?.result).toBe(result);
		await settle(pending, saved("fresh small output"));
	});

	it("retains an oversized outcome without retaining content or repeating automatic work", async () => {
		invoke.mockResolvedValueOnce(saved("é".repeat(4 * 1024 * 1024)));
		const result = clipped();
		await render({ result });
		expect(current.status).toBe("too-large");
		expect(current.result).toBe(result);
		await act(async () => root.render(null));
		await render({ result: clipped() });
		expect(current.status).toBe("too-large");
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("declines new work while all retained entries are pending and allows a later manual retry", async () => {
		const pending = deferred();
		invoke.mockReturnValue(pending.promise);
		const ids = Array.from({ length: 129 }, (_, index) => `pending-${index}`);
		await renderCards(ids);
		expect(invoke).toHaveBeenCalledTimes(128);
		expect(cards.get("pending-128")?.status).toBe("unavailable");
		await act(async () => cards.get("pending-128")!.load());
		expect(invoke).toHaveBeenCalledTimes(128);
		await settle(pending, { status: "unavailable" });
		invoke.mockResolvedValueOnce(saved("retry after capacity returned"));
		await act(async () => cards.get("pending-128")!.load());
		expect(invoke).toHaveBeenCalledTimes(129);
		expect(invoke).toHaveBeenLastCalledWith("sessions:toolOutput", scope!.file, "pending-128", true);
		expect(cards.get("pending-128")?.status).toBe("ready");
	});

	it("ignores an evicted request's late reply even after the same key is recreated", async () => {
		const automatic = deferred(), replacement = deferred();
		invoke.mockReturnValueOnce(automatic.promise).mockResolvedValueOnce(saved("manual retained output"));
		await render({ result: clipped() });
		await act(async () => current.load());
		await act(async () => root.render(null));
		invoke.mockResolvedValue(saved("other output"));
		await renderCards(Array.from({ length: 128 }, (_, index) => `eviction-${index}`));
		invoke.mockReturnValueOnce(replacement.promise);
		const result = clipped("recreated original");
		await render({ result });
		await settle(automatic, saved("evicted stale output"));
		expect(current.status).toBe("loading");
		expect(current.result).toBe(result);
		await settle(replacement, saved("replacement output"));
		await act(async () => root.render(null));
		await render({ result: clipped() });
		expect(current.status).toBe("ready");
		expect(element.textContent).toContain("replacement output");
		expect(element.textContent).not.toContain("evicted stale output");
		expect(invoke).toHaveBeenCalledTimes(131);
	});
});
