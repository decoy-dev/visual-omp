// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import copy from "../../i18n/en/panes.json";

const env = vi.hoisted(() => {
	const invoke = vi.fn();
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke, on: () => () => {} } });
	return { invoke, kind: "text", livePreview: false };
});
vi.mock("../../state/app", () => ({
	dockKey: () => "chat",
	useApp: { subscribe: () => () => {}, getState: () => ({ tabs: [{ id: "chat" }], prefs: { livePreview: env.livePreview }, showPane() {} }) },
}));
vi.mock("../../ui", () => ({
	cn: (...values: unknown[]) => values.filter(Boolean).join(" "), duration: {}, ease: {}, spring: {},
	Button: ({ children, onClick }: { children: ReactNode; onClick(): void }) => createElement("button", { onClick }, children),
	IconButton: ({ label, onClick }: { label: string; onClick(): void }) => createElement("button", { "aria-label": label, onClick }),
	Segmented: ({ value, options, onValueChange }: { value: string; options: { value: string; label: string }[]; onValueChange(value: string): void }) => createElement("div", null, options.map(option => createElement("button", { key: option.value, "aria-pressed": option.value === value, onClick: () => onValueChange(option.value) }, option.label))),
	EmptyState: ({ title, body }: { title: string; body: string }) => createElement("p", null, title, body),
	Expand: ({ children, open }: { children: ReactNode; open: boolean }) => open ? children : null,
	PresenceSwap: ({ children }: { children: ReactNode }) => children,
	Spinner: () => null,
}));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));
vi.mock("../../ui/contextActions", () => ({ mentionInChat: vi.fn(), revealLabel: () => "Show in folder", openWithDefaultApp: (path: string, _t: unknown, target?: string) => env.invoke("app:openFile", path, target) }));
vi.mock("../../ui/TargetContextMenu", () => ({ TargetContextMenu: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../registry/lazy", async () => {
	// Exercise the Files chunk's adapter-loading boundary without idle preloading the app.
	const { Frame } = await import("../live-preview/formats/html");
	return { lazyView: () => Frame, LoadFailed: () => null };
});
vi.mock("../projects/folders/homeDir", () => ({ useHomeDir: () => null }));
vi.mock("./git-store", () => ({ useGit: () => ({ version: 0 }) }));
vi.mock("./media", () => ({
	ExpandPreview: () => null, PdfFrame: () => createElement("iframe", { title: "PDF" }),
	MediaPlayer: ({ kind }: { kind: string }) => createElement(kind),
	PreviewImage: () => null, ThumbnailFrame: () => null, Unavailable: () => null,
	ZoomImage: ({ src, alt }: { src: string; alt: string }) => createElement("img", { src, alt }),
}));
vi.mock("./common", () => ({
	PaneToolbar: ({ children }: { children: ReactNode }) => createElement("div", null, children),
	TabStrip: () => null, Section: () => null, SectionCount: () => null,
	relativePath: (root: string, path: string) => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
	usePaneVisible: () => true,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => {
	let value: unknown = copy;
	for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part];
	return String(value ?? key);
} }) }));
import { FilesPane } from "./FilesPane";
import { EMPTY_VIEW, useFiles } from "./files-store";

