import { createElement } from "react";
import type * as ReactModule from "react";
import type * as PaceModule from "./pace";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { FileRef } from "@shared/contracts/fileRefs";
import type { ReplyRefs } from "./fileRefs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { AssistantBlocks, Transcript, TranscriptBody } from "./Transcript";
import type { SessionController, SessionView } from "../../state/session";
import { transcriptLayout, unsavedToolsMessage } from "./turns";
import { ThoughtChoices } from "./thoughtChoices";
import { TranscriptTime } from "./TranscriptTime";
import { NoticeRow } from "./NoticeRow";
import { TooltipProvider } from "../../ui";
import { writingThought } from "./thoughtChoices";

function renderToStaticMarkup(node: ReactModule.ReactNode): string {
	return renderMarkup(createElement(TooltipProvider, null, node));
}

vi.hoisted(() => { vi.stubGlobal("window", { vomp: { platform: "darwin" }, addEventListener: () => {}, removeEventListener: () => {} }); });
const pace = vi.hoisted(() => ({ blocks: [] as { length: number; timed: boolean }[], timelines: new Map<number | string, { length: number; timed: boolean }[]>() }));
const links = vi.hoisted(() => ({ texts: [] as readonly string[], refs: null as ReplyRefs | null, drawn: [] as { text: string; refs: readonly (FileRef | null)[] | undefined }[] }));
beforeEach(() => { links.texts = []; links.refs = null; links.drawn = []; pace.timelines.clear(); });
vi.mock("react", async importOriginal => ({
	...await importOriginal<typeof ReactModule>(),
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown, serverSnapshot?: () => unknown) => (serverSnapshot ?? snapshot)(),
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

it.each(["normal", "verbose"] as const)("keeps canonical omission notices without claiming success in %s view", mode => {
	const entries: SessionEntry[] = [
		{ type: "message", id: "call", parentId: null, timestamp: new Date(1000).toISOString(), message: {
			...message, content: [{ type: "toolCall", id: "omitted", name: "bash", arguments: { command: "npm test" } }],
		} },
		{ type: "custom_message", id: "omission", parentId: "call", timestamp: new Date(2000).toISOString(),
			customType: "collab-entry-too-large", display: true,
			content: "…[message entry, 19993941 bytes omitted for collab session: too large to replicate]" },
	];
	const html = renderToStaticMarkup(createElement(TranscriptBody, {
		scope: { tabId: "omitted", projectPath: "/repo" }, entries, mode, ready: true, identity: "omitted",
	}));
	if (mode === "verbose") expect(html).toContain('data-tool-status="neutral"');
	expect(html).not.toContain('data-tool-status="ok"');
	if (mode === "verbose") expect(html).toContain('aria-label="Result unavailable"');
	expect(html).toContain("too large to replicate");
	if (mode === "verbose") expect(html).toContain("npm test");
});

describe("stopped replies", () => {
	const stopped = (errorMessage?: string, stopReason: AssistantMessage["stopReason"] = "aborted"): AssistantMessage => ({ ...message, stopReason, errorMessage, content: [{ type: "text", text: "Plan written." }] });
	const render = (reply: AssistantMessage, mode: "normal" | "thinking" | "verbose" = "normal") => renderToStaticMarkup(createElement(AssistantBlocks, { message: reply, mode, results: new Map(), active: new Map(), pending: false }));

	it.each(["normal", "thinking", "verbose"] as const)("hides the stop omp ends a plan proposal with in %s view and keeps the reply", mode => {
		const silent = render(stopped("__omp.silent_abort__"), mode);
		expect(silent).toContain("Plan written.");
		expect(silent).not.toContain("__omp.silent_abort__");
		expect(silent).not.toContain("bg-warn-bg");
	});

	it("keeps real stops and errors visible with their diagnostic", () => {
		expect(render(stopped())).toContain("bg-warn-bg");
		expect(render(stopped("Request was aborted"))).toContain("Request was aborted");
		const error = render(stopped("429 rate limited", "error"));
		expect(error).toContain("bg-err-bg");
		expect(error).toContain("429 rate limited");
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

describe("recorded transcript times", () => {
	const start = new Date(2026, 2, 4, 9, 12, 8).getTime();
	const end = start + 73_000;
	const iso = (time: number) => new Date(time).toISOString();
	const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.ts` } });
	const reply = (timestamp: number, content: AssistantMessage["content"]): AssistantMessage => ({ ...message, timestamp, content });
	const entry = (id: string, message: AssistantMessage): SessionEntry => ({ type: "message", id, parentId: null, timestamp: iso(end + 1000), message });

	it("uses minute precision with full date, seconds and a machine-readable time, and dates saved entries", () => {
		const html = renderToStaticMarkup(createElement(TranscriptTime, { timestamp: start }));
		expect(html).toContain(`dateTime="${iso(start)}"`);
		expect(html).toContain(new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
		expect(html).toContain(new Date(start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
		expect(html).toContain("aria-label=");
		expect(html).toContain('tabindex="0"');
		expect(html).toContain("08");
		expect(renderToStaticMarkup(createElement(TranscriptTime, { timestamp: "invalid" }))).toBe("");
		const today = new Date(); today.setHours(9, 12, 8, 0);
		const current = renderToStaticMarkup(createElement(TranscriptTime, { timestamp: today.getTime() }));
		expect(current.slice(current.indexOf(">", current.indexOf("<time")) + 1)).not.toContain(" · ");
	});

	it.each([true, false])("shows a thirty-minute tool interval with each message's own time intact (live: %s)", live => {
		const later = start + 30 * 60_000;
		const entries = [
			entry("first", reply(start, [call("first")])),
			{ type: "message", id: "result", parentId: "first", timestamp: iso(later), message: { role: "toolResult", toolCallId: "first", toolName: "read", timestamp: later, content: [], isError: false } } as SessionEntry,
			entry("later", reply(later, [call("later")])),
		];
		const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TranscriptBody, { scope: { tabId: "range", projectPath: "/repo" }, entries, mode: "normal", working: live, ready: true, identity: "range" })));
		expect(html).toContain(`dateTime="${iso(start)}" data-through="${iso(later)}"`);
		const first = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).formatToParts(new Date(start)).filter(part => part.type !== "dayPeriod").map(part => part.value).join("").trim();
		expect(html).toContain(`${first}-${new Date(later).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
	});

	it("keeps a single compact minute for a short interval, with both full endpoints accessible", () => {
		const html = renderToStaticMarkup(createElement(TranscriptTime, { timestamp: start, through: start + 1000 }));
		expect(html).toContain(`data-through="${iso(start + 1000)}"`);
		expect(html).toContain("08");
		expect(html).toContain("09");
		expect(html.slice(html.indexOf(">", html.indexOf("<time")) + 1)).not.toContain(" - ");
	});

	it.each(["normal", "thinking", "verbose"] as const)("uses the assistant message for thoughts and calls, and the result for completion in %s", mode => {
		const response = reply(start, [{ type: "thinking", thinking: "Check the source." }, call("source")]);
		const result = { role: "toolResult" as const, toolCallId: "source", toolName: "read", timestamp: end, content: [], isError: false };
		const active = new Map([["source", { toolCallId: "source", toolName: "read", args: {}, startedAt: start + 40_000 }]]);
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message: response, mode, results: new Map([["source", result]]), active, pending: false }));
		expect(html.match(new RegExp(`dateTime="${iso(start)}"`, "g"))).toHaveLength(2);
		expect(html).not.toContain(`dateTime="${iso(start + 40_000)}"`);
		if (mode === "verbose") expect(html).toContain(`dateTime="${iso(end)}"`);
	});

	it("keeps a time on each grouped step while hiding repeated adjacent minute labels", () => {
		const first = reply(start, [call("first")]);
		const second = reply(start + 10_000, [call("second"), { type: "thinking", thinking: "Continue." }, call("third")]);
		const entries = [entry("one", first), entry("two", second)];
		const layout = transcriptLayout(entries, { live: false, group: true, context: { cwd: "/repo", home: null } });
		const plan = layout.entries.get("one")!.groups.get(0)!;
		const work = { layout, openGroups: new Map([[plan.key, true]]), thoughts: new ThoughtChoices(), arriving: new Set<string>(), helpers: new Map(), pinned: new Set<string>(), recorded: new Map(), ompRunning: false, synchronizing: false, hold: () => {}, holdGroup: () => {} };
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message: first, mode: "normal", results: new Map(), active: new Map(), pending: false, layout: layout.entries.get("one"), work }));
		expect(html.match(/<time /g)).toHaveLength(5);
		expect(html.match(/class="invisible"/g)).toHaveLength(1);
		expect(html.match(new RegExp(`dateTime="${iso(start)}"`, "g"))).toHaveLength(2);
	});

	it("uses each unsaved active call's own start, before an assistant message exists", () => {
		const active = new Map(["one", "two"].map((id, index) => [id, { toolCallId: id, toolName: "read", args: { path: `${id}.ts` }, startedAt: start + index * 120_000 }]));
		const response = unsavedToolsMessage(active.values(), new Set(), null)!;
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message: response, mode: "thinking", results: new Map(), active, pending: false, synthetic: true }));
		expect(html).toContain(`dateTime="${iso(start)}"`);
		expect(html).toContain(`dateTime="${iso(start + 120_000)}"`);
	});

	it.each(["normal", "thinking", "verbose"] as const)("renders a custom notice's entry time in %s", mode => {
		const html = renderToStaticMarkup(createElement(NoticeRow, { entry: { customType: "status", content: "Completed the check.", timestamp: iso(start) }, mode }));
		expect(html).toContain(`dateTime="${iso(start)}"`);
		const untimed = renderToStaticMarkup(createElement(NoticeRow, { entry: { customType: "tsp-notice", content: "No timestamp was recorded." }, mode }));
		expect(untimed).not.toContain("<time");
	});

	it.each(["thinking", "verbose"] as const)("deduplicates adjacent calls and restarts after reply prose in %s", mode => {
		const response = reply(start, [call("first"), call("second"), { type: "toolCall", id: "out", name: "write", arguments: { path: "out://progress", content: "Progress." } }, call("third")]);
		const html = renderToStaticMarkup(createElement(AssistantBlocks, { message: response, mode, results: new Map(), active: new Map(), pending: false }));
		expect(html.match(/<time /g)).toHaveLength(3);
		expect(html.match(/class="invisible"/g)).toHaveLength(1);
	});

	it("shows the same recorded times from the first stream render through the saved reply", () => {
		const response = reply(start, [{ type: "thinking", thinking: "Check the recorded time." }, call("source"), { type: "text", text: "The source is correct." }]);
		const guest = { phase: "live", header: { id: "stream" }, entries: [], stream: response, activeTools: new Map(), agents: [], progress: new Map(), lifecycle: new Map(), uiRequest: null, loading: null };
		const live = { mode: "live", guest, host: null, history: null, working: true } as unknown as SessionView;
		const saved = { mode: "saved", guest: null, host: null, history: { header: { id: "stream" }, entries: [entry("saved", response)] }, working: false } as unknown as SessionView;
		const times = (view: SessionView) => {
			const session = { projectPath: "/repo", tabId: "stream", subscribe: () => () => {}, getSnapshot: () => view, guestClient: () => null, tspNotices: { subscribe: () => () => {}, getSnapshot: () => [] } } as unknown as SessionController;
			return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Transcript, { session, view, mode: "thinking" }))).match(/<time[^>]*>.*?<\/time>/g);
		};
		expect(times(live)).toHaveLength(3);
		expect(times(live)).toEqual(times(saved));
	});

	it.each([undefined, "tsp"] as const)("renders saved user and successive reply times identically with transport %s", transport => {
		const userTime = start - 60_000;
		const entries: SessionEntry[] = [
			{ type: "message", id: "user", parentId: null, timestamp: iso(userTime), message: { role: "user", content: "Review this.", timestamp: userTime + 1000 } },
			entry("one", reply(start, [{ type: "text", text: "First reply." }])),
			entry("two", reply(end, [{ type: "text", text: "Second reply." }])),
			{ type: "compaction", id: "compact", parentId: null, timestamp: iso(end + 5000), summary: "Summary.", firstKeptEntryId: "user", tokensBefore: 10 },
		];
		const view = { mode: "saved", guest: null, host: transport ? { transport } : null, history: { header: { id: "saved" }, entries }, working: false } as unknown as SessionView;
		const session = { projectPath: "/repo", tabId: "saved", subscribe: () => () => {}, getSnapshot: () => view, guestClient: () => null, tspNotices: { subscribe: () => () => {}, getSnapshot: () => [] } } as unknown as SessionController;
		const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Transcript, { session, view, mode: "thinking" })));
		for (const time of [userTime, start, end, end + 5000]) expect(html).toContain(`dateTime="${iso(time)}"`);
		expect(html).not.toContain(`dateTime="${iso(end + 1000)}"`);
		expect(html).toContain('aria-live="off"');
		expect(html).toContain("Second reply.");
	});
});

