// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSubject } from "../types";
import copy from "../../../i18n/en/panes.json";

const env = vi.hoisted(() => ({ revision: 1, reduced: false, error: false, drawImage: vi.fn(), openInFiles: vi.fn() }));
vi.mock("./usePreviewGrant", () => ({ usePreviewGrant: () => ({ error: env.error, frame: { grant: { token: "token", url: "vomp-preview://token/movie.mp4", assetRoot: true }, revision: env.revision } }) }));
vi.mock("../../panes/files-store", () => ({ openInFiles: env.openInFiles }));
vi.mock("./image", () => ({ Frame: ({ subject }: { subject: LiveSubject }) => createElement("img", { src: subject.path!, alt: "Latest input frame" }) }));
vi.mock("../../../ui", () => ({ Button: ({ children, onClick }: { children: string; onClick(): void }) => createElement("button", { onClick }, children) }));
vi.mock("../../../ui/motion", () => ({ useMotionReduced: () => env.reduced }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => {
	let value: unknown = copy;
	for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part];
	return String(value ?? key).replace(/{{(\w+)}}/g, (_, name: string) => String(values?.[name] ?? ""));
} }) }));
import { Frame, keyFrameTimes, videoRevisionTime } from "./video";

let host: HTMLDivElement;
let root: Root;
const subject: LiveSubject = { id: "call:render", kind: "file", format: "video", toolCallId: "render", toolName: "bash", path: "/project/movie.mp4", text: null, revision: 1, state: "saved", elided: false, intent: null, request: null, images: null, progress: null, sequence: null, size: 1000, startedAt: 1, updatedAt: 2 };
const show = async (state: LiveSubject["state"] = "saved", extra: Partial<LiveSubject> = {}) => { await act(async () => root.render(createElement(Frame, { subject: { ...subject, state, revision: env.revision, ...extra }, projectPath: "/project", related: [] }))); };
const event = async (element: Element, name: string) => { await act(async () => { element.dispatchEvent(new Event(name, { bubbles: true })); }); };
const pending = () => host.querySelector<HTMLVideoElement>("[data-pending-video]")!;
const player = () => host.querySelector<HTMLVideoElement>("video[controls]");

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	env.revision = 1; env.reduced = false; env.error = false; env.drawImage.mockReset(); env.openInFiles.mockReset();
	vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(0.01);
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: env.drawImage } as unknown as CanvasRenderingContext2D);
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("video revisions", () => {
	it("reattaches src after StrictMode reruns effects on the same element", async () => {
		await act(async () => root.render(createElement(StrictMode, null,
			createElement(Frame, { subject: { ...subject, state: "running" }, projectPath: "/project", related: [] }))));
		const media = pending();
		expect(vi.mocked(HTMLMediaElement.prototype.load).mock.contexts).toContain(media);
		expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(media);
		expect(media.getAttribute("src")).toBe("vomp-preview://token/movie.mp4?rev=1");
		await event(media, "loadeddata");
		expect(player()).toBe(media);
		expect(media.getAttribute("src")).toBe("vomp-preview://token/movie.mp4?rev=1");
	});
	it("plays a decoded revision with native muted inline controls and metadata preload", async () => {
		await show(); expect(player()).toBeNull();
		await event(pending(), "loadeddata");
		expect(player()?.src).toBe("vomp-preview://token/movie.mp4?rev=1");
		expect(player()?.preload).toBe("metadata");
		expect(player()?.hasAttribute("playsinline")).toBe(true);
		expect(player()?.muted).toBe(true);
	});
	it.each([
		{ width: 640, height: 360, fittedWidth: 496, fittedHeight: 279 },
		{ width: 360, height: 1800, fittedWidth: 251.8, fittedHeight: 1259 },
	])("keeps a $width by $height player at its fitted aspect ratio above the key frames", async size => {
		await show();
		const viewport = host.firstElementChild!;
		Object.defineProperties(viewport, { clientWidth: { value: 496 }, clientHeight: { value: 1449 } });
		Object.defineProperty(viewport.lastElementChild!, "clientHeight", { value: 190 });
		Object.defineProperties(pending(), { videoWidth: { value: size.width }, videoHeight: { value: size.height } });
		await event(pending(), "loadeddata");
		expect(parseFloat(player()!.style.width)).toBeCloseTo(size.fittedWidth);
		expect(parseFloat(player()!.style.height)).toBeCloseTo(size.fittedHeight);
	});
	it("reserves a usable player and asks the outer stage to grow when the strip exceeds its budget", async () => {
		const onHeight = vi.fn();
		await act(async () => root.render(createElement(Frame, { subject, projectPath: "/project", related: [], availableHeight: 200, onHeight })));
		const viewport = host.firstElementChild!;
		Object.defineProperties(viewport, { clientWidth: { value: 320 }, clientHeight: { value: 200 } });
		Object.defineProperty(viewport.lastElementChild!, "clientHeight", { value: 190 });
		Object.defineProperties(pending(), { videoWidth: { value: 640 }, videoHeight: { value: 360 } });
		await event(pending(), "loadeddata");
		expect(parseFloat(player()!.style.height)).toBe(128);
		expect(onHeight).toHaveBeenLastCalledWith(318, 318);
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
	it("shows the declared input frame until the movie decodes", async () => {
		await show("running", { videoFrame: { path: "/project/frames/frame0002.png", mtimeMs: 2 } });
		expect(host.querySelector("img")?.getAttribute("src")).toBe("/project/frames/frame0002.png");
		await event(pending(), "error");
		expect(host.querySelector("img")).not.toBeNull();
		await event(pending(), "loadeddata");
		expect(host.querySelector("img")).toBeNull();
	});
	it("follows each growing revision only after its newest frame decodes, without remounting it", async () => {
		await show("running");
		const first = pending();
		Object.defineProperty(first, "duration", { value: 2 });
		await event(first, "loadeddata");
		expect(player()).toBeNull();
		expect(first.currentTime).toBeCloseTo(1.9);
		await event(first, "seeked");
		expect(player()).toBe(first);
		expect(host.querySelector("[data-keyframe-source]")).toBeNull();
		env.revision = 2; await show("running");
		const second = pending();
		Object.defineProperty(second, "duration", { value: 4 });
		await event(second, "loadeddata");
		expect(player()).toBe(first);
		expect(second.currentTime).toBeCloseTo(3.9);
		await event(second, "seeked");
		expect(player()).toBe(second);
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
	});
	it("bounds live positions and preserves saved-video positions", () => {
		expect(videoRevisionTime(4, 1, true)).toBe(3.9);
		expect(videoRevisionTime(4, 1, false)).toBe(1);
		expect(videoRevisionTime(4, 9, false)).toBe(3.9);
		expect(videoRevisionTime(Infinity, 1, true)).toBe(0);
	});
	it("stops following after a pause and resumes only through Follow render", async () => {
		await show("running"); await event(pending(), "loadeddata");
		const first = player()!;
		await event(first, "pause");
		env.revision = 2; await show("running");
		expect(player()).toBe(first);
		expect(pending()).toBeNull();
		const resume = [...host.querySelectorAll("button")].find(button => button.textContent === copy.live.followRender)!;
		await act(async () => resume.click());
		expect(pending()).not.toBeNull();
		await event(pending(), "loadeddata");
		expect(player()).not.toBe(first);
	});
	it("keeps keyboard seeking under user control across later revisions", async () => {
		await show("running"); await event(pending(), "loadeddata");
		const first = player()!;
		Object.defineProperty(first, "duration", { value: 6 });
		await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
		first.currentTime = 0.5;
		await event(first, "seeking");
		env.revision = 2; await show("running");
		expect(player()).toBe(first);
		expect(first.currentTime).toBe(0.5);
		expect(pending()).toBeNull();
		expect(host.textContent).toContain(copy.live.followRender);
	});
	it("does not auto-seek, auto-play or replace the player's timeline with reduced motion", async () => {
		env.reduced = true;
		await show("running");
		const first = pending();
		Object.defineProperty(first, "duration", { value: 4 });
		await event(first, "loadeddata");
		expect(player()).toBe(first);
		expect(first.currentTime).toBe(0);
		expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
		env.revision = 2; await show("running");
		expect(player()).toBe(first);
		expect(pending()).toBeNull();
	});
	it("loads the completed movie explicitly under reduced motion, preserving position and staying paused", async () => {
		env.reduced = true;
		await show("running");
		const first = pending();
		Object.defineProperty(first, "duration", { value: 2 });
		await event(first, "loadeddata");
		first.currentTime = 1.25;
		env.revision = 2; await show("saved");
		expect(player()).toBe(first);
		expect(pending()).toBeNull();
		const load = [...host.querySelectorAll("button")].find(button => button.textContent === copy.live.loadLatestVideo)!;
		expect(load).toBeDefined();
		await act(async () => load.click());
		const complete = pending();
		Object.defineProperty(complete, "duration", { value: 6 });
		await event(complete, "loadeddata");
		expect(player()).toBe(first);
		expect(complete.currentTime).toBe(1.25);
		await event(complete, "seeked");
		expect(player()).toBe(complete);
		expect(complete.currentTime).toBe(1.25);
		expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
		expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(complete);
	});
	it("defers promotion while native controls have focus", async () => {
		await show("running"); await event(pending(), "loadeddata");
		const first = player()!;
		await event(first, "focusin");
		env.revision = 2; await show("running");
		const candidate = pending();
		Object.defineProperty(candidate, "readyState", { value: 2 });
		await event(candidate, "loadeddata");
		expect(player()).toBe(first);
		await event(first, "focusout");
		expect(player()).toBe(candidate);
	});
	it("does not promote the same-duration candidate behind the visible playback position", async () => {
		await show("running"); await event(pending(), "loadeddata");
		const first = player()!;
		Object.defineProperties(first, { duration: { value: 2 }, paused: { value: false } });
		first.currentTime = 2;
		env.revision = 2; await show("running");
		const candidate = pending();
		Object.defineProperty(candidate, "duration", { value: 2 });
		await event(candidate, "loadeddata");
		await event(candidate, "seeked");
		expect(player()).toBe(first);
		expect(first.currentTime).toBe(2);
	});
	it("rechecks the visible position when a delayed seek completes", async () => {
		await show("running"); await event(pending(), "loadeddata");
		const first = player()!;
		Object.defineProperties(first, { duration: { value: 6 }, paused: { value: false } });
		first.currentTime = 1;
		env.revision = 2; await show("running");
		const candidate = pending();
		Object.defineProperty(candidate, "duration", { value: 4 });
		await event(candidate, "loadeddata");
		first.currentTime = 4;
		await event(candidate, "seeked");
		expect(player()).toBe(first);
	});
	it("does not promote a zero-position replacement with unknown duration", async () => {
		await show("running"); await event(pending(), "loadeddata");
		const first = player()!;
		env.revision = 2; await show("running");
		Object.defineProperty(pending(), "duration", { value: Infinity });
		await event(pending(), "loadeddata");
		expect(player()).toBe(first);
	});
	it("replaces speculative old-file playback when the new render reports its first saved bytes", async () => {
		await show("running", { size: null });
		const first = pending();
		Object.defineProperty(first, "duration", { value: 6 });
		await event(first, "loadeddata"); await event(first, "seeked");
		first.currentTime = 4;
		Object.defineProperty(first, "paused", { value: false });
		env.revision = 2; await show("running", { size: 776 });
		const fragment = pending();
		Object.defineProperty(fragment, "duration", { value: 2 });
		await event(fragment, "loadeddata"); await event(fragment, "seeked");
		expect(player()).toBe(fragment);
		expect(fragment.currentTime).toBeCloseTo(1.9);
	});
	it.each(["pause", "seeking"])("preserves deliberate %s across the first snapshot and shrinkage in one call", async interaction => {
		await show("running", { size: null });
		const first = pending();
		Object.defineProperty(first, "duration", { value: 6 });
		await event(first, "loadeddata"); await event(first, "seeked");
		first.currentTime = 3;
		await event(first, interaction);
		const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
		env.revision = 2; await show("running", { size: 776 });
		expect(player()).toBe(first);
		expect(pending()).toBeNull();
		env.revision = 3; await show("running", { size: 500 });
		expect(player()).toBe(first);
		expect(pending()).toBeNull();
		expect(first.currentTime).toBe(3);
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
		const resume = [...host.querySelectorAll("button")].find(button => button.textContent === copy.live.followRender)!;
		await act(async () => resume.click());
		const next = pending();
		Object.defineProperty(next, "duration", { value: 2 });
		await event(next, "loadeddata"); await event(next, "seeked");
		expect(player()).toBe(next);
	});
	it("starts another timeline when a finished movie is rendered again at the same path", async () => {
		await show("saved", { size: 58875 });
		const finished = pending();
		Object.defineProperty(finished, "duration", { value: 6 });
		await event(finished, "loadeddata");
		finished.currentTime = 6;
		env.revision = 2;
		await show("running", { toolCallId: "render-again", startedAt: 2000, size: 10854 });
		const fragment = pending();
		Object.defineProperty(fragment, "duration", { value: 2 });
		await event(fragment, "loadeddata"); await event(fragment, "seeked");
		expect(player()).toBe(fragment);
		expect(fragment.currentTime).toBeCloseTo(1.9);
	});
	it.each([false, true])("replaces the prior run's exact-end movie with a new fragment, native ended: %s", async ended => {
		await show("running", { size: null });
		const finished = pending();
		Object.defineProperty(finished, "duration", { value: 6 });
		await event(finished, "loadeddata"); await event(finished, "seeked");
		finished.currentTime = 6;
		Object.defineProperties(finished, { ended: { value: ended }, paused: { value: true } });
		await event(finished, "pause");
		env.revision = 2; await show("running", { size: 10854 });
		const fragment = pending();
		Object.defineProperty(fragment, "duration", { value: 2 });
		await event(fragment, "loadeddata"); await event(fragment, "seeked");
		expect(player()).toBe(fragment);
		expect(fragment.currentTime).toBeCloseTo(1.9);
	});
	it.each([{ toolCallId: "render-again", size: 58875 }, { toolCallId: "render", size: 10854 }])("resets a running timeline on a new call or a shrinking file: $toolCallId/$size", async restart => {
		await show("running", { size: 58875 });
		const first = pending();
		Object.defineProperty(first, "duration", { value: 6 });
		await event(first, "loadeddata"); await event(first, "seeked");
		first.currentTime = 4;
		Object.defineProperty(first, "paused", { value: false });
		env.revision = 2; await show("running", restart);
		const fragment = pending();
		Object.defineProperty(fragment, "duration", { value: 2 });
		await event(fragment, "loadeddata"); await event(fragment, "seeked");
		expect(player()).toBe(fragment);
	});
	it("promotes a newer complete revision when the old player is paused at the end", async () => {
		await show("running", { size: 50000 });
		const first = pending();
		Object.defineProperty(first, "duration", { value: 6 });
		await event(first, "loadeddata"); await event(first, "seeked");
		first.currentTime = 6;
		Object.defineProperties(first, { paused: { value: true }, ended: { value: false } });
		await event(first, "seeking");
		env.revision = 2; await show("saved", { size: 58875 });
		const complete = pending();
		Object.defineProperty(complete, "duration", { value: 6 });
		await event(complete, "loadeddata"); await event(complete, "seeked");
		expect(player()).toBe(complete);
		expect(complete.currentTime).toBeCloseTo(5.9);
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
	});
	it("treats a different completed Manim clip as a separate timeline", async () => {
		await show("running", { path: "/project/partial_movie_files/one.mp4" });
		await event(pending(), "loadeddata");
		player()!.currentTime = 10;
		env.revision = 2; await show("running", { path: "/project/partial_movie_files/two.mp4" });
		const candidate = pending();
		Object.defineProperty(candidate, "duration", { value: 2 });
		await event(candidate, "loadeddata"); await event(candidate, "seeked");
		expect(player()).toBe(candidate);
	});
	it("releases superseded candidates and players but keeps the promoted element", async () => {
		await show("running");
		const discarded = pending();
		env.revision = 2; await show("running");
		expect(discarded.getAttribute("src")).toBeNull();
		expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(discarded);
		expect(vi.mocked(HTMLMediaElement.prototype.load).mock.contexts).toContain(discarded);
		const first = pending(); await event(first, "loadeddata");
		expect(vi.mocked(HTMLMediaElement.prototype.load).mock.contexts).not.toContain(first);
		env.revision = 3; await show("running");
		const next = pending(); await event(next, "loadeddata");
		expect(player()).toBe(next);
		expect(first.getAttribute("src")).toBeNull();
		expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(first);
		expect(vi.mocked(HTMLMediaElement.prototype.load).mock.contexts).not.toContain(next);
		await act(async () => root.unmount());
		expect(next.getAttribute("src")).toBeNull();
		expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(next);
		expect(vi.mocked(HTMLMediaElement.prototype.load).mock.contexts).toContain(next);
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
