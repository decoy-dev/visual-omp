// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ComponentType } from "react";
import type * as DiagramSource from "../../../ui/diagram-source";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveFrameProps, LiveSubject } from "../types";
import { csvMarkdown } from "./csv";
import { Frame as SvgFrame } from "./svg";
import { Frame as MermaidFrame } from "./mermaid";
import { Frame as PdfFrame } from "./pdf";

const { mermaid, palette, pendingImages } = vi.hoisted(() => ({ mermaid: vi.fn(), palette: { fg: "black", surface: "white" }, pendingImages: [] as Array<{ src: string; onload: (() => void) | null; onerror: (() => void) | null }> }));
vi.mock("../../../ui/mermaid-render", () => ({ renderMermaid: mermaid }));
vi.mock("../../../ui/diagram-source", async importOriginal => ({ ...await importOriginal<typeof DiagramSource>(), figurePalette: () => palette }));
vi.mock("../../../transcript/Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", null, text) }));
vi.mock("../../panes/media", () => ({
	ZoomImage: ({ src, alt }: { src: string; alt: string }) => createElement("img", { src, alt }),
	PdfFrame: ({ bytes, sourceUrl, revision }: { bytes?: Uint8Array; sourceUrl?: string; revision: number }) => createElement("div", { "data-pdf-revision": revision }, bytes ? new TextDecoder().decode(bytes) : sourceUrl),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key === "live.waitingForSave" ? "Waiting for omp to finish saving" : key }) }));