it("renders a helper's file-backed conversation with shared tool cards, thoughts and notices without a controller", () => {
	const response = { ...message, content: [
		{ type: "thinking", thinking: "Inspect the file." },
		{ type: "text", text: "The helper found **the answer**." },
		{ type: "toolCall", id: "helper-read", name: "read", intent: "Reading helper source", arguments: { path: "/repo/source.ts" } },
	] } as AssistantMessage;
	const entries: SessionEntry[] = [
		{ type: "message", id: "helper-reply", parentId: null, timestamp: "2026-11-05T12:00:00Z", message: response },
		{ type: "message", id: "helper-result", parentId: "helper-reply", timestamp: "2026-11-05T12:00:01Z", message: { role: "toolResult", toolCallId: "helper-read", toolName: "read", timestamp: 2000, content: [{ type: "text", text: "File contents." }], isError: false } },
		{ type: "custom_message", id: "helper-notice", parentId: "helper-result", timestamp: "2026-11-05T12:00:02Z", customType: "skill-invocation", content: "Helper notice.", display: true },
	];
	const html = renderToStaticMarkup(createElement(TranscriptBody, { scope: { tabId: "parent", projectPath: "/repo" }, entries, mode: "verbose", ready: true, identity: "helper" }));
	expect(html).toContain("Reading helper source");
	expect(html).toContain("Inspect the file.");
	expect(html).toContain("<strong>the answer</strong>");
	expect(html).toContain("Helper notice.");
	expect(html).not.toContain("Rewind");
	expect(html).not.toContain("Fork from");
});

