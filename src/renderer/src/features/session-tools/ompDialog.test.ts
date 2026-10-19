import { describe, expect, it } from "vitest";
import { legendKey, parseOmpDialog } from "./ompDialog";

/** Screens captured from omp 18.11.3 through its TUI debug `text` op (120×36, unicode symbols). */
const FIXTURES = import.meta.glob<string>("./fixtures/omp-dialogs/*.txt", { query: "?raw", import: "default", eager: true });

function screen(name: string): string[] {
	const text = FIXTURES[`./fixtures/omp-dialogs/${name}.txt`];
	if (text === undefined) throw new Error(`Missing fixture ${name}`);
	return text.replace(/\n$/, "").split("\n");
}

describe("parseOmpDialog", () => {
	it("reads a selector with option descriptions and follows the highlight", () => {
		expect(parseOmpDialog(screen("selector-descriptions"))).toEqual({
			kind: "select",
			title: "Consult this session with",
			detail: [],
			options: [
				{ label: "Use saved model", description: "Use the active role or default model saved with this session" },
				{ label: "Choose another model", description: "Select a one-off model for this consultation" },
			],
			selected: 0,
			help: null,
			hidden: 0,
			query: null,
			confirm: false,
			cancelKey: "escape",
		});
		expect(parseOmpDialog(screen("selector-descriptions-moved"))).toMatchObject({ selected: 1 });
	});

	it("reads a confirm with a multi-line message, keeping its blank line", () => {
		const dialog = parseOmpDialog(screen("confirm-detail"));
		expect(dialog).toMatchObject({
			kind: "select",
			title: "Clear Artifact Cache",
			detail: ["Found 340 artifact files (530.2MB)", "Oldest: 8/14/2026", "", "Remove artifacts older than 30 days?"],
			options: [
				{ label: "Yes", description: null },
				{ label: "No", description: null },
			],
			selected: 0,
			confirm: true,
		});
		expect(parseOmpDialog(screen("confirm-detail-no"))).toMatchObject({ selected: 1, confirm: true });
		expect(parseOmpDialog(screen("confirm"))).toMatchObject({
			title: "Overwrite TTSR rule?",
			detail: ["rules/foo.md already exists. Overwrite it?"],
			confirm: true,
		});
	});

	it("counts options a windowed or filtered list does not paint", () => {
		const windowed = parseOmpDialog(screen("selector-windowed"));
		expect(windowed).toMatchObject({ kind: "select", title: "Pick a region", selected: 0, hidden: 5, query: null });
		expect(windowed?.kind === "select" && windowed.options.map(option => option.label)).toEqual(
			Array.from({ length: 15 }, (_, index) => `Region ${index + 1}`),
		);
		const filtered = parseOmpDialog(screen("selector-search"));
		expect(filtered).toMatchObject({ selected: 0, hidden: 9, query: "1" });
		expect(filtered?.kind === "select" && filtered.options.at(-1)?.label).toBe("Region 19");
	});

	it("reads an outlined list", () => {
		expect(parseOmpDialog(screen("selector-outline"))).toMatchObject({
			kind: "select",
			title: "Pick a color",
			detail: ["Used for the status line."],
			options: [
				{ label: "Red", description: null },
				{ label: "Green", description: null },
				{ label: "Blue", description: null },
			],
			selected: 0,
			confirm: false,
		});
	});

	it("reads one-line inputs, including one below another panel", () => {
		expect(parseOmpDialog(screen("input-below-panel"))).toEqual({
			kind: "input",
			title: "Describe what to detect and fix",
			detail: [],
			value: "ts errors",
			submitKey: "enter",
			cancelKey: "escape",
		});
		expect(parseOmpDialog(screen("input-empty"))).toMatchObject({ kind: "input", title: "API key for Example", value: "" });
	});

	it("reads both editor styles with their submit keys", () => {
		expect(parseOmpDialog(screen("editor-prompt"))).toEqual({
			kind: "editor",
			title: "Goal objective",
			detail: [],
			value: "first\nsecond line",
			submitKey: "enter",
			cancelKey: "escape",
		});
		expect(parseOmpDialog(screen("editor-hook"))).toEqual({
			kind: "editor",
			title: "Release notes",
			detail: ["Describe what changed in this release."],
			value: "First line\nSecond line",
			submitKey: "C-q",
			cancelKey: "escape",
		});
		expect(parseOmpDialog(screen("editor-hook-empty"))).toMatchObject({ kind: "editor", value: "" });
	});

	it("ignores omp's own pickers, panels and the main editor", () => {
		expect(parseOmpDialog(screen("not-dialog-debug-tools"))).toBeNull();
		expect(parseOmpDialog(screen("not-dialog-editor-below-panel"))).toBeNull();
	});

	it("gives up on rows it cannot place", () => {
		const lines = screen("selector-descriptions");
		const cursor = lines.findIndex(line => line.includes("❯ Use saved model"));
		// A multi-select list shows no cursor in plain text.
		const checkbox = lines.map((line, index) => (index === cursor ? line.replace("❯ Use", "☑ Use") : line));
		expect(parseOmpDialog(checkbox)).toBeNull();
	});
});

describe("legendKey", () => {
	it("maps omp's key legends on macOS and other platforms", () => {
		expect(legendKey("⏎ or ⌃Q submit  ⎋ cancel  ⌃G external editor", "submit", "x")).toBe("enter");
		expect(legendKey("⌃Q/⌃⏎ submit  ⎋ cancel", "submit", "x")).toBe("C-q");
		expect(legendKey("Ctrl+Q/Ctrl+⏎ submit  ⎋ cancel", "submit", "x")).toBe("C-q");
		expect(legendKey("↑/↓ navigate  ⏎ select  ⎋ cancel", "cancel", "x")).toBe("escape");
		expect(legendKey("⎋ to paste inline", "cancel", "escape")).toBe("escape");
	});
});
