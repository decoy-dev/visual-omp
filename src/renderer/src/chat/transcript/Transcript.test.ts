import { createElement } from "react";
import type * as ReactModule from "react";
import type * as PaceModule from "./pace";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantMessage } from "@oh-my-pi/pi-wire";
import type { FileRef } from "@shared/contracts/fileRefs";
import type { ReplyRefs } from "./fileRefs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { AssistantBlocks } from "./Transcript";
import { writingThought } from "./thoughtChoices";

vi.hoisted(() => { vi.stubGlobal("window", { vomp: { platform: "darwin" } }); });
const pace = vi.hoisted(() => ({ blocks: [] as { length: number; timed: boolean }[] }));
const links = vi.hoisted(() => ({ texts: [] as readonly string[], refs: null as ReplyRefs | null, drawn: [] as { text: string; refs: readonly (FileRef | null)[] | undefined }[] }));
beforeEach(() => { links.texts = []; links.refs = null; links.drawn = []; });
vi.mock("react", async importOriginal => ({
	...await importOriginal<typeof ReactModule>(),
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("./pace", async importOriginal => ({
	...await importOriginal<typeof PaceModule>(),
	usePlayout: (_key: number, blocks: typeof pace.blocks) => { pace.blocks = blocks; return null; },
}));
vi.mock("./FileLinks", async () => {
	// Vitest hoists this factory before static imports; load its dependencies inside the factory.
	const { createContext, createElement } = await import("react");
	const { renderMarkdown } = await import("../../transcript/render");
	return {
		FileRefContext: createContext(null),
		useFileRefs: (_reply: number | null, texts: readonly string[]) => { links.texts = texts; return links.refs; },
		LinkedMarkdown: ({ text, refs }: { text: string; refs: readonly (FileRef | null)[] | undefined }) => {
			links.drawn.push({ text, refs });
			return createElement("div", { dangerouslySetInnerHTML: { __html: renderMarkdown(text) } });
		},
		writtenFolders: () => [],
	};
});

const message = {
	role: "assistant", model: "claude-opus-5-5", timestamp: 1000, stopReason: "toolUse",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	content: [{ type: "thinking", thinking: "The first **check passed**.", narration: true }],
} as AssistantMessage;

describe("narration replies", () => {
	it.each(["normal", "thinking", "verbose"] as const)("renders narration as reply Markdown in %s view", mode => {
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message, mode, results: new Map(), active: new Map(), pending: false }));
		expect(html).toContain("<strong>check passed</strong>");
		expect(html).not.toContain("aria-expanded");
		expect(pace.blocks).toEqual([{ length: message.content[0].type === "thinking" ? message.content[0].thinking.length : 0, timed: true }]);
	});

	it("assigns narration the reply-text file-reference ordinal between ordinary text blocks", () => {
		const paths = ["/repo/first.ts", "/repo/narrated.ts", "/repo/last.ts"];
		links.refs = paths.map(path => [{ path, kind: "file" }]);
		const mixed: AssistantMessage = {
			...message,
			content: [
				{ type: "text", text: "first.ts" },
				{ type: "thinking", thinking: "Unmarked reasoning." },
				{ type: "thinking", thinking: "narrated.ts", narration: true },
				{ type: "text", text: "last.ts" },
			],
		};
		renderToStaticMarkup(createElement(AssistantBlocks, { message: mixed, mode: "normal", results: new Map(), active: new Map(), pending: false }));
		expect(links.texts).toEqual(["first.ts", "narrated.ts", "last.ts"]);
		expect(links.drawn).toEqual([
			{ text: "first.ts", refs: links.refs[0] },
			{ text: "narrated.ts", refs: links.refs[1] },
			{ text: "last.ts", refs: links.refs[2] },
		]);
	});

	it("does not treat narration as the live thought", () => {
		expect(writingThought(message, true, true)).toBe(-1);
	});

	it("keeps unmarked thinking folded in Normal view", () => {
		const thought = { ...message, content: [{ type: "thinking" as const, thinking: "Private thought" }] };
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message: thought, mode: "normal", results: new Map(), active: new Map(), pending: false }));
		expect(html).toContain('aria-expanded="false"');
		expect(pace.blocks).toEqual([{ length: "Private thought".length, timed: false }]);
	});
});
