// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellVizPresentation, TspShellProps } from "@shared/tsp/shell";
import type { NodeContext } from "../tsp/nodes/context";
import { NodeView } from "../tsp/nodes/NodeView";
import "../../i18n";
import { ShellView } from "./ShellView";
import { TooltipProvider } from "../../ui/Tooltip";

function fixture(): ShellVizPresentation {
	return {
		preferences: { view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] },
		rows: [
			{ id: "assignment", node: "0:0:1", depth: 0, state: "ok", range: [0, 11], segments: [{ text: "name = 'Ada'", node: "0:0:1", style: "var" }], effects: [], annotations: [{ name: "name", value: "Ada", scope: "global", fullLength: 30 }] },
			{ id: "pipeline", node: "0:0:2", depth: 1, state: "ok", segments: [{ text: "false", node: "0:0:3", state: "fail", tip: "Exit code 1" }, { text: " | true", node: "0:0:4", state: "ok" }], effects: [{ kind: "write", glyph: "W", label: "Writes a file", why: "The command redirects output to a file." }], detail: "The pipeline completed successfully." },
			{ id: "skipped", node: "0:0:5", depth: 1, state: "skipped", segments: [{ text: "unreached()" }], effects: [] },
		],
		original: [{ id: "raw", node: "0:0:1", depth: 0, state: "ok", segments: [{ text: "name='Ada'" }], effects: [] }],
		output: "Complete ordinary output\n", watches: [], executing: false,
		timeline: { length: 3, cursor: 3, elapsedNs: 30_000_000, durationNs: 30_000_000 },
	};
}
let root: Root;
let element: HTMLDivElement;
let presentation: ShellVizPresentation;
const onAction = vi.fn();
const writeText = vi.fn().mockResolvedValue(undefined);
async function render(options: Partial<ComponentProps<typeof ShellView>> = {}) {
	await act(async () => root.render(createElement(TooltipProvider, { children: createElement(ShellView, { props: { presentation }, onAction, ...options }) })));
}
async function click(label: string, scope: ParentNode = element) {
	const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === label);
	expect(button, `Button ${label}`).toBeDefined();
	await act(async () => button!.click());
}
async function menu() {
	const trigger = [...element.querySelectorAll("button")].find(button => button.textContent === "Display options")!;
	await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
}
beforeEach(async () => {
	await i18next.loadNamespaces("shellVisualization");
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
	presentation = fixture(); onAction.mockClear(); writeText.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("canonical shell presentation", () => {
	it.each([["/", undefined, "$ cd / &&"], ["/work/two words", ";", "$ cd /work/two words;"]] as const)("retains the reported execution folder %s and separator above canonical rows", async (cwd, cdSeparator, prefix) => {
		const command = `cd ${cwd}${cdSeparator ?? " &&"} printf fixture`;
		await render({ props: { presentation, cwd }, context: { cwd: "/original", cdSeparator }, command });
		expect(element.querySelector("[data-shell-context]")?.textContent).toBe(prefix);
		expect(element.querySelector("[data-shell-context]")!.compareDocumentPosition(element.querySelector(".shell-panes")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		await click("Copy command");
		expect(writeText).toHaveBeenCalledWith(command);
	});

	it("does not invent a leading cd when neither the result nor arguments report a folder", async () => {
		await render();
		expect(element.querySelector("[data-shell-context]")).toBeNull();
	});

	it("keeps Raw/Pseudo controlled by omp and sends only canonical view actions", async () => {
		await render();
		expect(onAction).not.toHaveBeenCalled();
		expect(element.textContent).not.toContain("Pseudo is a display translation.");
		expect(element.querySelector('button[aria-label="About Pseudo"]')).not.toBeNull();
		await click("Raw");
		expect(onAction).toHaveBeenLastCalledWith("view:raw");
		expect(element.querySelector('[aria-label="Command presentation"] [data-state="on"]')?.textContent).toBe("Pseudo");
		presentation = { ...presentation, preferences: { ...presentation.preferences, view: "raw" } };
		await render(); await click("Pseudo");
		expect(onAction).toHaveBeenLastCalledWith("view:pseudo");
	});

	it("exposes every layer and split using canonical checked preferences", async () => {
		await render(); await menu();
		for (const [label, action] of [["Color", "layer:color"], ["Inline values", "layer:inline"], ["Idioms", "layer:idioms"], ["Effects", "layer:effects"], ["Unwrap", "layer:unwrap"], ["Original/Pseudo split", "split"]]) {
			const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(item => item.textContent === label)!;
			expect(item).toBeDefined();
			expect(item.getAttribute("aria-checked")).toBe(label === "Original/Pseudo split" ? "false" : "true");
			await act(async () => item.click());
			expect(onAction).toHaveBeenLastCalledWith(action);
		}
	});

	it("renders labelled original and pseudo panes and disables split in Raw", async () => {
		presentation.preferences.split = true;
		await render();
		expect(element.querySelector('[aria-label="Original command rows"]')?.textContent).toContain("name='Ada'");
		expect(element.querySelector('[aria-label="Pseudo command rows"]')?.textContent).toContain("name = 'Ada'");
		presentation = { ...presentation, preferences: { ...presentation.preferences, view: "raw" } };
		await render(); await menu();
		const split = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(item => item.textContent === "Original/Pseudo split")!;
		expect(split.getAttribute("aria-disabled")).toBe("true");
		expect(document.body.textContent).toContain("Split is available in Pseudo.");
	});

	it("shows observed setters, skipped rows and leaf failures within a successful row", async () => {
		await render();
		const assignment = element.querySelector('[data-shell-row="assignment"]')!;
		expect(assignment.textContent).toContain("name = Ada (global)");
		expect(assignment.textContent).toContain("Retained value; original length 30 bytes");
		const pipeline = element.querySelector('[data-shell-row="pipeline"]')!;
		expect(pipeline.textContent).toContain("Done");
		expect(pipeline.textContent).toContain("Failed: false");
		expect(element.querySelector('[data-shell-row="skipped"]')?.textContent).toContain("Skipped");
		expect(element.querySelector('[data-shell-row="skipped"]')?.textContent).not.toContain("Done");
	});

	it("marks each failed execution once even when several source segments carry its state", async () => {
		presentation.rows[1]!.segments.push({ text: " argument", state: "fail", executionNode: "0:0:3" });
		await render();
		expect(element.querySelector('[data-shell-row="pipeline"]')?.querySelectorAll(".shell-segment-failure")).toHaveLength(1);
	});

	it("allows local detail inspection in a read-only view without owning-host actions", async () => {
		await render({ disabled: true });
		await act(async () => element.querySelector<HTMLElement>('[data-shell-row="pipeline"]')!.click());
		expect(element.querySelector("details[open]")?.textContent).toContain("The pipeline completed successfully.");
		expect(onAction).not.toHaveBeenCalled();
	});

	it("does not quote an unrelated caller-source slice when omp used a shell prefix", async () => {
		presentation.preferences.selectedNode = "0:0:1";
		presentation.rows[0]!.detail = "unset -v FIXTURE\\nprintf fixture";
		await render({ command: "VALUE='a different caller source'" });
		const details = element.querySelector("details[open]")!;
		expect(details.textContent).toContain("unset -v FIXTURE");
		expect(details.textContent).not.toContain("Original source");
	});

	it("selects opaque node keys and exposes engine details and expansion to the keyboard", async () => {
		await render({ command: "name='Ada'\nfalse | true" });
		const row = element.querySelector<HTMLElement>('[data-shell-row="pipeline"]')!;
		await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(onAction).toHaveBeenLastCalledWith("select:0:0:2");
		presentation = { ...presentation, preferences: { ...presentation.preferences, selectedNode: "0:0:2" } };
		await render();
		expect(element.querySelector("details[open]")?.textContent).toContain("The pipeline completed successfully.");
		expect(element.querySelector("details[open]")?.textContent).toContain("The command redirects output to a file.");
		expect(element.querySelector("details[open]")?.textContent).toContain("Exit code 1");
		await click("Expand command"); expect(onAction).toHaveBeenLastCalledWith("expand:0:0:2");
		const first = element.querySelector<HTMLElement>('[data-shell-row="assignment"]')!;
		await act(async () => { first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
		expect(document.activeElement?.getAttribute("data-shell-row")).toBe("pipeline");
		expect(element.querySelectorAll('[data-shell-row][tabindex="0"]')).toHaveLength(1);
	});

	it("reaches every distinct command within one row without token Tab stops", async () => {
		await render();
		const row = element.querySelector<HTMLElement>('[data-shell-row="pipeline"]')!;
		await act(async () => { row.focus(); row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
		expect(row.getAttribute("aria-label")).toContain("Command 2 of 3: false");
		await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(onAction).toHaveBeenLastCalledWith("select:0:0:3");
		await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
		await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(onAction).toHaveBeenLastCalledWith("select:0:0:4");
		expect(row.querySelectorAll("[tabindex]")).toHaveLength(0);
		expect(element.querySelectorAll('[data-shell-row][tabindex="0"]')).toHaveLength(1);
	});

	it("preserves text dragging without selecting a native command", async () => {
		await render();
		const row = element.querySelector<HTMLElement>('[data-shell-row="pipeline"]')!;
		const range = document.createRange(); range.selectNodeContents(row.querySelector("code")!);
		window.getSelection()!.addRange(range);
		await act(async () => row.querySelector<HTMLElement>("code span")!.click());
		expect(onAction).not.toHaveBeenCalled();
		window.getSelection()!.removeAllRanges();
		await act(async () => row.querySelector<HTMLElement>("code span")!.click());
		expect(onAction).toHaveBeenLastCalledWith("select:0:0:3");
	});

	it("quotes original source once and retains additional native details", async () => {
		const command = "name='Ada'";
		presentation.preferences.selectedNode = "0:0:1";
		presentation.rows[0]!.range = [0, command.length];
		presentation.rows[0]!.detail = command;
		await render({ command });
		expect(element.querySelector("details[open]")?.textContent).toContain("Original source");
		expect(element.querySelector("details[open]")?.textContent).not.toContain("Command details");
		presentation = { ...presentation, rows: [{ ...presentation.rows[0]!, detail: command + "\nExit code 0" }, ...presentation.rows.slice(1)] };
		await render({ command });
		const details = element.querySelector("details[open]")!;
		expect(details.textContent?.split(command)).toHaveLength(2);
		expect(details.textContent).toContain("Command detailsExit code 0");
	});

	it("copies the exact supplied source and never reconstructs it from Pseudo", async () => {
		const source = "  name='Ada'\r\nprintf '%s\\n' \"$name\"\n";
		await render({ command: source }); await click("Copy command");
		expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
		expect(element.textContent).toContain("Command copied.");
		await render();
		const copy = [...element.querySelectorAll("button")].find(button => button.textContent === "Copy command")!;
		expect(copy.disabled).toBe(true); await act(async () => copy.click());
		expect(writeText).toHaveBeenCalledTimes(1);
	});

	it("pages command rows and details without exceeding their mounted entry budgets", async () => {
		presentation.rows = Array.from({ length: 401 }, (_, index) => ({ id: `r-${index}`, node: `0:0:${index}`, depth: 0, segments: [{ text: `row ${index}` }], effects: [] }));
		presentation.rows[0]!.annotations = Array.from({ length: 101 }, (_, index) => ({ name: `v${index}`, value: `${index}` }));
		presentation.preferences.selectedNode = "0:0:0";
		await render();
		expect(element.querySelectorAll("[data-shell-row]")).toHaveLength(12);
		await click("Show more command rows");
		expect(element.querySelectorAll("[data-shell-row]")).toHaveLength(200);
		expect(element.querySelectorAll(".shell-details dl > div")).toHaveLength(50);
		await click("Next command rows");
		expect(element.querySelectorAll("[data-shell-row]")).toHaveLength(200);
		expect(element.querySelector('[data-shell-row="r-200"]')).not.toBeNull();
		expect(element.querySelector('[data-shell-row="r-0"]')).toBeNull();
		await click("Next details");
		expect(element.querySelectorAll(".shell-details dl > div")).toHaveLength(50);
		expect(element.querySelector(".shell-details dl")?.textContent).toContain("v50");
	});

	it("keeps split pagination at 200 mounted rows across both panes", async () => {
		presentation.preferences.split = true;
		presentation.rows = Array.from({ length: 201 }, (_, index) => ({ id: `pseudo-${index}`, depth: 0, segments: [{ text: `pseudo ${index}` }], effects: [] }));
		presentation.original = Array.from({ length: 201 }, (_, index) => ({ id: `raw-${index}`, depth: 0, segments: [{ text: `raw ${index}` }], effects: [] }));
		await render();
		await click("Show more command rows");
		expect(element.querySelectorAll("[data-shell-row]")).toHaveLength(200);
		await click("Next command rows");
		expect(element.querySelectorAll("[data-shell-row]")).toHaveLength(200);
		await click("Next command rows");
		expect(element.querySelectorAll("[data-shell-row]")).toHaveLength(2);
		await click("Previous command rows");
		expect(element.querySelectorAll("[data-shell-row]")).toHaveLength(200);
	});

	it("bounds initial output and allows reading the complete retained output", async () => {
		presentation.output = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
		await render();
		expect(element.querySelector(".shell-output pre")?.textContent).not.toContain("line 39");
		await click("Show 20 more lines");
		expect(element.querySelector(".shell-output pre")?.textContent).toContain("line 39");
	});
	it("keeps unlocated setter values inspectable without inventing a native selection key", async () => {
		const value = "observed ".repeat(80);
		presentation.rows = [{ id: "variable-setters-unlocated", depth: 0, role: "document", segments: [{ text: "Observed setters, source location unavailable" }], effects: [], annotations: [{ name: "dynamic", value }] }];
		await render();
		const row = element.querySelector<HTMLElement>("[data-shell-row]")!;
		await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(onAction).not.toHaveBeenCalled();
		expect(element.querySelector("details[open]")?.textContent).toContain("dynamic");
		await click("Show retained value");
		expect(element.querySelector("details[open]")?.textContent).toContain(value);
	});
});

describe("explicit replay", () => {
	it("never starts playback on mount or disclosure and sends bounded replay actions", async () => {
		await render({ showOutput: false });
		expect(element.querySelector('[aria-label="Replay controls"]')).toBeNull();
		expect(onAction).not.toHaveBeenCalled();
		await click("Replay"); expect(onAction).not.toHaveBeenCalled();
		expect(element.querySelector('input[type="range"]')?.getAttribute("aria-valuetext")).toContain("Event 3 of 3");
		await click("Previous event"); expect(onAction).toHaveBeenLastCalledWith("seek:2");
		await click("Reset"); expect(onAction).toHaveBeenLastCalledWith("reset");
		await click("Play"); expect(onAction).toHaveBeenLastCalledWith("play");
		await click("2x"); expect(onAction).toHaveBeenLastCalledWith("speed:2");
		presentation = { ...presentation, preferences: { ...presentation.preferences, playing: true, cursor: 1 }, timeline: { ...presentation.timeline, cursor: 1 } };
		await render({ showOutput: false });
		await click("Pause"); expect(onAction).toHaveBeenLastCalledWith("pause");
		await click("Next event"); expect(onAction).toHaveBeenLastCalledWith("step");
		await click("Latest"); expect(onAction).toHaveBeenLastCalledWith("live");
	});

	it("seeks through the labelled native range without inventing a completed tool state", async () => {
		presentation.preferences.cursor = 1; presentation.timeline.cursor = 1;
		presentation.rows[0].state = "pending";
		await render({ props: { presentation, inspector: true } });
		const slider = element.querySelector<HTMLInputElement>('input[type="range"]')!;
		vi.useFakeTimers();
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "2");
			slider.dispatchEvent(new Event("input", { bubbles: true }));
			slider.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => { vi.advanceTimersByTime(80); });
		expect(onAction).toHaveBeenLastCalledWith("seek:2");
		expect(element.querySelector('[data-shell-row="assignment"]')?.textContent).toContain("Pending");
		expect(element.textContent).toContain("Viewing replay");
		expect(element.textContent).not.toContain("Command finished");
	});

	it("only adds retained replay output while held and switches locally to ordinary output", async () => {
		await render({ showOutput: false });
		expect(element.querySelector(".shell-output")).toBeNull();
		await click("Replay");
		presentation = { ...presentation, output: "Retained earlier output", preferences: { ...presentation.preferences, cursor: 1 }, timeline: { ...presentation.timeline, cursor: 1 } };
		await render({ showOutput: false });
		expect(element.querySelector('[aria-label="Replay output"]')?.textContent).toContain("Retained earlier output");
		const actions = onAction.mock.calls.length;
		await click("Original output");
		expect(onAction).toHaveBeenCalledTimes(actions);
		expect(element.querySelector(".shell-output")).toBeNull();
		expect(element.textContent).toContain("The command's ordinary output remains below.");
		expect(element.querySelector('[aria-label="Output scope"]')).toBeNull();
		await click("Close replay");
		expect(onAction.mock.calls.slice(-2)).toEqual([["pause"], ["live"]]);
		expect(document.activeElement?.textContent).toBe("Replay");
	});

	it("explains trimmed and empty history without offering playback for an empty trace", async () => {
		presentation.timeline = { length: 0, cursor: 0, elapsedNs: 0, durationNs: 0, trimmed: true };
		await render({ props: { presentation, inspector: true } });
		expect(element.textContent).toContain("Earlier replay events were omitted. Only retained history is available.");
		expect(element.textContent).toContain("Replay is unavailable for this trace.");
		expect(element.querySelector('input[type="range"]')).toBeNull();
		expect([...element.querySelectorAll("button")].some(button => button.textContent === "Play")).toBe(false);
		expect(onAction).not.toHaveBeenCalled();
	});

	it("pauses on document hiding and card disposal without starting a timer", async () => {
		await render({ props: { presentation, inspector: true } });
		expect(onAction).not.toHaveBeenCalled();
		vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		expect(onAction).toHaveBeenLastCalledWith("pause");
		onAction.mockClear();
		await act(async () => root.render(null));
		expect(onAction).toHaveBeenCalledExactlyOnceWith("pause");
	});
	it("does not pause on ordinary frames when the parent callback identity changes", async () => {
		const nextAction = vi.fn();
		await render({ props: { presentation, inspector: true } });
		presentation = { ...presentation, output: "An ordinary output update" };
		await render({ props: { presentation, inspector: true }, onAction: nextAction });
		expect(onAction).not.toHaveBeenCalled(); expect(nextAction).not.toHaveBeenCalled();
		await act(async () => root.render(null));
		expect(onAction).not.toHaveBeenCalled();
		expect(nextAction).toHaveBeenCalledExactlyOnceWith("pause");
	});
	it("announces only acknowledged explicit replay navigation", async () => {
		await render({ props: { presentation, inspector: true } });
		const live = () => element.querySelector('[aria-live="polite"]')!.textContent;
		expect(live()).toBe("");
		await click("Previous event");
		expect(live()).toBe("");
		presentation = { ...presentation, preferences: { ...presentation.preferences, cursor: 2 }, timeline: { ...presentation.timeline, cursor: 2 } };
		await render({ props: { presentation, inspector: true } });
		expect(live()).toContain("Event 2 of 3");
		const acknowledged = live();
		presentation = { ...presentation, preferences: { ...presentation.preferences, playing: true, cursor: 3 }, timeline: { ...presentation.timeline, cursor: 3 } };
		await render({ props: { presentation, inspector: true } });
		expect(live()).toBe(acknowledged);
		await click("Latest");
		presentation = { ...presentation, preferences: { ...presentation.preferences, playing: false, cursor: undefined } };
		await render({ props: { presentation, inspector: true } });
		expect(live()).toContain("(Latest)");
	});

	it("coalesces slider input and cancels queued seeks when replay closes", async () => {
		await render(); await click("Replay");
		vi.useFakeTimers();
		const slider = element.querySelector<HTMLInputElement>('input[type="range"]')!;
		for (const value of ["0", "1", "2"]) await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, value);
			slider.dispatchEvent(new Event("input", { bubbles: true }));
			slider.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onAction).not.toHaveBeenCalled();
		expect(slider.value).toBe("2");
		await act(async () => { vi.advanceTimersByTime(80); });
		expect(onAction).toHaveBeenCalledExactlyOnceWith("seek:2");
		expect(element.querySelector('[aria-live="polite"]')?.textContent).toBe("");
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1");
			slider.dispatchEvent(new Event("input", { bubbles: true }));
			slider.dispatchEvent(new Event("change", { bubbles: true }));
		});
		onAction.mockClear();
		await click("Close replay");
		await act(async () => { vi.advanceTimersByTime(80); });
		expect(onAction.mock.calls).toEqual([["pause"], ["live"]]);
	});

	it("flushes the latest slider position before Play without a delayed seek pausing it", async () => {
		await render({ props: { presentation, inspector: true } });
		vi.useFakeTimers();
		const slider = element.querySelector<HTMLInputElement>('input[type="range"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1");
			slider.dispatchEvent(new Event("input", { bubbles: true }));
			slider.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await click("Play");
		expect(onAction.mock.calls).toEqual([["seek:1"], ["play"]]);
		expect(slider.value).toBe("3");
		await act(async () => { vi.advanceTimersByTime(80); });
		expect(onAction.mock.calls).toEqual([["seek:1"], ["play"]]);
	});
});

describe("generic shell consumer", () => {
	it("renders inspector controls lazily and disables every owning-host action in read-only mode", async () => {
		const send = vi.fn();
		const context: NodeContext = { sf: "surface", readOnly: true, send, keys: vi.fn(), render: () => null };
		await act(async () => root.render(createElement(TooltipProvider, { children: createElement(NodeView, { node: { id: "shell", k: "shell", p: { presentation, inspector: true } }, context }) })));
		expect(element.querySelector('[aria-label="Replay controls"]')).not.toBeNull();
		expect(element.querySelector<HTMLInputElement>('input[type="range"]')?.disabled).toBe(true);
		for (const label of ["Raw", "Play", "Reset", "Latest", "2x"]) {
			const button = [...element.querySelectorAll("button")].find(button => button.textContent === label)!;
			expect(button.disabled).toBe(true); await act(async () => button.click());
		}
		await act(async () => element.querySelector<HTMLElement>("[data-shell-row]")!.click());
		await act(async () => root.render(null));
		expect(send).not.toHaveBeenCalled();
	});

	it("dispatches canonical shell-viz actions to the actual generic shell node", async () => {
		const send = vi.fn();
		const context: NodeContext = { sf: "surface", readOnly: false, send, keys: vi.fn(), render: () => null };
		await act(async () => root.render(createElement(TooltipProvider, { children: createElement(NodeView, { node: { id: "exact-shell", k: "shell", p: { presentation } }, context }) })));
		await click("Raw");
		expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "action", sf: "surface", id: "exact-shell", act: "shell-viz", value: "view:raw" });
	});

	it("keeps malformed data readable with no controls or actions", async () => {
		const props = { presentation: { rows: [{ segments: [{ text: "Malformed" }] }] }, inspector: true } as unknown as TspShellProps;
		await render({ props, command: "original source" });
		expect(element.textContent).toContain("Shell visualization is unavailable for this data.");
		expect(element.textContent).toContain("original source");
		expect(element.querySelector("button,input")).toBeNull();
		await act(async () => root.render(null));
		expect(onAction).not.toHaveBeenCalled();
	});
	it("shows the sanitized generic shell node as an unavailable display without actions", async () => {
		const send = vi.fn();
		const context: NodeContext = { sf: "surface", readOnly: false, send, keys: vi.fn(), render: () => null };
		await act(async () => root.render(createElement(NodeView, { node: { id: "sanitized-shell", k: "shell" }, context })));
		expect(element.textContent).toContain("Shell visualization is unavailable for this data.");
		expect(element.querySelector("button,input,[data-shell-row]")).toBeNull();
		await act(async () => root.render(null));
		expect(send).not.toHaveBeenCalled();
	});
	it("refuses an oversized row before mounting controls or sending cleanup actions", async () => {
		presentation.rows[0].segments = [{ text: "x".repeat(64 * 1024 + 1) }];
		await render({ props: { presentation, inspector: true } });
		expect(element.textContent).toContain("Shell visualization is unavailable for this data.");
		expect(element.querySelector("button,input,[data-shell-row]")).toBeNull();
		await act(async () => root.render(null));
		expect(onAction).not.toHaveBeenCalled();
	});
});