it("shows the same color decorations in user messages, replies and expanded thinking", () => {
	const entries: SessionEntry[] = [
		{ type: "message", id: "user", parentId: null, timestamp: "2026-03-04T09:12:00Z", message: { role: "user", content: "Compare #112233 with issue #123.", timestamp: 1000 } },
		{ type: "message", id: "reply", parentId: "user", timestamp: "2026-03-04T09:13:00Z", message: { ...message, content: [{ type: "thinking", thinking: "Try `#abc`." }, { type: "text", text: "Use #44556680." }] } },
	];
	const view = { mode: "saved", guest: null, host: null, history: { header: { id: "colors" }, entries }, working: false } as unknown as SessionView;
	const session = { projectPath: "/repo", tabId: "colors", subscribe: () => () => {}, getSnapshot: () => view, guestClient: () => null, tspNotices: { subscribe: () => () => {}, getSnapshot: () => [] } } as unknown as SessionController;
	const html = renderToStaticMarkup(createElement(Transcript, { session, view, mode: "thinking" }));
	expect(html.match(/class="vomp-color-swatch"/g)).toHaveLength(3);
	expect(html).toContain('title="#112233"');
	expect(html).toContain('title="#AABBCC"');
	expect(html).toContain('title="#44556680"');
	expect(html).toContain("issue #123.");
});
