// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "@shared/ipc";
import type { LiveSubject } from "../types";

vi.mock("./image", () => ({ Frame: ({ subject }: { subject: LiveSubject }) => createElement("img", { alt: "Current frame", src: subject.path! }) }));
vi.mock("../../panes/media", () => ({ loadFileImage: vi.fn(), PreviewImage: () => createElement("span", { "aria-hidden": true }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "Key frames" }) }));
import { Frame, recentSequenceFrames, sequenceFrameCount } from "./sequence";

const pattern = { folder: "/project/frames", prefix: "frame-", digits: null, suffix: ".png" };
const file = (number: number): DirEntry => ({ name: `frame-${number}.png`, path: `/project/frames/frame-${number}.png`, kind: "file" });
const subject: LiveSubject = { id: "sequence", kind: "file", format: "sequence", path: file(12).path, text: null, toolCallId: null, toolName: null, revision: 1, state: "running", elided: false, intent: null, request: null, images: null, progress: null, sequence: { pattern, count: 12 }, size: 100, startedAt: 1, updatedAt: 1 };
let host: HTMLDivElement, root: Root;
const invoke = vi.fn();
const show = async (revision = 1, path = file(12).path) => { await act(async () => root.render(createElement(Frame, { subject: { ...subject, revision, path }, projectPath: "/project", related: [] }))); };
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	host = document.createElement("div"); root = createRoot(host);
	invoke.mockReset().mockResolvedValue(Array.from({ length: 12 }, (_, index) => file(index + 1)));
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
});
afterEach(async () => { await act(async () => root.unmount()); });

describe("sequence frame browsing", () => {
	it("shows additional recent frames as the pane grows while keeping thumbnails readable at larger text sizes", () => {
		expect(sequenceFrameCount(749, 16)).toBe(6);
		expect(sequenceFrameCount(1449, 16)).toBe(12);
		expect(sequenceFrameCount(704, 20.8)).toBe(3);
	});
	it("shows at most twelve numbered files in numeric order and excludes folders and unrelated names", () => {
		const frames = recentSequenceFrames([
			...Array.from({ length: 20 }, (_, index) => file(20 - index)),
			{ ...file(100), kind: "dir" }, { ...file(101), name: "frame-draft.png" }, { ...file(102), name: "other-102.png" },
		], pattern);
		expect(frames.map(frame => frame.name)).toEqual(Array.from({ length: 12 }, (_, index) => `frame-${index + 9}.png`));
		expect(recentSequenceFrames([file(1), { ...file(2), name: "frame-0002.png" }], { ...pattern, digits: 4 }).map(frame => frame.name)).toEqual(["frame-0002.png"]);
	});
	it("keeps the newest frame large, lets a reader inspect another frame, then resumes following", async () => {
		await show();
		expect(host.querySelector("img")?.getAttribute("src")).toBe(file(12).path);
		expect(host.querySelectorAll("button")).toHaveLength(12);
		await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="frame-3.png"]')!.click());
		expect(host.querySelector("img")?.getAttribute("src")).toBe(file(3).path);
		invoke.mockResolvedValue(Array.from({ length: 13 }, (_, index) => file(index + 1)));
		await show(2, file(13).path);
		expect(host.querySelector("img")?.getAttribute("src")).toBe(file(3).path);
		await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="frame-13.png"]')!.click());
		expect(host.querySelector("img")?.getAttribute("src")).toBe(file(13).path);
		await show(3, file(14).path);
		expect(host.querySelector("img")?.getAttribute("src")).toBe(file(14).path);
	});
	it("keeps the newest preview usable if its frame folder cannot be listed", async () => {
		invoke.mockRejectedValue(new Error("Unreadable"));
		await show();
		expect(host.querySelector("img")?.getAttribute("src")).toBe(file(12).path);
		expect(host.querySelectorAll("button")).toHaveLength(0);
	});
});
