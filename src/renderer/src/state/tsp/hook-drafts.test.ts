// @vitest-environment happy-dom
import { act, createElement, type ChangeEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HookDialog } from "@shared/tsp/dialogs";
import { clearHookDraft, hookDraftKey, useHookDraft } from "./hook-drafts";

const scope = { hostId: "draft-host", generation: 1, epoch: 1 };
const dialog: HookDialog = { node: { id: "hook", k: "overlay", p: { role: "omp.overlay.hook-editor" } }, title: "Question", detail: [], body: { kind: "editor", target: "field", value: "Initial answer", readonly: false } };
const original = hookDraftKey(scope, "surface", dialog)!;
let root: Root;
let element: HTMLDivElement;
function Field({ identity, observed = "Initial answer" }: { identity: string; observed?: string }) {
	const [text, setText] = useHookDraft(identity, observed);
	return createElement("textarea", { value: text, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value) });
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	clearHookDraft(original);
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); clearHookDraft(original); element.remove(); });
async function fill(text: string) {
	const field = element.querySelector("textarea")!;
	await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
it.each([
	hookDraftKey({ ...scope, hostId: "another-host" }, "surface", dialog),
	hookDraftKey({ ...scope, generation: 2 }, "surface", dialog),
	hookDraftKey({ ...scope, epoch: 2 }, "surface", dialog),
	hookDraftKey(scope, "another-surface", dialog),
	hookDraftKey(scope, "surface", { ...dialog, node: { ...dialog.node, id: "another-hook" } }),
	hookDraftKey(scope, "surface", { ...dialog, title: "Another question" }),
	hookDraftKey(scope, "surface", { ...dialog, body: { kind: "editor", target: "another-field", value: "Initial answer", readonly: false } }),
])("does not carry a draft into another identity %s", async identity => {
	await act(async () => root.render(createElement(Field, { identity: original })));
	await fill("Private unfinished answer");
	await act(async () => root.render(createElement(Field, { identity: identity! })));
	expect(element.querySelector("textarea")?.value).toBe("Initial answer");
	await act(async () => root.render(createElement(Field, { identity: original })));
	expect(element.querySelector("textarea")?.value).toBe("Private unfinished answer");
});
it("accepts a changed engine prefill instead of restoring an older local answer", async () => {
	await act(async () => root.render(createElement(Field, { identity: original })));
	await fill("Old unfinished answer");
	await act(async () => root.render(createElement(Field, { identity: original, observed: "Updated engine prefill" })));
	expect(element.querySelector("textarea")?.value).toBe("Updated engine prefill");
	await act(async () => root.render(createElement(Field, { identity: original })));
	expect(element.querySelector("textarea")?.value).toBe("Initial answer");
});
