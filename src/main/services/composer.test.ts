import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCommands, editorTextFromScreen, ensureSttBinding, findPromptEditor, parseCommandFile } from "./composer";

describe("ensureSttBinding", () => {
	it("creates the file content when there is none", () => {
		expect(ensureSttBinding(null)).toEqual({ key: "f9", text: "app.stt.toggle: f9\n" });
	});

	it("keeps comments and picks a key no other action uses", () => {
		const source = "# my keys\napp.model.select: f9 # model picker\n";
		const result = ensureSttBinding(source);
		expect(result.key).toBe("f10");
		expect(result.text).toContain("# my keys");
		expect(result.text).toContain("# model picker");
		expect(result.text).toContain("app.stt.toggle: f10");
	});

	it("adds a function key next to the user's own dictation key", () => {
		expect(ensureSttBinding("app.stt.toggle: ctrl+shift+d\n").text).toContain("- ctrl+shift+d");
	});

	it("leaves the file alone when a usable key is already bound", () => {
		expect(ensureSttBinding("app.stt.toggle: [ctrl+shift+d, F10]\n")).toEqual({ key: "f10", text: null });
	});
});

describe("findPromptEditor", () => {
	const editor = (textPreview: string) => ({
		textPreview,
		textLength: textPreview.length,
		previewTruncated: false,
		cursorLine: 0,
		cursorCol: 0,
		lineCount: 1,
		selection: null,
		placeholderActive: false,
	});

	it("picks the shallowest editor-shaped state, ignoring other components", () => {
		const values = { "Ab[0.1]": { text: "status" }, "Xy[3.2.1.0]": editor("overlay input"), "Qe[3.2]": editor("main prompt") };
		expect(findPromptEditor(values)?.textPreview).toBe("main prompt");
		expect(findPromptEditor({ "Ab[0]": { lines: 3 } })).toBeNull();
	});
});

describe("editorTextFromScreen", () => {
	it("joins wrapped editor rows up to omp's text length", () => {
		const full = "please add a dark mode toggle to the settings page and remember the choice between visits okay then thanks";
		const state = {
			textPreview: full.slice(0, 120),
			textLength: full.length,
			previewTruncated: true,
			cursorLine: 0,
			lineCount: 1,
			placeholderActive: false,
		};
		const lines = [
			"some transcript",
			"│ please add a dark mode toggle to the settings    │",
			"│ page and remember the choice between visits      │",
			"│ okay then thanks                                 │",
			"",
		];
		expect(editorTextFromScreen(lines, state)).toBe(full);
	});
});

describe("commands", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it("reads description and argument hint, falling back to the first line", () => {
		expect(parseCommandFile("---\ndescription: Fix an issue\nargument-hint: <number>\n---\nFix issue $1")).toEqual({
			description: "Fix an issue",
			argumentHint: "<number>",
		});
		expect(parseCommandFile("\n\nReview the diff carefully\nmore")).toEqual({
			description: "Review the diff carefully",
			argumentHint: null,
		});
	});

	it("lets project commands shadow user ones and names nested claude commands dir:name", async () => {
		dir = mkdtempSync(join(tmpdir(), "vomp-commands-"));
		const project = join(dir, "project");
		const agent = join(dir, "agent");
		mkdirSync(join(project, ".omp", "commands"), { recursive: true });
		mkdirSync(join(project, ".claude", "commands", "git"), { recursive: true });
		mkdirSync(join(agent, "commands"), { recursive: true });
		writeFileSync(join(project, ".omp", "commands", "review.md"), "Project review");
		writeFileSync(join(project, ".claude", "commands", "git", "pr.md"), "Open a PR");
		writeFileSync(join(agent, "commands", "review.md"), "User review");
		writeFileSync(join(agent, "commands", "standup.md"), "Write standup");
		const commands = await discoverCommands(project, agent);
		expect(commands.map(command => [command.name, command.scope, command.description])).toEqual([
			["git:pr", "project", "Open a PR"],
			["review", "project", "Project review"],
			["standup", "user", "Write standup"],
		]);
	});
});
