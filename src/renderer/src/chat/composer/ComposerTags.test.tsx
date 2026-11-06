// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerMirror, modelTagAtCaret, useComposerAssist } from "./ComposerTags";
import type { ComposerAssist, ComposerAssistRequest } from "@shared/contracts/composer";

it("recognizes only omp's whitespace-delimited model token at the caret", () => {
	for (const [text, query] of [["^", ""], ["use ^gpt-6", "gpt-6"], ["first\n^provider/id:h", "provider/id:h"], ["^local/qwen:8b:", "local/qwen:8b:"]]) {
		expect(modelTagAtCaret(text!, text!.length)).toEqual({ start: text!.lastIndexOf("^"), query });
	}
	for (const text of ["x^model", "(^model", "^model ", "^model\n", "email@example"]) expect(modelTagAtCaret(text, text.length)).toBeNull();
	expect(modelTagAtCaret("^provider/model", 9)).toEqual({ start: 0, query: "provider" });
	expect(modelTagAtCaret("^model", -1)).toBeNull();
});

it("paints only reported prose ranges while preserving all text and @ mentions", () => {
	const text = "ultrathink `ultrathink` @file.ts\n";
	const markup = renderToStaticMarkup(createElement(ComposerMirror, { text, keywords: [{ start: 0, end: 10, description: "Maximum thinking" }] }));
	const mirror = document.createElement("div"); mirror.innerHTML = markup;
	expect(mirror.textContent).toBe(text + " ");
	expect(mirror.querySelectorAll("[data-composer-keyword]")).toHaveLength(1);
	expect(mirror.querySelector("[data-composer-keyword]")?.textContent).toBe("ultrathink");
	expect(mirror.querySelector(".bg-accent-muted")?.textContent).toBe("@file.ts");
});

afterEach(() => vi.useRealTimers());
it("keeps decorations during caret movement, skips keyword rereads and cancels superseded completion", async () => {
	vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const calls: { request: ComposerAssistRequest; resolve(result: ComposerAssist): void }[] = [];
	const invoke = vi.fn((channel: string, _host: string, _generation: number, request: ComposerAssistRequest | string) => {
		if (channel === "composer:cancelAssist") return Promise.resolve();
		const deferred = Promise.withResolvers<ComposerAssist>();
		calls.push({ request: request as ComposerAssistRequest, resolve: deferred.resolve });
		return deferred.promise;
	});
	Object.assign(window, { vomp: { on: () => () => {}, invoke } });
	let latest: ComposerAssist | undefined;
	const text = "chillax ^fixture/model";
	function Probe({ cursor, generation = 1 }: { cursor: number; generation?: number }) { latest = useComposerAssist("host", generation, text, cursor, true, true); return null; }
	const element = document.createElement("div"); const root = createRoot(element);
	const keywords = [{ start: 0, end: 7, description: "Lowest effort" }];
	try {
		await act(async () => { root.render(createElement(Probe, { cursor: text.length })); });
		await act(async () => { vi.advanceTimersByTime(100); });
		expect(calls).toHaveLength(2);
		const decoration = calls.find(call => call.request.keywords)!;
		const oldCompletion = calls.find(call => call.request.complete)!;
		await act(async () => decoration.resolve({ items: null, keywords }));
		expect(latest?.keywords).toEqual(keywords);
		await act(async () => { root.render(createElement(Probe, { cursor: text.length - 1 })); });
		expect(latest?.keywords).toEqual(keywords);
		await act(async () => { vi.advanceTimersByTime(100); });
		expect(calls.filter(call => call.request.keywords)).toHaveLength(1);
		expect(invoke).toHaveBeenCalledWith("composer:cancelAssist", "host", 1, oldCompletion.request.id);
		await act(async () => oldCompletion.resolve({ items: [{ value: "old", description: "Old" }], keywords: [] }));
		expect(latest?.items).toBeNull();
		await act(async () => calls[2]!.resolve({ items: [{ value: "new", description: "New" }], keywords: [] }));
		expect(latest?.items?.[0]?.value).toBe("new");
		await act(async () => { root.render(createElement(Probe, { cursor: text.length, generation: 2 })); });
		expect(latest?.keywords).toEqual([]);
	} finally { await act(async () => root.unmount()); }
});
