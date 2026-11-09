// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as MotionModule from "motion/react";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { TspHostSnapshot } from "@shared/tsp-host";
import type { TspNode } from "@shared/tsp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../../state/session";
import { useApp } from "../../state/app";
import { PresentationVisibility, presentationClaims } from "../../state/tsp/presentation-claims";
import { OmpScreenSheet } from "../../features/tsp/OmpScreenSheet";
import { TooltipProvider } from "../../ui";
import { Transcript, type TranscriptMode } from "./Transcript";
import "../../i18n";
import { WINDOW, WINDOW_STEP } from "./window";

const data = vi.hoisted(() => {
	// Transcript dependencies read the preload platform while their modules initialize.
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
	return { snapshot: null as TspHostSnapshot | null };
});
vi.mock("../../state/tsp/useTsp", () => ({ useTsp: () => ({ snapshot: data.snapshot }) }));
vi.mock("./FileLinks", async () => {
	// Vitest hoists mock factories before static imports, so load React within this factory.
	const { createContext, createElement } = await import("react");
	return { FileRefContext: createContext(null), useFileRefs: () => null, LinkedMarkdown: ({ text }: { text: string }) => createElement("p", null, text) };
});
vi.mock("motion/react", async importOriginal => {
	const original = await importOriginal<typeof MotionModule>();
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, custom, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { ...original, AnimatePresence: ({ children }: PropsWithChildren) => children, motion: { ...original.motion, div: tag("div"), section: tag("section"), span: tag("span") }, useReducedMotionConfig: () => true };
});
const time = "2026-10-30T10:11:12.000Z";
const noNotices: never[] = [];
// Windowing counts hidden session entries too. Cross the real boundary with
// bookkeeping, then keep one visible user row without mounting 120 tooltip trees.
const laterEntries: SessionEntry[] = [
	...Array.from({ length: WINDOW + WINDOW_STEP }, (_, index): SessionEntry => ({ type: "custom_message", id: `later-${index}`, parentId: null, timestamp: time, customType: "window-padding", content: "", display: false })),
	{ type: "message", id: "latest", parentId: null, timestamp: time, message: { role: "user", content: "Latest message", timestamp: Date.parse(time) } },
];
function execution(id: string, python = false, options: Record<string, unknown> = {}): SessionEntry {
	const fields = { output: python ? "python result\n" : "shell result\n", cancelled: false, truncated: false, timestamp: Date.parse(time), exitCode: 0, ...options };
	return { type: "message", id, parentId: null, timestamp: time, message: python ? { role: "pythonExecution", code: "print(2 + 2)", ...fields } : { role: "bashExecution", command: "printf shell", ...fields } } as SessionEntry;
}
function native(id: string, python = false, status: "running" | "done" | "error" | "cancelled" = "done", output = python ? "python result\n" : "shell result\n"): TspNode {
	const prefix = python ? "eval" : "bash";
	return { id, k: "tool", p: { role: `omp.${prefix}`, name: python ? "eval" : "bash", title: python ? "Python" : "Bash", command: python ? "print(2 + 2)" : "printf shell", status, exit: status === "error" ? 9 : undefined }, c: [{ id: `${id}-run`, k: "col", p: { role: "omp.run" }, c: [
		{ id: `${id}-input`, k: "code", p: { role: python ? "omp.tool.eval.input" : "omp.tool.bash.command", text: python ? "print(2 + 2)" : "printf shell" } },
		{ id: `${id}-output`, k: "ansi", p: { role: `omp.tool.${prefix}.output`, text: output } },
	] }] };
}
function snapshot(nodes: TspNode[]): TspHostSnapshot {
	return { hostId: "runs", generation: 1, revision: 1, epoch: 2, lifecycle: "live", documentGeneration: 1, negotiated: true, failure: null, availability: { available: true, reason: null }, surfaces: [{ open: { id: "session", mode: "inline", role: "omp.session" }, documentGeneration: 1, sequence: 1, closed: false, suspended: false, focus: null, settled: [], document: { id: "session", k: "col", c: [{ id: "main", k: "col", c: nodes }] } }] };
}
let element: HTMLDivElement, root: Root;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke: vi.fn(async (channel: string) => channel === "app:info" ? { homeDir: "/home/test" } : null), on: () => () => {} } });
	data.snapshot = null;
	useApp.setState({ terminalTabId: null });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "vomp"); });
