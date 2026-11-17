// @vitest-environment happy-dom
import { act, createElement, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../i18n";
import { CompactAtField } from "./CompactAtField";

let container: HTMLDivElement;
let root: Root;
const onSave = vi.fn(async (_tokens: number | null) => true);

async function render(value: number | null, destination = "chat-a"): Promise<void> {
	await act(async () => {
		root.render(createElement(Suspense, { fallback: null }, createElement(CompactAtField, { label: "Summarize at", destination, value, placeholder: "Default", onSave })));
	});
	await vi.waitFor(() => expect(container.querySelector("input")).not.toBeNull());
}

async function type(text: string): Promise<void> {
	const input = container.querySelector("input")!;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	await act(async () => {
		setter.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

const button = (label: string) => [...container.querySelectorAll("button")].find(element => element.textContent === label);

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	onSave.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

it("saves a typed token count and offers Use default once a point is set", async () => {
	await render(null);
	expect(button("Use default")).toBeUndefined();
	await type("400k");
	await act(async () => button("Save")!.click());
	expect(onSave).toHaveBeenCalledWith(400_000);
	await render(400_000);
	expect(container.querySelector("input")!.value).toBe("400k");
	await act(async () => button("Use default")!.click());
	expect(onSave).toHaveBeenLastCalledWith(null);
});

it("refuses percentages and fixed triggers, which belong to per-model limits", async () => {
	await render(null);
	for (const text of ["80%", "f400k", "lots"]) {
		await type(text);
		expect(button("Save")!.disabled).toBe(true);
		expect(container.textContent).toContain("Enter a token count, such as 400k or 600000.");
	}
	await type("600000");
	expect(button("Save")!.disabled).toBe(false);
});

it("drops an unsaved draft when the field moves to another chat or settings scope", async () => {
	await render(400_000, "chat-a");
	await type("600k");
	// Same chat, new value from omp: the edit stays.
	await render(300_000, "chat-a");
	expect(container.querySelector("input")!.value).toBe("600k");
	// Another chat: its own saved point replaces the draft, so Save cannot send the old draft there.
	await render(null, "chat-b");
	expect(container.querySelector("input")!.value).toBe("");
	expect(button("Save")!.disabled).toBe(true);
});
