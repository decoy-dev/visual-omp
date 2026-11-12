// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import i18next from "i18next";
import { expect, it } from "vitest";
import "../../i18n";
import { RunByteValues, formatTraceBytes } from "./RunByteValues";

it("accepts strings and valid UTF-8 arrays, and retains invalid bytes as unambiguous escapes", () => {
	expect(formatTraceBytes("café")).toEqual({ text: "café", shown: 5, length: 5, escaped: false, limited: false });
	expect(formatTraceBytes([99, 97, 102, 195, 169])).toEqual(formatTraceBytes("café"));
	expect(formatTraceBytes([255, 92, 120, 102, 102, 0])).toEqual({ text: "\\xff\\\\xff\\x00", shown: 6, length: 6, escaped: true, limited: false });
	expect(formatTraceBytes([10, 9, 13])).toMatchObject({ text: "\\n\\t\\r", escaped: false });
	expect(formatTraceBytes([226, 128, 174])).toMatchObject({ text: "\\u202e", escaped: false });
	for (const value of [[256], [-1], [1.5], ["255"], Array(1), {}, null]) expect(formatTraceBytes(value)).toBeNull();
});

it("caps formatted input at 4096 bytes and bounds escaped text to 16384 characters", () => {
	const source = new Proxy(Array(100_000).fill(255), { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key) && Number(key) >= 4096) throw new Error("Read beyond the byte cap"); return Reflect.get(target, key, receiver); } });
	const value = formatTraceBytes(source)!;
	expect(value).toMatchObject({ shown: 4096, length: 100_000, escaped: true, limited: true });
	expect(value.text.length).toBe(16384);
	const text = formatTraceBytes("é".repeat(5000))!;
	expect(text).toMatchObject({ shown: 4096, length: undefined, escaped: false, limited: true });
	expect(text.text).toBe("é".repeat(2048));
});

it("shows known byte-array fields without inspecting syntax archives, and pages retained values", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
	await i18next.loadNamespaces("shellVisualization");
	const trace = { units: [{ source: [255], syntax: { source: [255], argv: [[255]] }, nodes: [{ argv: [[99, 97, 102, 195, 169]], env: [[[255], [255]]], redirs: [{ target: [255] }] }] }], history: [{ kind: "CmdExpanded", argv: [[255]], assigns: [[[255], [255]]], redirs: [{ target: [255] }] }, { kind: "Assign", name: [255], value: [255] }, { kind: "Diag", text: [255] }], diags: Array.from({ length: 30 }, () => ({ message: Array(5000).fill(255) })) };
	const element = document.createElement("div"); document.body.append(element);
	const root = createRoot(element);
	try {
		await act(async () => root.render(createElement(RunByteValues, { trace })));
		expect(element.querySelectorAll("dd")).toHaveLength(0);
		const disclosure = element.querySelector("details")!;
		await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
		for (const field of ["units[0].source", "units[0].nodes[0].argv[0]", "units[0].nodes[0].env[0][0]", "units[0].nodes[0].env[0][1]", "units[0].nodes[0].redirs[0].target", "history[0].assigns[0][0]", "history[0].assigns[0][1]", "history[0].redirs[0].target", "history[1].name", "history[1].value", "history[2].text", "diags[0].message"]) expect(element.textContent).toContain(field);
		expect(element.textContent).not.toContain("syntax");
		expect(element.textContent).toContain("café");
		expect(element.textContent).toContain("\\xff");
		expect(element.textContent).toContain("Showing the first 4096 of 5000 array values. Remaining values were not inspected.");
		expect(element.querySelectorAll("dd")).toHaveLength(25);
		await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "Next byte values")!.click());
		expect(element.querySelectorAll("dd")).toHaveLength(17);
		expect(element.textContent).toContain("diags[29].message");
	} finally { await act(async () => root.unmount()); element.remove(); }
});

async function inspectValues(trace: unknown, run: (element: HTMLDivElement) => Promise<void>) {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
	await i18next.loadNamespaces("shellVisualization");
	const element = document.createElement("div"); document.body.append(element);
	const root = createRoot(element);
	try {
		await act(async () => root.render(createElement(RunByteValues, { trace })));
		await run(element);
	} finally { await act(async () => root.unmount()); element.remove(); }
}
async function openValues(element: HTMLElement) {
	const disclosure = element.querySelector("details")!;
	await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
}

it("counts only valid values for pagination and never repeats values after malformed arrays", async () => {
	const argv = [[-1], ...Array.from({ length: 26 }, (_, index) => [65 + index])];
	await inspectValues({ units: [{ nodes: [{ argv }] }] }, async element => {
		await openValues(element);
		expect([...element.querySelectorAll("dd")].map(entry => entry.textContent)).toEqual(Array.from({ length: 25 }, (_, index) => String.fromCharCode(65 + index)));
		await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "Next byte values")!.click());
		expect([...element.querySelectorAll("dd")].map(entry => entry.textContent)).toEqual(["Z"]);
	});
});

it("does no closed-disclosure inspection", async () => {
	await inspectValues({ get units() { throw new Error("Closed inspection read a trace field"); } }, async element => {
		expect(element.querySelector("summary")?.textContent).toBe("Recorded byte values");
		expect(element.querySelectorAll("dd")).toHaveLength(0);
	});
});

it.each([
	{ units: Array(60_000).fill(null) },
	{ units: [{ nodes: [{ argv: Array(60_000).fill([-1]) }] }] },
	{ units: [{ nodes: [{ argv: Array(300).fill(Array(4096).fill(-1)) }] }] },
])("bounds field and byte inspection with an explicit limit outcome %#", async trace => {
	await inspectValues(trace, async element => {
		await openValues(element);
		expect(element.querySelector('[role="status"]')?.textContent).toContain("Byte inspection reached its limit.");
		expect(element.querySelectorAll("dd")).toHaveLength(0);
	});
});