async function render(entries: SessionEntry[], { mode = "normal", live = false, visible = true, fallback = false }: { mode?: TranscriptMode; live?: boolean; visible?: boolean; fallback?: boolean } = {}) {
	// These scenarios are one conversation branch, in the same order as persisted session entries.
	entries = entries.map((entry, index) => ({ ...entry, parentId: entries[index - 1]?.id ?? null }));
	const guest = { phase: "live", header: { id: "runs" }, entries, stream: null, activeTools: new Map(), agents: [], progress: new Map(), lifecycle: new Map(), uiRequest: null, loading: null };
	const view = { mode: live ? "live" : "saved", guest: live ? guest : null, host: live ? { hostId: "runs", transport: data.snapshot ? "tsp" : "classic", generation: 1 } : null, history: live ? null : { header: { id: "runs" }, entries }, working: false } as unknown as SessionView;
	const session = { projectPath: "/repo", tabId: "runs", subscribe: () => () => {}, getSnapshot: () => view, guestClient: () => null, onEvent: () => () => {}, tspNotices: { subscribe: () => () => {}, getSnapshot: () => noNotices } } as unknown as SessionController;
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(PresentationVisibility, { visible }, createElement(Transcript, { session, view, mode })), fallback ? createElement("div", { "data-fallback": "" }, createElement(OmpScreenSheet, { hostId: "runs", generation: 1, snapshot: data.snapshot, failed: false, readOnly: false })) : null)));
}
const runRows = () => element.querySelectorAll('section[aria-label^="Your "]');

