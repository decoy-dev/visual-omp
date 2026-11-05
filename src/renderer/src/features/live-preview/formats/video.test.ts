// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSubject } from "../types";
import copy from "../../../i18n/en/panes.json";

const env = vi.hoisted(() => ({ revision: 1, error: false, drawImage: vi.fn(), openInFiles: vi.fn() }));
vi.mock("./usePreviewGrant", () => ({ usePreviewGrant: () => ({ error: env.error, frame: { grant: { token: "token", url: "vomp-preview://token/movie.mp4", assetRoot: true }, revision: env.revision } }) }));
vi.mock("../../panes/files-store", () => ({ openInFiles: env.openInFiles }));
vi.mock("../../../ui", () => ({ Button: ({ children, onClick }: { children: string; onClick(): void }) => createElement("button", { onClick }, children) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => {
	let value: unknown = copy;
	for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part];
	return String(value ?? key).replace(/{{(\w+)}}/g, (_, name: string) => String(values?.[name] ?? ""));
} }) }));
import { Frame, keyFrameTimes } from "./video";

let host: HTMLDivElement;
let root: Root;
const subject: LiveSubject = { id: "call:render", kind: "file", format: "video", toolCallId: "render", toolName: "bash", path: "/project/movie.mp4", text: null, revision: 1, state: "saved", elided: false, intent: null, request: null, images: null, progress: null, sequence: null, size: 1000, startedAt: 1, updatedAt: 2 };
const show = async (state: LiveSubject["state"] = "saved") => { await act(async () => root.render(createElement(Frame, { subject: { ...subject, state, revision: env.revision }, projectPath: "/project", related: [] }))); };
const event = async (element: Element, name: string) => { await act(async () => { element.dispatchEvent(new Event(name)); }); };
const pending = () => host.querySelector<HTMLVideoElement>("[data-pending-video]")!;
const player = () => host.querySelector<HTMLVideoElement>("video[controls]");

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	env.revision = 1; env.error = false; env.drawImage.mockReset(); env.openInFiles.mockReset();
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: env.drawImage } as unknown as CanvasRenderingContext2D);
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("video revisions", () => {
	it("plays a decoded revision with native muted inline controls and metadata preload", async () => {
		await show(); expect(player()).toBeNull();
		await event(pending(), "loadeddata");
		expect(player()?.src).toBe("vomp-preview://token/movie.mp4?rev=1");
		expect(player()?.preload).toBe("metadata");
		expect(player()?.hasAttribute("playsinline")).toBe(true);
		expect(player()?.muted).toBe(true);
	});
	it("keeps the last good player on a failed save and accepts a later good revision", async () => {
		await show(); await event(pending(), "loadeddata");
		env.revision = 2; await show();
		await event(pending(), "error");
		expect(player()?.src).toContain("rev=1");
		expect(host.textContent).toContain(copy.live.waitingForSave);
		env.revision = 3; await show(); await event(pending(), "loadeddata");
		expect(player()?.src).toContain("rev=3");
		expect(host.textContent).not.toContain(copy.live.waitingForSave);
	});
	it("shows the codec explanation and offers the saved path in Files", async () => {
		await show(); Object.defineProperty(pending(), "error", { configurable: true, value: { code: 4 } });
		await event(pending(), "error");
		expect(host.textContent).toContain(copy.live.videoUnsupported);
		await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
		expect(env.openInFiles).toHaveBeenCalledWith("/project", "/project/movie.mp4");
	});
	it("never replaces a newer player with a stale pending revision", async () => {
		await show(); const old = pending();
		env.revision = 2; await show(); await event(pending(), "loadeddata");
		await event(old, "loadeddata");
		expect(player()?.src).toContain("rev=2");
	});
});

describe("display-only key frames", () => {
	it("samples six evenly spaced times inside the duration and refuses unknown durations", () => {
		const times = keyFrameTimes(6);
		expect(times).toHaveLength(6); expect(times[0]).toBe(0); expect(times[5]).toBe(5.95);
		for (let index = 1; index < times.length; index++) expect(times[index]! - times[index - 1]!).toBeCloseTo(1.19);
		for (const duration of [0, -1, NaN, Infinity]) expect(keyFrameTimes(duration)).toEqual([]);
	});
	it("draws six tiles without readback and clicking one seeks the player", async () => {
		await show(); await event(pending(), "loadeddata");
		const source = host.querySelector<HTMLVideoElement>("[data-keyframe-source]")!;
		Object.defineProperties(source, { duration: { value: 6 }, readyState: { value: 2 }, videoWidth: { value: 320 }, videoHeight: { value: 240 }, seeking: { value: false } });
		await event(source, "loadedmetadata");
		await event(source, "loadeddata");
		for (let index = 1; index < 6; index++) await event(source, "seeked");
		const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
		expect(buttons).toHaveLength(6); expect(host.querySelectorAll("canvas")).toHaveLength(6);
		expect(env.drawImage).toHaveBeenCalledTimes(12);
		await act(async () => buttons[3]!.click());
		expect(player()?.currentTime).toBeCloseTo(keyFrameTimes(6)[3]!);
		expect(host.querySelector("[aria-label='Key frames']")?.className).toContain("grid-cols-2");
	});
	it("cancels the old extractor and discards stale key frames after a newer revision", async () => {
		await show(); await event(pending(), "loadeddata");
		const old = host.querySelector<HTMLVideoElement>("[data-keyframe-source]")!;
		env.revision = 2; await show(); await event(pending(), "loadeddata");
		expect(old.getAttribute("src")).toBeNull();
		await event(old, "loadedmetadata"); await event(old, "seeked");
		expect(host.querySelectorAll("canvas")).toHaveLength(0);
		expect(host.querySelector<HTMLVideoElement>("[data-keyframe-source]")?.src).toContain("rev=2");
	});
});

it("waits for an incomplete render before reporting an unsupported saved codec", async () => {
	await show("running");
	Object.defineProperty(pending(), "error", { configurable: true, value: { code: 4 } });
	await event(pending(), "error");
	expect(host.textContent).toContain(copy.live.waitingForSave);
	expect(host.textContent).not.toContain(copy.live.videoUnsupported);
	await show("saved");
	expect(host.textContent).toContain(copy.live.videoUnsupported);
});
