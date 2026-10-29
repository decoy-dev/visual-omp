// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import { AdvisorEditor } from "./AdvisorSheet";
import "../../i18n";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), apply: vi.fn(), close: vi.fn() }));
vi.mock("../../state/app", () => ({ controllerFor: vi.fn() }));
vi.mock("./pickers", () => ({ ModelList: () => null }));
vi.mock("./drive", () => ({ reportFailure: vi.fn(), runAndReport: vi.fn() }));
vi.mock("./advisorApply", () => ({ applyAdvisorConfig: fake.apply }));
vi.mock("@/ui", async () => {
	const React = await import("react"); const e = React.createElement;
	const field = (tag: "input" | "textarea") => function Field({ label, description, ...props }: Record<string, unknown>) { const id = React.useId(); return e("label", null, label as string, e(tag, { ...props, id, "aria-label": label }), description as string); };
	return {
		Button: ({ children, onClick, disabled }: PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) => e("button", { disabled, onClick }, children),
		Input: field("input"), Textarea: field("textarea"), Spinner: () => null, EmptyState: () => null,
		Switch: () => null, Checkbox: () => null, Popover: () => null, PopoverTrigger: () => null, PopoverContent: () => null,
		Select: ({ children, onValueChange, ...props }: PropsWithChildren<{ onValueChange(value: string): void }>) => e("select", { ...props, onChange: (event: { currentTarget: HTMLSelectElement }) => onValueChange(event.currentTarget.value) }, children),
		SelectItem: ({ children, value }: PropsWithChildren<{ value: string }>) => e("option", { value }, children),
		Sheet: ({ children }: PropsWithChildren) => children,
		SheetContent: ({ children, footer }: PropsWithChildren<{ footer: ReactNode }>) => e("section", null, children, footer),
		Dialog: ({ children, open }: PropsWithChildren<{ open: boolean }>) => open ? e("aside", null, children) : null,
		DialogContent: ({ footer }: { footer: ReactNode }) => footer,
		toast: vi.fn(),
	};
});

let root: Root; let element: HTMLDivElement;
const file = () => ({ file: "/project/WATCHDOG.yaml", content: "original", exists: true, doc: { advisors: [{ name: "Reviewer", instructions: "original instructions" }] } });
let saved = file();
let snapshot: { mode: string; working: boolean; readOnly: boolean };
let session: SessionController;
const render = async () => { await act(async () => { root.render(createElement(AdvisorEditor, { session, close: fake.close })); }); };
const button = (name: string) => [...element.querySelectorAll("button")].find(node => node.textContent === name)!;
const change = async (node: Element, value: string) => {
	if (node.tagName === "SELECT") {
		await act(async () => { (node as HTMLSelectElement).value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
		return;
	}
	const propsKey = Object.getOwnPropertyNames(node).find(key => key.startsWith("__reactProps$"))!;
	const props = (node as unknown as Record<string, { onChange?: (event: unknown) => void }>)[propsKey]!;
	await act(async () => { props.onChange!({ currentTarget: { value } }); });
};

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.invoke.mockReset(); fake.apply.mockReset(); fake.close.mockReset(); saved = file();
	snapshot = { mode: "live", working: true, readOnly: false };
	session = { projectPath: "/project", tabId: "test", getSnapshot: () => snapshot, subscribe: () => () => undefined } as unknown as SessionController;
	fake.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
		if (channel === "advisor:read") return structuredClone(saved);
		if (channel === "advisor:save") { saved = { ...saved, content: "saved", doc: args[3] as typeof saved.doc }; return structuredClone(saved); }
	});
	fake.apply.mockImplementation(async () => structuredClone(saved));
	Object.assign(window, { vomp: { invoke: fake.invoke } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it("requires discard confirmation for Reload and keeps instructions and roster when cancelled", async () => {
	await render();
	await change(element.querySelector('textarea[aria-label="Advisor instructions"]')!, "unsaved review instructions");
	await act(async () => button("Add advisor").click());
	await act(async () => button("Reload file").click());
	expect(button("Keep editing")).toBeDefined();
	await act(async () => button("Keep editing").click());
	expect(element.querySelectorAll('select[aria-label="Advisor to edit"] option')).toHaveLength(2);
	await change(element.querySelector('select[aria-label="Advisor to edit"]')!, "0");
	expect((element.querySelector('textarea[aria-label="Advisor instructions"]') as HTMLTextAreaElement).value).toBe("unsaved review instructions");
	await act(async () => button("Reload file").click());
	await act(async () => button("Discard changes").click());
	expect(element.querySelectorAll('select[aria-label="Advisor to edit"] option')).toHaveLength(1);
});

it("retains pending application after saving while busy, reopening and switching scope", async () => {
	await render();
	await change(element.querySelector('textarea[aria-label="Advisor instructions"]')!, "saved while busy");
	await act(async () => button("Save configuration").click());
	expect(button("Apply saved configuration")).toBeDefined();
	await act(async () => root.unmount()); root = createRoot(element);
	snapshot = { ...snapshot, working: false };
	await render();
	expect(button("Apply saved configuration").disabled).toBe(false);
	await change(element.querySelector('select[aria-label="Configuration scope"]')!, "user");
	expect(button("Apply saved configuration")).toBeUndefined();
	await change(element.querySelector('select[aria-label="Configuration scope"]')!, "project");
	expect(button("Apply saved configuration").disabled).toBe(false);
	await act(async () => button("Apply saved configuration").click());
	expect(fake.apply).toHaveBeenCalledOnce();
	expect(button("Apply saved configuration")).toBeUndefined();
});
