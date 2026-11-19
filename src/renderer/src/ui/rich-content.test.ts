// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../transcript/render";
// Preload the chart module during collection so cold loading does not consume vi.waitFor's timeout.
import "./charts/table-chart";
import { hydrateRichContent } from "./rich-content";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); });
const table = "| Model | Tokens |\n| --- | ---: |\n| Alpha | 10 |\n| Beta | 20 |\n| Gamma | 50 |\n| Delta | 80 |";
const WEBP_DATA_URL = "data:image/webp;base64,UklGRoIAAABXRUJQVlA4IHYAAABQDACdASrIAMgAPm02mUmkIyKhIEgAgA2JaW7hdrEbQBPa9FXCDIIaqk122i4QZBDVUmu20XCDIIaqk122i4QZBDVUmu20XCDIIaqk122i4QZBDVUmu20XCDIIaqk122i4QZBDVUmu20WcAAD+/9GgAAAAAAAA";
function mount(source: string, streaming = false, base: string | null = null): HTMLElement {
	const root = document.createElement("div");
	root.style.setProperty("--fg", "rgb(10, 20, 30)");
	root.innerHTML = renderMarkdown(source);
	document.body.append(root);
	cleanups.push(hydrateRichContent(root, streaming, base));
	return root;
}
function mockBridge(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): () => void {
	const previous = Object.getOwnPropertyDescriptor(window, "vomp");
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke } });
	return () => {
		if (previous) Object.defineProperty(window, "vomp", previous);
		else Reflect.deleteProperty(window, "vomp");
	};
}

