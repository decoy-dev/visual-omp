// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deriveSubjects, type SubjectInput } from "../subjects";
import { useLivePreview } from "../store";
import type { LiveSubject } from "../types";

vi.mock("../../../ui", () => ({ Button: ({ children }: { children: string }) => createElement("button", null, children) }));
vi.mock("../../../ui/motion", () => ({ useMotionReduced: () => false }));
vi.mock("../../panes/files-store", () => ({ openInFiles: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { Frame } from "./video";

let root: Root;
let host: HTMLDivElement;
let grants: number;
const invoke = vi.fn(async (name: string) => name === "preview:grant"
	? { token: `token${++grants}`, url: `vomp-preview://token${grants}/movie.mp4`, assetRoot: true } : undefined);

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.useFakeTimers();
	grants = 0;
	invoke.mockClear();
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	useLivePreview.getState().forget("growth");
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("carries repeated watcher snapshots through the store and actual grant hook to advancing playable URLs", async () => {
	const snapshot: SubjectInput = {
		stream: null, streamDone: true, working: true, folder: "/project", now: 1000, entries: [], changes: [],
		activeTools: new Map([["render", { toolCallId: "render", toolName: "bash", args: { command: "ffmpeg -i input.mov -frames:v 180 movie.mp4" }, startedAt: 100 }]]),
		backgroundTools: new Map(),
	};
	let subjects: LiveSubject[] = [];
	let priorRevision = 0;
	let priorTime = 0;
	for (const [index, size] of [776, 10854, 20482, 30198, 39933].entries()) {
		subjects = deriveSubjects({ ...snapshot, changes: [{ watchId: "watch", path: "/project/movie.mp4", size, mtimeMs: 500 + index }] }, subjects);
		useLivePreview.getState().update("growth", subjects, ["/project/movie.mp4"]);
		const subject = useLivePreview.getState().chats.growth!.subjects[0]!;
		expect(subject.revision).toBeGreaterThan(priorRevision);
		expect(subject).toMatchObject({ id: "call:render", size, state: "running" });
		priorRevision = subject.revision;
		await act(async () => root.render(createElement(StrictMode, null,
			createElement(Frame, { subject, projectPath: "/project", related: ["/project/movie.mp4"] }))));
		await act(async () => { await vi.runOnlyPendingTimersAsync(); });
		const candidate = host.querySelector<HTMLVideoElement>("[data-pending-video]")!;
		expect(candidate).not.toBeNull();
		expect(candidate.getAttribute("src")).toMatch(new RegExp(`\\?rev=${subject.revision}$`));
		Object.defineProperty(candidate, "duration", { configurable: true, value: index });
		await act(async () => candidate.dispatchEvent(new Event("loadeddata")));
		if (index === 0) {
			expect(host.querySelector("video[controls]")).toBeNull();
			continue;
		}
		await act(async () => candidate.dispatchEvent(new Event("seeked")));
		expect(host.querySelector("video[controls]")).toBe(candidate);
		expect(candidate.currentTime).toBeGreaterThan(priorTime);
		priorTime = candidate.currentTime;
	}
	expect(priorTime).toBeCloseTo(3.9);
	expect(invoke.mock.calls.filter(([name]) => name === "preview:saved")).toHaveLength(1);
});