function subject(overrides: Partial<LiveSubject> = {}): LiveSubject {
	return { id: "call:draw", kind: "source", format: "svg", toolCallId: "draw", toolName: "write", path: "/project/poster.svg", text: '<svg viewBox="0 0 100 100"><title>Poster</title><rect width="20" height="20"/>', revision: 1, state: "writing", elided: false, intent: null, request: null, images: null, progress: null, sequence: null, size: 100, startedAt: 100, updatedAt: 100, ...overrides };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	pendingImages.length = 0;
	vi.stubGlobal("Image", class {
		src = "";
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		constructor() { pendingImages.push(this); }
	});
	mermaid.mockReset();
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function show(Frame: ComponentType<LiveFrameProps>, current: LiveSubject) {
	await act(async () => { root.render(createElement(Frame, { subject: current, projectPath: "/project", related: [] })); });
}

async function showPdf(revision = 1) {
	await show(PdfFrame, subject({ kind: "file", format: "pdf", path: "/project/report.pdf", text: null, revision }));
	await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe("delimited table conversion", () => {
	it("keeps complete rows while a trailing record is being written", () => {
		expect(csvMarkdown("Name,Value\nA,10\nB,2", ",", true)).toBe("| Name | Value |\n| --- | --- |\n| A | 10 |");
		expect(csvMarkdown("Name,Value\nA,10\nB,2", ",", false)).toContain("| B | 2 |");
	});
	it("supports quoted commas, escaped quotes, multiline cells, CRLF and TSV", () => {
		expect(csvMarkdown('Name,Value\r\n"A, \"\"quoted\"\"",10\r\n"two\nlines",20\r\n', ",", true)).toContain('| A, "quoted" | 10 |\n| two<br>lines | 20 |');
		expect(csvMarkdown("Name\tValue\nA\t10\n", "\t", true)).toContain("| A | 10 |");
	});
	it("does not expose incomplete quotes or interpret cell HTML as markup", () => {
		expect(csvMarkdown('Name,Value\n"unfinished', ",", false)).not.toContain("unfinished");
		expect(csvMarkdown("Name,Value\n<script>,a|b\n", ",", false)).toContain("| &lt;script&gt; | a\\|b |");
	});
});

describe("SVG last complete frame", () => {
	it("repairs a partial SVG, sanitizes it and keeps the frame when the next source is invalid", async () => {
		await show(SvgFrame, subject());
		await act(() => pendingImages.at(-1)?.onload?.());
		const first = host.querySelector("img")?.getAttribute("src");
		expect(decodeURIComponent(first ?? "")).toContain("</svg>");
		expect(host.querySelector("img")?.alt).toBe("Poster");
		await show(SvgFrame, subject({ text: '<!DOCTYPE svg><svg></svg>', revision: 2 }));
		expect(host.querySelector("img")?.getAttribute("src")).toBe(first);
		expect(host.textContent).toContain("Waiting for omp to finish saving");
	});
	it("preserves the last good image when a sanitized revision fails to decode", async () => {
		await show(SvgFrame, subject());
		await act(() => pendingImages.at(-1)?.onload?.());
		const first = host.querySelector("img")?.src;
		await show(SvgFrame, subject({ text: '<svg><circle r="50"/></svg>', revision: 2 }));
		await act(() => pendingImages.at(-1)?.onerror?.());
		expect(host.querySelector("img")?.src).toBe(first);
		expect(host.textContent).toContain("Waiting for omp to finish saving");
	});
	it("shows the size note rather than rendering collab-truncated text", async () => {
		await show(SvgFrame, subject({ elided: true }));
		expect(host.querySelector("img")).toBeNull();
		expect(host.textContent).toContain("live.elided");
		expect(pendingImages).toHaveLength(0);
	});
});

describe("Mermaid revision ordering", () => {
	it("drops an old async render, coalesces pending revisions, then shows the newest parsed result", async () => {
		const first = Promise.withResolvers<string>();
		const newest = Promise.withResolvers<string>();
		mermaid.mockReturnValueOnce(first.promise).mockReturnValueOnce(newest.promise);
		await show(MermaidFrame, subject({ format: "mermaid", text: "graph TD; A-->B" }));
		await show(MermaidFrame, subject({ format: "mermaid", text: "graph TD; A-->C", revision: 2 }));
		await show(MermaidFrame, subject({ format: "mermaid", text: "graph TD; A-->D", revision: 3 }));
		expect(mermaid).toHaveBeenCalledTimes(1);
		await act(async () => { first.resolve('<svg><title>Old</title></svg>'); });
		expect(host.querySelector("img")).toBeNull();
		expect(mermaid).toHaveBeenCalledTimes(2);
		expect(mermaid.mock.calls[1][0]).toBe("graph TD; A-->D");
		await act(async () => { newest.resolve('<svg><title>Newest</title></svg>'); });
		expect(host.querySelector("img")?.alt).toBe("Newest");
		const src = host.querySelector("img")?.src;
		mermaid.mockRejectedValueOnce(new Error("Partial statement"));
		await show(MermaidFrame, subject({ format: "mermaid", text: "graph TD; A-->", revision: 4 }));
		expect(host.querySelector("img")?.src).toBe(src);
		expect(host.textContent).toContain("Waiting for omp to finish saving");
	});
});

describe("PDF saves", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	it("retains the previous checked PDF revision when a newer save is incomplete or unreadable", async () => {
		const invoke = vi.fn(async (channel: string, _token: unknown, revision?: number) => {
			if (channel === "preview:grant") return { token: "parent", url: "vomp-preview://parent/report.pdf", assetRoot: false };
			if (channel === "preview:prepare") {
				if (revision === 2) return { ok: false, reason: "missing" };
				if (revision === 3) throw new Error("File is being replaced");
				return { ok: true, pdf: { token: "first", url: "vomp-preview://first/complete.pdf", assetRoot: false } };
			}
		});
		Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
		await showPdf();
		expect(host.textContent).toContain("complete");
		await showPdf(2);
		expect(host.textContent).toContain("complete");
		expect(host.textContent).toContain("Waiting for omp to finish saving");
		expect(host.querySelector("[data-pdf-revision]")?.getAttribute("data-pdf-revision")).toBe("1");
		await showPdf(3);
		expect(host.textContent).toContain("complete");
	});
	it("restores the preceding PDF when the replacement viewer reports an error", async () => {
		const invoke = vi.fn(async (channel: string, _token: unknown, revision?: number) => channel === "preview:grant"
			? { token: "parent", url: "vomp-preview://parent/report.pdf", assetRoot: false }
			: channel === "preview:prepare" ? { ok: true, pdf: { token: revision === 1 ? "first" : "second", url: `vomp-preview://revision/${revision === 1 ? "first" : "second"}.pdf`, assetRoot: false } } : undefined);
		Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
		await showPdf();
		await showPdf(2);
		expect(host.textContent).toContain("second");
		await act(() => host.querySelector("[data-pdf-revision]")?.dispatchEvent(new Event("error")));
		expect(host.textContent).toContain("first");
		expect(host.textContent).toContain("Waiting for omp to finish saving");
		expect(invoke).toHaveBeenCalledWith("preview:revoke", "second");
	});
});