describe("user execution transcript rows", () => {
	it.each(["normal", "thinking", "verbose"] as const)("expands live classic and saved shell/Python output by default in %s", async mode => {
		for (const live of [true, false]) {
			await render([execution("shell"), execution("python", true, { cancelled: true, exitCode: 130, excludeFromContext: true })], { mode, live });
			expect(runRows()).toHaveLength(2);
			expect(element.querySelectorAll("pre code")[0]?.textContent).toBe("printf shell");
			expect(element.querySelectorAll("pre code")[1]?.textContent).toBe("print(2 + 2)");
			expect(element.textContent).toContain("YouShell");
			expect(element.textContent).toContain("Exit code 0");
			expect(element.textContent).toContain("Cancelled");
			expect(element.textContent).toContain("Not sent to the model");
			expect(element.querySelectorAll(`time[datetime="${time}"]`)).toHaveLength(2);
			for (const [index, row] of [...runRows()].entries()) {
				expect(row.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
				expect(row.querySelector(".tv-pre")?.textContent).toBe(index === 0 ? "shell result" : "python result");
			}
			expect(element.textContent).not.toContain("What should we work on");
		}
	});
	it("shows errors and truncation safely, and lets the user fold and reopen output", async () => {
		await render([execution("error", false, { exitCode: 9, output: "<script>bad()</script>", truncated: true })]);
		const row = runRows()[0]!;
		const disclosure = row.querySelector("button")!;
		expect(disclosure.getAttribute("aria-expanded")).toBe("true");
		expect(row.textContent).toContain("Exit code 9");
		expect(row.textContent).toContain("<script>bad()</script>");
		expect(row.querySelector("script")).toBeNull();
		expect(row.textContent).toContain("omp truncated this output.");
		await act(async () => disclosure.click());
		expect(disclosure.getAttribute("aria-expanded")).toBe("false");
		expect(row.querySelector(".tv-pre")).toBeNull();
		await render([execution("error", false, { exitCode: 9, output: "<script>bad()</script>", truncated: true })], { mode: "verbose" });
		expect(disclosure.getAttribute("aria-expanded")).toBe("false");
		await act(async () => disclosure.click());
		expect(row.querySelector(".tv-pre")?.textContent).toBe("<script>bad()</script>");
	});
	it.each(["normal", "thinking", "verbose"] as const)("expands deferred native shell/Python output by default in %s", async mode => {
		data.snapshot = snapshot([native("shell", false, "running"), native("python", true)]);
		await render([], { live: true, mode });
		expect(runRows()).toHaveLength(2);
		for (const [index, row] of [...runRows()].entries()) {
			expect(row.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
			expect(row.querySelector(".tv-pre")?.textContent).toBe(index === 0 ? "shell result" : "python result");
		}
	});
	it.each(["normal", "thinking", "verbose"] as const)("bounds long shell/Python output and reveals all lines in %s, live and saved", async mode => {
		const output = Array.from({ length: 25 }, (_, index) => `result ${index + 1}`).join("\n");
		for (const source of ["classic", "native", "saved"] as const) {
			await act(async () => root.render(null));
			data.snapshot = source === "native" ? snapshot([native("shell", false, "running", output), native("python", true, "done", output)]) : null;
			await render(source === "native" ? [] : [execution("shell", false, { output }), execution("python", true, { output })], { mode, live: source !== "saved" });
			for (const row of runRows()) {
				expect(row.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
				expect(row.querySelector(".tv-pre")?.textContent).toBe(output.split("\n").slice(0, 20).join("\n"));
				const more = row.querySelector<HTMLButtonElement>(".tv-expand")!;
				expect(more.textContent).toBe("Show 5 more lines");
				await act(async () => more.click());
				expect(row.querySelector(".tv-pre")?.textContent).toBe(output);
				expect(more.textContent).toBe("Collapse output");
				await act(async () => more.click());
				expect(row.querySelector(".tv-pre")?.textContent).not.toContain("result 21");
				await act(async () => row.querySelector("button")!.click());
				expect(row.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
				expect(row.querySelector(".tv-pre")).toBeNull();
			}
		}
	});
	it.each(["normal", "thinking", "verbose"] as const)("shows empty shell/Python output immediately in %s, live and saved", async mode => {
		for (const source of ["classic", "native", "saved"] as const) {
			await act(async () => root.render(null));
			data.snapshot = source === "native" ? snapshot([native("shell", false, "done", ""), native("python", true, "done", "")]) : null;
			await render(source === "native" ? [] : [execution("shell", false, { output: "" }), execution("python", true, { output: "" })], { mode, live: source !== "saved" });
			for (const row of runRows()) {
				expect(row.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
				expect(row.textContent).toContain("No output.");
				expect(row.querySelector(".tv-expand")).toBeNull();
			}
		}
	});
	it("retains native execution details beside the bounded output", async () => {
		const run = native("shell");
		data.snapshot = snapshot([{ ...run, c: [...run.c!, { id: "duration", k: "text", p: { text: "Finished in 2 seconds" } }] }]);
		await render([], { live: true });
		expect(runRows()[0]!.textContent).toContain("Finished in 2 seconds");
	});
	it("shows deferred nativeTail results before another prompt and replaces them once with saved entries", async () => {
		data.snapshot = snapshot([native("shell"), native("python", true)]);
		await render([], { live: true, mode: "verbose", fallback: true });
		expect(runRows()).toHaveLength(2);
		expect(element.textContent).toContain("shell result");
		expect(element.textContent).toContain("python result");
		expect(element.querySelectorAll("pre code")).toHaveLength(2);
		expect(presentationClaims.getSnapshot()).toHaveLength(2);
		expect(element.querySelector("[data-fallback]")?.textContent).not.toContain("shell result");
		await render([execution("saved-shell"), execution("saved-python", true)], { live: true, mode: "verbose", fallback: true });
		expect(runRows()).toHaveLength(2);
		expect(element.querySelectorAll(`time[datetime="${time}"]`)).toHaveLength(2);
		expect(presentationClaims.getSnapshot()).toHaveLength(2);
		expect(element.textContent?.match(/shell result/g)).toHaveLength(1);
		expect(element.textContent?.match(/python result/g)).toHaveLength(1);
	});
	it("replaces a previously observed running frame when collab delivers its result before the final native paint", async () => {
		data.snapshot = snapshot([native("run", false, "running")]);
		await render([], { live: true });
		expect(runRows()).toHaveLength(1);
		expect(element.textContent).toContain("Running");
		await render([execution("delivered")], { live: true });
		expect(runRows()).toHaveLength(1);
		expect(element.textContent).toContain("Exit code 0");
		expect(element.textContent).not.toContain("Running");
		// An unrelated document revision must retain the replacement.
		data.snapshot = { ...data.snapshot!, revision: 2 };
		await render([execution("delivered")], { live: true });
		expect(runRows()).toHaveLength(1);
		expect(presentationClaims.getSnapshot()).toHaveLength(1);
	});
	it("keeps repeated commands as separate occurrences and never hides a new running copy", async () => {
		data.snapshot = snapshot([native("first"), native("second"), native("third", false, "running")]);
		await render([execution("saved-first")], { live: true });
		expect(runRows()).toHaveLength(4);
		expect(element.textContent).toContain("Running");
	});
	it("keeps an identical new execution visible until its own saved entry arrives", async () => {
		const history = execution("earlier");
		data.snapshot = snapshot([native("new-run", false, "running")]);
		await render([history], { live: true, mode: "verbose" });
		expect(runRows()).toHaveLength(2);
		expect(element.querySelectorAll(`time[datetime="${time}"]`)).toHaveLength(1);
		data.snapshot = snapshot([native("new-run")]);
		await render([history], { live: true, mode: "verbose" });
		expect(runRows()).toHaveLength(2);
		expect(element.textContent?.match(/shell result/g)).toHaveLength(2);
		expect(element.querySelectorAll(`time[datetime="${time}"]`)).toHaveLength(1);
		await render([history, execution("new-result")], { live: true, mode: "verbose" });
		expect(runRows()).toHaveLength(2);
		expect(element.textContent?.match(/shell result/g)).toHaveLength(2);
		expect(element.querySelectorAll(`time[datetime="${time}"]`)).toHaveLength(2);
	});
	it("preserves established assignments when native nodes reorder or disappear", async () => {
		const history = execution("established");
		data.snapshot = snapshot([native("established-node")]);
		await render([history], { live: true });
		expect(runRows()).toHaveLength(1);
		data.snapshot = snapshot([native("new-node"), native("established-node")]);
		await render([history], { live: true });
		expect(runRows()).toHaveLength(2);
		await render([history, ...laterEntries], { live: true });
		expect(element.textContent).toContain("Latest message");
		expect(runRows()).toHaveLength(1);
		expect(presentationClaims.getSnapshot().map(claim => claim.nodeId)).toEqual(["new-node"]);
		data.snapshot = snapshot([native("new-node")]);
		await render([history, ...laterEntries], { live: true });
		expect(runRows()).toHaveLength(1);
		expect(presentationClaims.getSnapshot().map(claim => claim.nodeId)).toEqual(["new-node"]);
	});
	it("releases claims when hidden, covered, unmounted, or when saved rows leave the transcript window", async () => {
		data.snapshot = snapshot([native("shell")]);
		await render([], { live: true, visible: false, fallback: true });
		expect(presentationClaims.getSnapshot()).toHaveLength(0);
		expect(element.querySelector("[data-fallback]")?.textContent).toContain("shell result");
		expect(element.querySelector("[data-fallback]")?.textContent).toContain("printf shell");
		await render([], { live: true }); expect(presentationClaims.getSnapshot()).toHaveLength(1);
		await act(async () => useApp.setState({ terminalTabId: "runs" })); expect(presentationClaims.getSnapshot()).toHaveLength(0);
		await act(async () => useApp.setState({ terminalTabId: null }));
		await render([execution("old"), ...laterEntries], { live: true, fallback: true });
		expect(element.textContent).toContain("Latest message");
		expect(runRows()).toHaveLength(0);
		expect(presentationClaims.getSnapshot()).toHaveLength(0);
		expect(element.querySelector("[data-fallback]")?.textContent).toContain("shell result");
		expect(element.querySelector("[data-fallback]")?.textContent).toContain("printf shell");
		await act(async () => root.render(null)); expect(presentationClaims.getSnapshot()).toHaveLength(0);
	});
	it("leaves malformed roles and stale documents in the generic fallback", async () => {
		data.snapshot = snapshot([{ id: "unknown", k: "tool", p: { role: "omp.bash", name: "bash", status: "done", title: "Incomplete execution" } }]);
		await render([], { live: true, fallback: true });
		expect(runRows()).toHaveLength(0); expect(presentationClaims.getSnapshot()).toHaveLength(0);
		expect(element.querySelector("[data-fallback]")?.textContent).toContain("Incomplete execution");
		data.snapshot = { ...snapshot([native("stale")]), documentGeneration: 0 };
		await render([], { live: true }); expect(runRows()).toHaveLength(0);
	});
});
