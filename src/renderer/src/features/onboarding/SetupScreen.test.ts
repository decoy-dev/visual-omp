// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OmpStatus } from "@shared/ipc";
import { useApp } from "../../state/app";
import { SetupScreen } from "./SetupScreen";
import type { ButtonProps } from "../../ui/Button";
import "../../i18n";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), start: vi.fn(), kill: vi.fn(), ready: vi.fn(), listener: null as { exit(code: number): void } | null }));
vi.mock("../../state/app", async () => {
	// The mock factory is hoisted ahead of static imports.
	const { create } = await import("zustand");
	return { useApp: create(() => ({ omp: null })) };
});
vi.mock("./terminal", () => ({ CommandRun: { start: fake.start } }));
vi.mock("./InlineTerminal", () => ({ InlineTerminal: () => createElement("div", null, "Mock installer output") }));
vi.mock("./HelpPage", () => ({ HelpView: () => null }));
vi.mock("./updates", () => ({ OmpUpdateSheet: ({ close }: { close(): void }) => createElement("button", { onClick: close }, "Close update") }));
vi.mock("../../ui", () => ({
	Button: ({ children, onClick, disabled, loading, ref }: ButtonProps) => createElement("button", { ref, onClick, disabled: disabled || loading }, children),
	cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
	Expand: ({ children, open }: PropsWithChildren<{ open: boolean }>) => open ? children : null,
	PresenceSwap: ({ children }: PropsWithChildren) => createElement("div", null, children),
	toast: vi.fn(),
}));

const missing: OmpStatus = { found: false, supported: false, path: null, version: null, problem: null, refused: false, minVersion: "18.14.0", installCommand: "mock-installer" };
const ready: OmpStatus = { ...missing, found: true, supported: true, path: "/mock/omp", version: "18.14.0" };
let element: HTMLDivElement;
let root: Root;
const button = (name: string) => [...element.querySelectorAll("button")].find(node => node.textContent === name)!;
const render = async () => { await act(async () => root.render(createElement(SetupScreen, { onReady: fake.ready }))); };

beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.invoke.mockReset(); fake.start.mockReset(); fake.kill.mockReset(); fake.ready.mockReset(); fake.listener = null;
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "app:info") return { homeDir: "/mock" };
		if (channel === "omp:status") return ready;
		if (channel === "updates:omp:check") return { managedBy: null };
	});
	fake.start.mockResolvedValue({ attach: (listener: { exit(code: number): void }) => { fake.listener = listener; return () => {}; }, kill: fake.kill });
	Object.assign(window, { vomp: { platform: "darwin", invoke: fake.invoke } });
	useApp.setState({ omp: missing });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.useRealTimers(); });

it("starts the existing installer from Enter and automatically rechecks and advances after success", async () => {
	await render();
	await act(async () => element.querySelector("h1")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
	expect(fake.start).toHaveBeenCalledWith({ command: "mock-installer", cwd: "/mock", cols: 80, rows: 12 });
	await act(async () => fake.listener!.exit(0));
	expect(fake.invoke).toHaveBeenCalledWith("omp:status", true);
	expect(element.querySelector("h1")?.textContent).toBe("omp is ready");
	expect(fake.ready).not.toHaveBeenCalled();
	await act(async () => vi.advanceTimersByTime(600));
	expect(useApp.getState().omp).toEqual(ready);
	expect(fake.ready).toHaveBeenCalledOnce();
});

it("stops a running installer when setup closes", async () => {
	await render(); await act(async () => button("Run installer").click());
	await act(async () => root.unmount()); root = createRoot(element);
	expect(fake.kill).toHaveBeenCalledOnce();
});

it("keeps Windows refusal checks available and retains failed status", async () => {
	const refused = { ...missing, refused: true, path: "C:\\omp\\omp.exe", problem: "Windows refused to start omp." };
	useApp.setState({ omp: refused }); fake.invoke.mockResolvedValueOnce(refused);
	await render();
	expect(button("Check for omp").disabled).toBe(false);
	await act(async () => button("Check for omp").click());
	expect(element.textContent).toContain("Windows still didn't start omp");
	expect(fake.ready).not.toHaveBeenCalled();
});

it("reuses the existing update dialog for an unsupported omp", async () => {
	useApp.setState({ omp: { ...ready, supported: false, version: "18.0.0" } });
	await render(); await act(async () => button("Update omp").click());
	expect(button("Close update")).toBeDefined();
	await act(async () => button("Close update").click());
	expect(fake.invoke).toHaveBeenCalledWith("updates:omp:check", true);
	expect(fake.invoke).toHaveBeenCalledWith("omp:status", true);
	expect(fake.start).not.toHaveBeenCalled();
});

it("shows an installer startup error without leaving the step", async () => {
	fake.start.mockRejectedValueOnce(new Error("Shell unavailable"));
	await render(); await act(async () => button("Run installer").click());
	expect(element.querySelector('[role="alert"]')?.textContent).toContain("Shell unavailable");
	expect(fake.ready).not.toHaveBeenCalled();
});

it("retains a nonzero installer exit and offers a retry without advancing", async () => {
	await render(); await act(async () => button("Run installer").click());
	await act(async () => fake.listener!.exit(9));
	expect(element.textContent).toContain("The installer stopped with an error (code 9)");
	expect(button("Run installer").disabled).toBe(false);
	expect(fake.invoke.mock.calls.some(call => call[0] === "omp:status")).toBe(false);
	expect(fake.ready).not.toHaveBeenCalled();
});

it("keeps setup open when the installer succeeds but omp is still unavailable", async () => {
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "app:info") return { homeDir: "/mock" };
		if (channel === "omp:status") return missing;
	});
	await render(); await act(async () => button("Run installer").click());
	await act(async () => fake.listener!.exit(0));
	expect(element.textContent).toContain("add its folder to PATH");
	expect(button("Check for omp").disabled).toBe(false);
	await act(async () => vi.advanceTimersByTime(1000));
	expect(fake.ready).not.toHaveBeenCalled();
	expect(useApp.getState().omp).toEqual(missing);
});

it("kills a pending installer run that resolves after setup has unmounted", async () => {
	const run = { attach: vi.fn(() => () => {}), kill: fake.kill };
	const pending = Promise.withResolvers<typeof run>();
	fake.start.mockReturnValueOnce(pending.promise);
	await render(); await act(async () => button("Run installer").click());
	await act(async () => root.unmount()); root = createRoot(element);
	await act(async () => pending.resolve(run));
	expect(fake.kill).toHaveBeenCalledOnce();
	expect(run.attach).not.toHaveBeenCalled();
	expect(fake.ready).not.toHaveBeenCalled();
});