let root: Root;
let host: HTMLDivElement;
async function show(path: string) {
	useFiles.setState({ byView: { chat: { ...EMPTY_VIEW, tabs: [path], active: path, treeHidden: true } }, children: { "/project": [] } });
	await act(async () => { root.render(createElement(FilesPane, { session: { tabId: "chat" }, projectPath: "/project" } as Parameters<typeof FilesPane>[0])); });
	await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
function button(text: string) { return [...host.querySelectorAll("button")].find(item => item.textContent === text)!; }
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.useFakeTimers();
	host = document.createElement("div");
	root = createRoot(host);
	env.kind = "text";
	env.livePreview = false;
	env.invoke.mockReset().mockImplementation(async (channel: string) => {
		if (channel === "panes:inspect") {
			if (env.kind === "folder") throw new Error("Not a file");
			if (["image", "video", "audio", "pdf"].includes(env.kind)) return { kind: "media", media: env.kind, size: 120 * 1024 * 1024 };
			return { kind: env.kind, size: 30, text: "<h1>Saved HTML source</h1>" };
		}
		if (channel === "preview:grant") return { token: "token", url: "vomp-preview://token/page.html", assetRoot: true };
		if (channel === "preview:prepare") return { ok: true, policy: { scripts: false, network: false } };
		if (channel === "fs:list") return [];
	});
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke: env.invoke, on: () => () => {} } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("HTML Files viewer routing", () => {
	it.each(["page.html", "PAGE.HTM"])("previews %s with live previews off and retains the browser action", async name => {
		await show(`/project/${name}`);
		expect(env.livePreview).toBe(false);
		expect(env.invoke).toHaveBeenCalledWith("preview:grant", { path: `/project/${name}`, root: "/project", related: [] });
		expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
		expect(host.textContent).toContain("Scripts and network access are off");
		await act(async () => button("Open in browser").click());
		expect(env.invoke).toHaveBeenCalledWith("app:openFile", `/project/${name}`, "browser");
	});
	it("switches to source and revokes its preview, then previews again", async () => {
		await show("/project/page.html");
		await act(async () => button("Source").click());
		expect(host.querySelector("iframe")).toBeNull();
		expect(host.textContent).toContain("<h1>Saved HTML source</h1>");
		expect(env.invoke).toHaveBeenCalledWith("preview:revoke", "token");
		await act(async () => button("Preview").click());
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		expect(host.querySelector("iframe")).not.toBeNull();
	});
	it("reloads a saved HTML document explicitly instead of retaining its old preview", async () => {
		await show("/project/page.html");
		const first = host.querySelector("iframe")!;
		await act(() => first.dispatchEvent(new Event("load")));
		await act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Reload this file"]')!.click());
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		const refreshed = host.querySelector("iframe")!;
		expect(refreshed).not.toBe(first);
		expect(env.invoke.mock.calls.filter(call => call[0] === "preview:grant")).toHaveLength(2);
		expect(env.invoke).toHaveBeenCalledWith("preview:revoke", "token");
		expect(env.invoke).toHaveBeenLastCalledWith("preview:prepare", "token", 2);
	});
	it("does not preview a folder whose name ends in HTML", async () => {
		env.kind = "folder";
		await show("/project/archive.html");
		expect(host.querySelector("iframe")).toBeNull();
		expect(env.invoke.mock.calls.some(call => call[0] === "preview:grant")).toBe(false);
	});
	it("keeps non-HTML text in the code viewer", async () => {
		await show("/project/page.txt");
		expect(host.querySelector("iframe")).toBeNull();
		expect(host.textContent).toContain("<h1>Saved HTML source</h1>");
	});
});

describe("large local media routing", () => {
	it.each([["movie.mp4", "video"], ["song.m4a", "audio"], ["poster.png", "image"], ["report.pdf", "pdf"]])("routes %s to its viewer without a whole-file read", async (name, kind) => {
		env.kind = kind;
		await show(`/project/${name}`);
		expect(host.querySelector(kind === "image" ? "img" : kind === "pdf" ? "iframe" : kind)).not.toBeNull();
		expect(env.invoke.mock.calls.some(call => call[0] === "panes:readFile" || call[0] === "panes:readPdf")).toBe(false);
		if (kind === "image") expect(env.invoke).toHaveBeenCalledWith("preview:grant", { path: `/project/${name}`, root: null, related: [], fileOnly: true });
	});
	it("shows a bounded text prefix with an external-open action", async () => {
		env.invoke.mockImplementation(async (channel: string) => channel === "panes:inspect" ? { kind: "text", text: "Start of large text", size: 50_000_000, truncated: true } : undefined);
		await show("/project/large.txt");
		expect(host.textContent).toContain("Start of large text");
		expect(host.textContent).toContain("Showing the first 2 MB");
		await act(async () => button(copy.outputs.openDefault).click());
		expect(env.invoke).toHaveBeenCalledWith("app:openFile", "/project/large.txt", undefined);
	});
});
