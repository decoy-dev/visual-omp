// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dialog, DialogContent } from "./Dialog";

let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it("preserves Radix's default focus order without an explicit target", async () => {
	await act(async () => root.render(createElement(Dialog, { open: true }, createElement(DialogContent, { title: "Default dialog" }, createElement("input", { "aria-label": "Value" })))));
	expect(document.activeElement).toBe(document.querySelector('[aria-label="Close"]'));
});
it("focuses an explicit field and still calls onOpenAutoFocus", async () => {
	const initialFocus = createRef<HTMLInputElement>();
	const onOpenAutoFocus = vi.fn();
	await act(async () => root.render(createElement(Dialog, { open: true }, createElement(DialogContent, { title: "Edit value", initialFocus, onOpenAutoFocus }, createElement("input", { ref: initialFocus })))));
	expect(document.activeElement).toBe(initialFocus.current);
	expect(onOpenAutoFocus).toHaveBeenCalledOnce();
});
it("lets the caller cancel or replace initial focus", async () => {
	const initialFocus = createRef<HTMLInputElement>();
	const alternate = createRef<HTMLButtonElement>();
	await act(async () => root.render(createElement(Dialog, { open: true }, createElement(DialogContent, { title: "Edit value", initialFocus, onOpenAutoFocus: event => { event.preventDefault(); alternate.current?.focus(); } }, createElement("input", { ref: initialFocus }), createElement("button", { ref: alternate }, "Other action")))));
	expect(document.activeElement).toBe(alternate.current);
});
