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

vi.hoisted(() => { vi.stubGlobal("window", { vomp: { platform: "darwin" }, addEventListener: () => {}, removeEventListener: () => {} }); });
const pace = vi.hoisted(() => ({ blocks: [] as { length: number; timed: boolean }[], timelines: new Map<number | string, { length: number; timed: boolean }[]>() }));
const links = vi.hoisted(() => ({ texts: [] as readonly string[], refs: null as ReplyRefs | null, drawn: [] as { text: string; refs: readonly (FileRef | null)[] | undefined }[] }));
beforeEach(() => { links.texts = []; links.refs = null; links.drawn = []; pace.timelines.clear(); });
vi.mock("react", async importOriginal => ({
	...await importOriginal<typeof ReactModule>(),
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("./pace", async importOriginal => ({
	...await importOriginal<typeof PaceModule>(),
	usePlayout: (key: number | string, blocks: typeof pace.blocks) => { pace.blocks = blocks; pace.timelines.set(key, blocks); return null; },
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

describe("interim replies", () => {
	const call = (name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id: "reply-call", name, arguments: args });

	it.each(["normal", "thinking", "verbose"] as const)("renders out writes as paced prose without a tool card in %s view", mode => {
		const interim: AssistantMessage = { ...message, content: [call("write", { path: "out://progress", content: "The **first step** passed." })] };
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message: interim, mode, results: new Map(), active: new Map(), pending: false }));
		expect(html).toContain("<strong>first step</strong>");
		expect(html).not.toContain("out://");
		expect(html).not.toContain("aria-expanded");
		expect(pace.blocks).toEqual([{ length: "The **first step** passed.".length, timed: true }]);
		expect(links.texts).toEqual(["The **first step** passed."]);
	});

	it("uses the current partial write arguments while the call is live", () => {
		const interim: AssistantMessage = { ...message, content: [call("write", { path: "out://", content: "First" })] };
		const active = new Map([["reply-call", { toolCallId: "reply-call", toolName: "write", args: { path: "out://", content: "First **complete paragraph**." }, startedAt: 1000 }]]);
		renderToStaticMarkup(createElement(AssistantBlocks, { message: interim, mode: "normal", results: new Map(), active, pending: false }));
		expect(links.texts).toEqual(["First **complete paragraph**."]);
		expect(pace.blocks).toEqual([{ length: "First **complete paragraph**.".length, timed: true }]);
	});

	it("renders saved and live bash replies once as prose outside the command disclosure", () => {
		const interim: AssistantMessage = { ...message, content: [call("bash", { command: "printf report > out://" })] };
		const saved = { role: "toolResult" as const, toolCallId: "reply-call", toolName: "bash", timestamp: 2000, content: [], details: { replies: ["First **report**.", "Second report."] }, isError: false };
		const active = new Map([["reply-call", { toolCallId: "reply-call", toolName: "bash", args: { command: "printf report > out://" }, partialResult: { details: { replies: ["Stale report."] } }, startedAt: 1000 }]]);
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message: interim, mode: "normal", results: new Map([["reply-call", saved]]), active, pending: false }));
		expect(html).toContain("<strong>report</strong>");
		expect(links.drawn.map(block => block.text)).toEqual(["First **report**.", "Second report."]);
		expect(pace.timelines.get("tool-replies:reply-call:0")).toEqual([{ length: "First **report**.".length, timed: true }]);
		expect(pace.timelines.get("tool-replies:reply-call:1")).toEqual([{ length: "Second report.".length, timed: true }]);
		expect(html.match(/First/g)).toHaveLength(1);
		expect(html).not.toContain("Stale report.");
	});

	it("renders foreground progress replies before bash has a saved result", () => {
		const interim: AssistantMessage = { ...message, content: [call("bash", { command: "printf report > out://" })] };
		const active = new Map([["reply-call", { toolCallId: "reply-call", toolName: "bash", args: { command: "printf report > out://" }, partialResult: { details: { replies: ["Foreground **report**."] } }, startedAt: 1000 }]]);
		renderToStaticMarkup(createElement(AssistantBlocks, { message: interim, mode: "normal", results: new Map(), active, pending: false }));
		expect(links.texts).toEqual(["Foreground **report**."]);
		expect(pace.timelines.get(1000)).toEqual([{ length: 0, timed: false }]);
		expect(pace.timelines.get("tool-replies:reply-call:0")).toEqual([{ length: "Foreground **report**.".length, timed: true }]);
	});

	it("keeps a refused out write's error visible beside its prose", () => {
		const interim: AssistantMessage = { ...message, content: [call("write", { path: "out://", content: "Report." })] };
		const error = { role: "toolResult" as const, toolCallId: "reply-call", toolName: "write", timestamp: 2000, content: [{ type: "text" as const, text: "out:// is off in this session." }], isError: true };
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message: interim, mode: "normal", results: new Map([["reply-call", error]]), active: new Map(), pending: false }));
		expect(html).toContain("Report.");
		expect(html).toContain("out:// is off in this session.");
	});
});

it("does not flash a tool card while a partial write path can still become out://", () => {
	for (const path of ["", "o", "ou", "out", "out:", "out:/"]) {
		const interim: AssistantMessage = { ...message, content: [{ type: "toolCall", id: "partial", name: "write", arguments: { path, content: "Report." } }] };
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message: interim, mode: "normal", results: new Map(), active: new Map(), pending: true }));
		expect(html).not.toContain("aria-expanded");
		expect(html).not.toContain("Report.");
	}
});
