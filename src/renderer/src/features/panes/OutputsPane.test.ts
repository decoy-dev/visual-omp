// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import type { ChatOutput } from "./derive";
import type * as Media from "./media";
import type * as Common from "./common";
import { openFile } from "../../ui/contextActions";
import copy from "../../i18n/en/panes.json";
const fixture = vi.hoisted(() => {
	// happy-dom's WAAPI cancellation rejects unlike Chromium. Exercise Motion's real JS fallback on one virtual clock.
	const animate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
	Reflect.deleteProperty(Element.prototype, "animate");
	vi.useFakeTimers();
	return { outputs: [] as ChatOutput[], animate };
});
vi.mock("../../shell/hooks", () => ({ useSessionView: () => null }));
vi.mock("../../state/app", () => ({ useApp: (select: (state: { prefs: { livePreview: boolean } }) => boolean) => select({ prefs: { livePreview: true } }), currentDock: () => ({ pane: "outputs" }), useDockVisible: () => true }));
vi.mock("../live-preview/store", () => ({ usePreviewChat: () => ({}), visibleSubjects: () => [{}], followedSubject: () => ({ format: "image" }) }));
vi.mock("../live-preview/Stage", () => ({ Stage: () => createElement("section", { "aria-label": "Live output" }) }));
vi.mock("../live-preview/loader", () => ({ TrackerLoadNotice: () => null }));
vi.mock("./outputs-store", () => ({ countOutputsMount: () => 1, useChatOutputs: () => ({ outputs: fixture.outputs }) }));
vi.mock("../../ui/TargetContextMenu", () => ({ TargetContextMenu: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../ui/contextActions", () => ({ copyText: vi.fn(), openFile: vi.fn(), openWithDefaultApp: vi.fn(), revealLabel: () => "Reveal" }));
vi.mock("./common", async importOriginal => ({
	relativePath: (await importOriginal<typeof Common>()).relativePath,
	FileName: ({ name }: { name: string }) => name,
	PaneToolbar: ({ children }: { children: ReactNode }) => createElement("div", null, children),
	Section: ({ children }: { children: ReactNode }) => createElement("section", null, children),
	SectionCount: () => null,
	listRowMotion: {},
}));
// Keep the actual PDF frame, dialog and transitions; only avoid decoding images in happy-dom.
vi.mock("./media", async importOriginal => ({ ...await importOriginal<typeof Media>(),
	PreviewImage: ({ alt }: { alt: string }) => createElement("img", { alt }),
	useNearView: () => [{ current: null }, true],
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => {
	let value: unknown = copy; for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part];
	return String(value ?? key).replace(/{{(\w+)}}/g, (_, name: string) => String(values?.[name] ?? ""));
} }) }));
import { OutputsPane } from "./OutputsPane";
import { MotionProvider, TooltipProvider } from "../../ui";
let host: HTMLDivElement, root: Root;
const image: ChatOutput = { key: "/project/tall.png", path: "/project/tall.png", kind: "image", tool: "write", action: "written", produced: true, relation: "written", time: 1, inline: null };
const pdf: ChatOutput = { ...image, key: "/project/report.pdf", path: "/project/report.pdf", kind: "pdf" };
async function until(predicate: () => boolean) {
	for (let frame = 0; !predicate() && frame < 125; frame++) await act(async () => { await vi.advanceTimersByTimeAsync(20); });
	expect(predicate()).toBe(true);
}
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const tile = (path: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.title === path)!;
async function show(projectPath = "/project") {
	// The controller's view subscription is supplied above; only its folder/id are read here.
	const session = { tabId: "chat", projectPath } as SessionController;
	await act(async () => root.render(createElement(MotionProvider, null, createElement(TooltipProvider, null, createElement(OutputsPane, { session, projectPath })))));
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	document.documentElement.dataset.motion = "reduced";
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke: vi.fn(async (channel: string) => channel === "preview:grant" ? { token: "pdf", url: "vomp-preview://pdf/report.pdf", assetRoot: false } : channel === "preview:prepare" ? { ok: true } : null), on: () => () => {} } });
	fixture.outputs = [image, pdf];
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); await vi.advanceTimersByTimeAsync(300); }); host.remove(); delete document.documentElement.dataset.motion; vi.unstubAllGlobals(); });
afterAll(() => { if (fixture.animate) Object.defineProperty(Element.prototype, "animate", fixture.animate); vi.useRealTimers(); });
it.each(["button", "Escape"])("focuses the saved viewer and returns to its image tile with %s", async action => {
	await show();
	const opener = tile(image.path!); opener.focus();
	await act(async () => opener.click());
	await until(() => document.activeElement === button(copy.outputs.back));
	expect(host.querySelector('[aria-label="Live output"]')).toBeNull();
	expect(host.querySelector('img[alt="tall.png"]')).not.toBeNull();
	if (action === "button") await act(async () => button(copy.outputs.back).click());
	else await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	await until(() => document.activeElement === tile(image.path!));
	expect(host.querySelector('[aria-label="Live output"]')).not.toBeNull();
});
it("returns focus from the expanded layer, then switches to a saved PDF and back to its tile", async () => {
	await show();
	await act(async () => tile(image.path!).click());
	await until(() => document.activeElement === button(copy.outputs.back));
	const expand = button(copy.files.expand); expand.focus();
	await act(async () => expand.click());
	await until(() => Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)));
	await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	await until(() => !document.querySelector('[role="dialog"]') && document.activeElement === expand);
	await act(async () => button(copy.outputs.back).click());
	await until(() => document.activeElement === tile(image.path!));
	await act(async () => tile(pdf.path!).click());
	await until(() => Boolean(host.querySelector("iframe")) && document.activeElement === button(copy.outputs.back));
	expect(host.querySelector("iframe")?.src).toContain("vomp-preview://pdf/report.pdf");
	await act(async () => button(copy.outputs.back).click());
	await until(() => document.activeElement === tile(pdf.path!));
});

it.each([
	["/project", "/project/Large Media Files/Large video.mp4", "Large Media Files/Large video.mp4"],
	["/project/", "/project/notes.txt", "notes.txt"],
	["/project", "/project-other/Large video.mp4", "/project-other/Large video.mp4"],
	["/project", "/other/Large video.mp4", "/other/Large video.mp4"],
	["C:\\Project\\", "C:\\Project\\Large Media Files\\Large video.mp4", "Large Media Files/Large video.mp4"],
	["C:\\Project", "C:\\Project\\notes.txt", "notes.txt"],
	["C:\\Project", "D:\\Media\\Large video.mp4", "D:\\Media\\Large video.mp4"],
] as const)("shows the shared path label under %s while retaining the absolute target %s", async (projectPath, path, shown) => {
	fixture.outputs = [{ ...image, key: path, path, kind: "file" }];
	await show(projectPath);
	const row = tile(path);
	expect(row.textContent).toContain(shown);
	if (shown !== path) expect(row.textContent).not.toContain(projectPath.replace(/[\\/]+$/, ""));
	expect(row.title).toBe(path);
	expect(row.getAttribute("data-context-path")).toBe(path);
	vi.mocked(openFile).mockClear();
	await act(async () => row.click());
	expect(openFile).toHaveBeenCalledExactlyOnceWith(path, projectPath);
});