describe("rich Markdown rendering", () => {
	it.each([
		["`read`", false],
		[`\`${"a".repeat(32)}\``, false],
		[`\`${"a".repeat(33)}\``, true],
		[`\`${"😀".repeat(32)}\``, false],
		[`\`${"😀".repeat(33)}\``, true],
		[`[${"a".repeat(32)}](https://example.test)`, false],
		[`[${"a".repeat(33)}](https://example.test)`, true],
		[`[${"😀".repeat(32)}](https://example.test)`, false],
		[`[${"😀".repeat(33)}](https://example.test)`, true],
		[`[${"&copy;".repeat(6)}](https://example.test)`, false],
		[`[${"&copy;".repeat(33)}](https://example.test)`, true],
		[`[${"a".repeat(16)}**${"b".repeat(16)}**](https://example.test)`, false],
		[`[${"a".repeat(16)}**${"b".repeat(17)}**](https://example.test)`, true],
		[`[many short words many short words many short words](https://example.test)`, false],
		[`[docs](https://example.test/${"long-path/".repeat(20)})`, false],
	] as const)("classifies decoded table token %s with long=%s", (source, long) => {
		const root = mount(`| Token |\n| --- |\n| ${source} |`);
		const token = root.querySelector("td :is(a,code)")!;
		expect(token.hasAttribute("data-wrap-long")).toBe(long);
	});

	it("keeps explicit line breaks as run boundaries and text unchanged", () => {
		const root = document.createElement("div");
		root.innerHTML = `<table><tbody><tr><td><a href="https://example.test">${"a".repeat(20)}<br>${"b".repeat(20)}</a></td></tr></tbody></table>`;
		document.body.append(root);
		const before = root.textContent;
		cleanups.push(hydrateRichContent(root));
		expect(root.querySelector("a")?.hasAttribute("data-wrap-long")).toBe(false);
		expect(root.textContent).toBe(before);
	});

	it.each([false, true])("marks long paths during Markdown hydration with streaming=%s", streaming => {
		const path = `/workspace/${"project/".repeat(20)}report.json`;
		const root = mount(`| Tool | Path |\n| --- | --- |\n| \`read\` | \`${path}\` |`, streaming);
		expect(root.querySelector("td:first-child code")?.hasAttribute("data-wrap-long")).toBe(false);
		expect(root.querySelector("td:nth-child(2) code")?.hasAttribute("data-wrap-long")).toBe(true);
		expect(root.querySelector("td:nth-child(2) code")?.textContent).toBe(path);
	});

	it.each([false, true])("loads raw local images through panes:readFile from the chat folder while streaming=%s", async streaming => {
		const invoke = vi.fn(async (channel: string) => channel === "panes:readFile"
			? { kind: "image", dataUrl: WEBP_DATA_URL, size: 1 }
			: undefined);
		const restore = mockBridge(invoke);
		try {
			const source = '<img src="/var/folders/.../omp-sshots-15d47b138a1e10b6.webp" alt="The previous white picker..." width="45%">';
			const root = mount(source, streaming, "/chat");
			await vi.waitFor(() => expect(root.querySelector("img")?.src).toBe(WEBP_DATA_URL));
			const image = root.querySelector("img")!;
			expect(image.alt).toBe("The previous white picker...");
			expect(image.hasAttribute("tabindex")).toBe(false);
			const fileLink = root.querySelector<HTMLAnchorElement>(".vomp-local-image-file")!;
			expect(fileLink.tabIndex).toBe(0);
			expect(fileLink.dataset.filePath).toBe("/var/folders/.../omp-sshots-15d47b138a1e10b6.webp");
			expect(fileLink.getAttribute("aria-label")).toBe("Open image file: omp-sshots-15d47b138a1e10b6.webp");
			expect(image.style.width).toBe("45%");
			image.dispatchEvent(new Event("load"));
			expect(root.querySelector(".vomp-local-image")?.textContent).toBe("");
			expect(root.querySelector(".vomp-local-image")?.children).toHaveLength(1);
			expect(image.style.backgroundColor).toBe("");
			expect(invoke).toHaveBeenCalledWith("panes:readFile", "/var/folders/.../omp-sshots-15d47b138a1e10b6.webp");
		} finally {
			restore();
		}
	});
	it("keeps non-image paths as links without reading them", async () => {
		const invoke = vi.fn(async () => undefined);
		const restore = mockBridge(invoke);
		try {
			const root = mount('<img src="secret.txt" alt="Secret file">', false, "/chat");
			await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>(".vomp-local-image-file")?.dataset.filePath).toBe("/chat/secret.txt"));
			expect(invoke).not.toHaveBeenCalledWith("panes:readFile", "/chat/secret.txt");
			expect(root.textContent).toContain("Secret file");
		} finally {
			restore();
		}
	});
	it("ignores a failed image read after the chat folder changes", async () => {
		const staleRead = Promise.withResolvers<unknown>();
		const invoke = vi.fn((channel: string, ...args: unknown[]): Promise<unknown> => {
			if (channel !== "panes:readFile") return Promise.resolve(undefined);
			return args[0] === "/old/picture.webp"
				? staleRead.promise
				: Promise.resolve({ kind: "image", dataUrl: WEBP_DATA_URL, size: 1 });
		});
		const restore = mockBridge(invoke);
		try {
			const root = mount('<img src="picture.webp" alt="Picture">', false, "/old");
			await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("panes:readFile", "/old/picture.webp"));
			cleanups.push(hydrateRichContent(root, false, "/new"));
			await vi.waitFor(() => expect(root.querySelector("img")?.src).toBe(WEBP_DATA_URL));
			const image = root.querySelector("img")!;
			image.dispatchEvent(new Event("load"));
			expect(root.querySelector<HTMLAnchorElement>(".vomp-local-image-file")?.dataset.filePath).toBe("/new/picture.webp");
			staleRead.reject(new Error("old image read failed"));
			await Promise.resolve();
			await Promise.resolve();
			expect(root.querySelector("img")).toBe(image);
			expect(root.querySelector<HTMLAnchorElement>(".vomp-local-image-file")?.dataset.filePath).toBe("/new/picture.webp");
			expect(root.querySelector(".vomp-local-image")?.textContent).toBe("");
		} finally {
			restore();
		}
	});
	it("expands home-relative raw image paths before reading them", async () => {
		const invoke = vi.fn(async (channel: string) => channel === "app:info"
			? { homeDir: "/Users/example" }
			: channel === "panes:readFile"
				? { kind: "image", dataUrl: WEBP_DATA_URL, size: 1 }
				: undefined);
		const restore = mockBridge(invoke);
		try {
			const root = mount('<img src="~/Pictures/grey-dot.webp" alt="Grey dot">', false, "/chat");
			await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("panes:readFile", "/Users/example/Pictures/grey-dot.webp"));
			expect(root.querySelector("img")?.alt).toBe("Grey dot");
		} finally {
			restore();
		}
	});

	it("keeps alt text and a Files link when a local image cannot be read", async () => {
		const restore = mockBridge(async () => { throw new Error("missing image"); });
		try {
			const root = mount('<img src="assets/missing.webp" alt="Preview unavailable">', false, "/chat");
			await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>(".vomp-local-image-file")?.dataset.filePath).toBe("/chat/assets/missing.webp"));
			expect(root.textContent).toContain("Preview unavailable");
			expect(root.querySelector(".vomp-local-image-file")?.textContent).toBe("Open image file");
			expect(root.querySelector("img")).toBeNull();
		} finally {
			restore();
		}
	});

	it("turns local iframe HTML into a Files link card without creating an iframe", async () => {
		const restore = mockBridge(async () => undefined);
		try {
			const root = mount('<iframe src="reports/index.html" title="Build report"></iframe>', false, "/chat");
			await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>(".vomp-iframe-link")?.dataset.filePath).toBe("/chat/reports/index.html"));
			expect(root.querySelector("iframe")).toBeNull();
			expect(root.querySelector(".vomp-iframe-link")?.textContent).toBe("Build report");
		} finally {
			restore();
		}
	});

	it("draws data image URIs with focus and drops unsafe raw image attributes", () => {
		const root = mount('<img src="data:image/png;base64,YQ==" alt="Pixel" width="64px" onerror="run()" style="color:red" srcset="large.png 2x">');
		const image = root.querySelector("img")!;
		expect(image.src).toBe("data:image/png;base64,YQ==");
		expect(image.tabIndex).toBe(0);
		expect(image.style.width).toBe("64px");
		expect(image.hasAttribute("onerror")).toBe(false);
		expect(image.hasAttribute("style")).toBe(true);
		expect(image.style.color).toBe("");
		expect(image.hasAttribute("srcset")).toBe(false);
		const unsafe = mount('<img src="javascript:alert(1)" alt="Blocked">');
		expect(unsafe.querySelector("img")).toBeNull();
		expect(unsafe.textContent).toContain("Blocked");
	});

	it("renders SVG as an isolated image while retaining accessible source", () => {
		const root = mount('```svg\n<svg viewBox="0 0 400 100"><text fill="currentColor">Request</text></svg>\n```');
		expect(root.querySelector("img")?.alt).toBe("SVG figure");
		expect(root.querySelector("img")?.src).toMatch(/^data:image\/svg\+xml/);
		expect(root.querySelector("details")?.open).toBe(false);
		expect(root.querySelector("pre code")?.textContent).toContain("Request");
	});

	it("exposes SVG titles and descriptions on the outer image and names its scroll region", () => {
		const root = mount('```svg\n<svg viewBox="0 0 1000 100"><title>Request pipeline</title><desc>A request becomes a completed result.</desc><text>Request</text></svg>\n```');
		const image = root.querySelector("img")!;
		expect(image.alt).toBe("Request pipeline");
		expect(image.getAttribute("aria-description")).toBe("A request becomes a completed result.");
		expect(root.querySelector("[data-diagram-image]")?.getAttribute("aria-label")).toBe("Request pipeline");
		expect(root.querySelector<HTMLElement>("[data-diagram-image]")?.tabIndex).toBe(0);
	});

	it("exposes Mermaid's generated accessibility references on the outer image", () => {
		const root = mount('```svg\n<svg viewBox="0 0 640 100" aria-labelledby="chart-title" aria-describedby="chart-description"><title id="chart-title">Release workflow</title><desc id="chart-description">Validate the change before publishing.</desc><text>Validate</text></svg>\n```');
		expect(root.querySelector("img")?.alt).toBe("Release workflow");
		expect(root.querySelector("img")?.getAttribute("aria-description")).toBe("Validate the change before publishing.");
	});

	it("uses an explicit SVG aria-label before its title", () => {
		const root = mount('```svg\n<svg viewBox="0 0 640 100" aria-label="Selected flow"><title>General flow</title><text>Flow</text></svg>\n```');
		expect(root.querySelector("img")?.alt).toBe("Selected flow");
	});

	it("preserves punctuation in authored accessibility text without applying CSS token replacement", () => {
		const root = mount('```svg\n<svg viewBox="0 0 640 100" aria-label="Queue &lt;5 requests @ worker" aria-description="Use var(--fg) for text."><text>Queue</text></svg>\n```');
		expect(root.querySelector("img")?.alt).toBe("Queue <5 requests @ worker");
		expect(root.querySelector("img")?.getAttribute("aria-description")).toBe("Use var(--fg) for text.");
	});

	it("shows failed SVG source instead of losing the reply", () => {
		const root = mount("```svg\nnot an SVG\n```");
		expect(root.querySelector("details")?.open).toBe(true);
		expect(root.textContent).toContain("This diagram could not be drawn.");
		expect(root.querySelector("pre code")?.textContent).toBe("not an SVG\n");
	});

	it("repairs incomplete SVG while its fence streams, without repairing a closed invalid drawing", () => {
		const partial = '```svg\n<svg viewBox="0 0 400 100"><g><text>Request';
		const root = mount(partial, true);
		expect(root.querySelector("img")).not.toBeNull();
		expect(decodeURIComponent(root.querySelector("img")!.src)).toMatch(/Request\s*<\/text><\/g><\/svg>/);
		const closed = mount(`${partial}\n\`\`\``, true);
		expect(closed.querySelector("img")).toBeNull();
		expect(closed.querySelector("details")?.open).toBe(true);
	});

	it("defers an incomplete Mermaid fence rather than rendering each partial graph", () => {
		const root = mount("```mermaid\nflowchart LR\nA -->", true);
		expect(root.querySelector("img")).toBeNull();
		expect(root.textContent).not.toContain("could not be drawn");
	});

	it("charts completed tables without replacing their data", async () => {
		const root = mount(table);
		const original = root.querySelector("table");
		await vi.waitFor(() => expect(root.querySelector(".vomp-chart svg")).not.toBeNull());
		expect(root.querySelector("table")).toBe(original);
		expect(root.querySelectorAll("tbody tr")).toHaveLength(4);
		expect(root.querySelector(".vomp-chart svg")?.getAttribute("aria-label")).toBeTruthy();
	});

	it("matches omp's top-level-only table chart scope", () => {
		const quoted = mount(table.split("\n").map(line => `> ${line}`).join("\n"));
		const nested = mount(`- Comparison\n\n${table.split("\n").map(line => `  ${line}`).join("\n")}`);
		expect(quoted.querySelector("blockquote table")).not.toBeNull();
		expect(nested.querySelector("li table")).not.toBeNull();
		expect(quoted.querySelector("[data-table-chart]")).toBeNull();
		expect(nested.querySelector("[data-table-chart]")).toBeNull();
	});

	it("waits for the last streaming table to close, then charts the same table", async () => {
		const root = mount(table, true);
		expect(root.querySelector(".vomp-chart svg")).toBeNull();
		const original = root.querySelector("table");
		root.insertAdjacentHTML("beforeend", "<p>Finished comparison.</p>");
		cleanups.push(hydrateRichContent(root, true));
		await vi.waitFor(() => expect(root.querySelector(".vomp-chart svg")).not.toBeNull());
		expect(root.querySelector("table")).toBe(original);
	});

	it("can resume a chart import after an effect is disposed mid-load", async () => {
		const root = mount(table);
		cleanups.pop()?.();
		cleanups.push(hydrateRichContent(root));
		await vi.waitFor(() => expect(root.querySelector(".vomp-chart svg")).not.toBeNull());
	});
});
