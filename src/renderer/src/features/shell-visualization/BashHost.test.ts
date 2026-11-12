// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bashRenderer } from "../../tool-render/tools/bash";
import type { ToolRenderHost } from "../../tool-render/types";
import "../../i18n";

let root: Root;
let element: HTMLDivElement;
const args = { command: "printf fixture", env: { FIXTURE: "two words" }, cwd: "/tmp", timeout: 10 };
const result = { content: [{ type: "text", text: "preserved output\n[raw output: artifact://fixture-output]" }], details: { exitCode: 0, wallTimeMs: 7, meta: { minimized: { filter: "fixture", inputBytes: 100, outputBytes: 50 } } } };
async function render(host?: ToolRenderHost) {
	const Body = bashRenderer.Body!;
	await act(async () => root.render(createElement(Body, { name: "bash", args, result, host })));
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it("retains the ordinary command when no native presentation capability is available", async () => {
	await render();
	expect(element.querySelector(".tv-cmd")?.textContent).toContain('FIXTURE="two words" printf fixture');
	expect(element.textContent).toContain("preserved output");
});
it("replaces only the command pane while preserving output, metadata and minimizer attribution", async () => {
	const command = vi.fn((source: string, _fallback: ReactNode, prefix: string) => createElement("div", { "data-canonical-shell": "" }, source, prefix));
	await render({ renderShellCommand: command });
	expect(command).toHaveBeenCalledOnce();
	expect(command.mock.calls[0]?.[0]).toBe(args.command);
	expect(command.mock.calls[0]?.[2]).toBe('FIXTURE="two words"');
	expect(element.querySelector("[data-canonical-shell]")).not.toBeNull();
	expect(element.querySelector(".tv-cmd")).toBeNull();
	for (const text of ["preserved output", "Folder", "Timeout 10s", "Duration 7ms", "Artifact fixture-output", "omp's fixture filter changed this output"]) expect(element.textContent).toContain(text);
});
it("keeps the complete ordinary command fallback when a host declines presentation", async () => {
	await render({ renderShellCommand: () => null });
	expect(element.querySelector(".tv-cmd")?.textContent).toContain(args.command);
	expect(element.textContent).toContain("preserved output");
});
it.each([";", undefined] as const)("passes executed context and the original source to the host (%s)", async cdSeparator => {
	const Body = bashRenderer.Body!;
	const command = `cd /${cdSeparator ?? " &&"} printf fixture`;
	const renderShellCommand = vi.fn(() => null);
	await act(async () => root.render(createElement(Body, { name: "bash", args: { ...args, command }, result: { ...result, details: { ...result.details, cwd: "/", cdSeparator } }, host: { renderShellCommand } })));
	expect(renderShellCommand).toHaveBeenCalledWith(command, expect.anything(), 'FIXTURE="two words"', { cwd: "/", cdSeparator, trace: undefined });
	expect(element.querySelector(".tv-cmd")?.textContent).toContain(command);
});
