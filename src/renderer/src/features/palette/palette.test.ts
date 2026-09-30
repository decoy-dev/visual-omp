import { describe, expect, it } from "vitest";
import { screenName } from "./overlays";
import { rank, rankFiles } from "./search";

describe("screenName", () => {
	it("names a screen from the title inset in its top rule", () => {
		expect(screenName(["╭─ Settings ─────────────────╮", "│ Appearance  Model  Tools │"])).toBe("settings");
		expect(screenName(["┏━ Resume Session (all projects) ━━━┓"])).toBe("resume");
		expect(screenName(["╭─ Models ────────── 42 available ─╮"])).toBe("models");
	});

	it("ignores the same words in ordinary transcript text", () => {
		expect(screenName(["Settings saved.", "│ Settings are stored in config.yml", "> open Usage page"])).toBeNull();
	});

	it("prefers the more specific screen when several titles are painted", () => {
		const lines = ["╭─ Settings ───╮", "╭─ Plan Review ───────╮"];
		expect(screenName(lines)).toBe("planReview");
	});

	it("recognises in-place dialogs by their prompt text", () => {
		expect(screenName(["", "  Select provider to login", "  Anthropic", "  OpenAI"])).toBe("login");
		expect(screenName(["─── Goal objective ───", "  ⏎ submit  esc cancel"])).toBe("goal");
	});
});

describe("rank", () => {
	const commands = [
		{ title: "Restart omp", keywords: ["start the engine fresh", "/restart"] },
		{ title: "Compact this chat", keywords: ["summarize", "free space", "/compact"] },
		{ title: "Summary of changes", keywords: [] },
	];
	const describeCommand = (item: (typeof commands)[number]) => ({ text: item.title, keywords: item.keywords });

	it("finds commands by plain-language alias and slash command", () => {
		expect(rank(commands, "free space", describeCommand).map(item => item.title)).toEqual(["Compact this chat"]);
		expect(rank(commands, "/restart", describeCommand)[0]?.title).toBe("Restart omp");
	});

	it("ranks a title match above an alias-only match", () => {
		expect(rank(commands, "summ", describeCommand).map(item => item.title)).toEqual(["Summary of changes", "Compact this chat"]);
	});

	it("does not match letters scattered across aliases", () => {
		const panel = { title: "Toggle side panel", keywords: ["dock", "panel", "right", "diff", "files", "preview"] };
		expect(rank([panel], "dark", describeCommand)).toEqual([]);
	});

	it("keeps order for an empty query and honours the limit", () => {
		expect(rank(commands, "  ", describeCommand, 2).map(item => item.title)).toEqual(["Restart omp", "Compact this chat"]);
	});
});

describe("rankFiles", () => {
	const files = [
		"packages/coding-agent/test/tools/fetch-url-selectors.test.ts",
		"packages/tui/src/overlays/pause-screen.ts",
		"docs/pause.md",
		"src/cart/coupon.ts",
	];

	it("puts file-name hits first and drops scattered-letter paths", () => {
		expect(rankFiles(files, "pause", 5)).toEqual(["docs/pause.md", "packages/tui/src/overlays/pause-screen.ts"]);
		expect(rankFiles(files, "cart/coup", 5)).toEqual(["src/cart/coupon.ts"]);
		expect(rankFiles(files, "zzq", 5)).toEqual([]);
	});
});
