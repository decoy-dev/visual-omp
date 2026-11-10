// @vitest-environment happy-dom
import type { FileRefRequest } from "@shared/contracts/fileRefs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type * as PaceModule from "./pace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../../state/app";
import { useFiles } from "../../features/panes/files-store";
import { MotionProvider, TooltipProvider } from "../../ui";
import { renderMarkdown } from "../../transcript/render";
import { occurrences, parse } from "./fileLinkMarkup";
import { TranscriptBody } from "./Transcript";
import "../../i18n";

const env = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin", invoke: env.invoke, on: () => () => undefined } });
});
vi.mock("../../features/projects/folders/homeDir", () => ({ useHomeDir: () => null }));
vi.mock("./pace", async importOriginal => ({ ...await importOriginal<typeof PaceModule>(), usePlayout: () => null }));

const projectPath = "/Users/example/Drive-example@example.test/Drive Files/Ads";
const existingFiles = ["Folder Name/08-card.png", "notes.md", "literal%20name.md"].map(ref => `${projectPath}/${ref}`);
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	document.documentElement.dataset.motion = "reduced";
	env.invoke.mockReset();
	env.invoke.mockImplementation(async (channel: string, request: FileRefRequest) => {
		if (channel !== "fs:resolveRefs") return;
		return request.refs.map(ref => {
			if (ref === projectPath) return { path: projectPath, kind: "folder" };
			const path = ref.startsWith("/") ? ref : `${request.bases[0]}/${ref.replace(/^\.\//, "")}`;
			return existingFiles.includes(path) ? { path, kind: "file" } : null;
		});
	});
	useApp.setState({ tabs: [{ id: "reply-links", projectPath, sessionFile: null, title: "Reply links" }], activeTabId: "reply-links", view: "chat", docks: {} });
	useFiles.setState({ byView: {} });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	delete document.documentElement.dataset.motion;
});

async function paint(text: string): Promise<void> {
	const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: "stop", timestamp: 1000 };
	const entries: SessionEntry[] = [{ type: "message", id: "reply", parentId: null, timestamp: new Date(1000).toISOString(), message }];
	await act(async () => root.render(createElement(MotionProvider, null, createElement(TooltipProvider, null, createElement(TranscriptBody, {
		scope: { projectPath, tabId: "reply-links" }, entries, mode: "normal", ready: true, identity: projectPath,
	})))));
	await act(async () => { await Promise.all(env.invoke.mock.results.map(result => result.value)); });
}

async function resolvedLink(): Promise<HTMLAnchorElement> {
	await vi.waitFor(async () => {
		await act(async () => {});
		expect(container.querySelector("a[data-file-path]")).not.toBeNull();
	});
	return container.querySelector<HTMLAnchorElement>("a[data-file-path]")!;
}

describe("local reply Markdown links", () => {
	it.each([
		["<Folder Name/08-card.png>", "Folder Name/08-card.png"],
		["Folder%20Name/08-card.png", "Folder Name/08-card.png"],
		["./notes.md", "./notes.md"],
		["literal%2520name.md", "literal%20name.md"],
	])("passes %s to the file-chip resolver and opens the originating Files viewer", async (href, ref) => {
		const text = `[View **the revised card**](${href})`;
		expect(occurrences(parse(renderMarkdown(text))).map(item => item.ref)).toEqual([ref]);
		await paint(text);
		expect(env.invoke).toHaveBeenCalledWith("fs:resolveRefs", expect.objectContaining({ refs: [ref], bases: [projectPath] }));
		const link = await resolvedLink();
		expect(link.textContent).toBe("View the revised card");
		expect(link.querySelector("strong")?.textContent).toBe("the revised card");
		await act(async () => link.click());
		const path = `${projectPath}/${ref.replace(/^\.\//, "")}`;
		expect(useFiles.getState().byView["reply-links"]).toMatchObject({ active: path, tabs: [path], treeHidden: true });
		expect(useApp.getState().docks["reply-links"]).toMatchObject({ open: true, pane: "files" });
		expect(env.invoke.mock.calls.some(([channel]) => channel === "app:openExternal")).toBe(false);
	});

	it("keeps anchors and file chips in document order without resolving their label text again", async () => {
		const text = "`notes.md`, [Open **the card** and `ignored.md`](<Folder Name/08-card.png>), then `literal%20name.md`.";
		expect(occurrences(parse(renderMarkdown(text))).map(item => item.ref)).toEqual(["notes.md", "Folder Name/08-card.png", "literal%20name.md"]);
		await paint(text);
		const targets = [...container.querySelectorAll<HTMLElement>("[data-file-path]")];
		expect(targets.map(target => target.dataset.filePath)).toEqual([
			`${projectPath}/notes.md`, `${projectPath}/Folder Name/08-card.png`, `${projectPath}/literal%20name.md`,
		]);
		const link = targets[1]!;
		await act(async () => link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(useFiles.getState().byView["reply-links"]?.active).toBe(`${projectPath}/Folder Name/08-card.png`);
	});

	it("resolves an absolute POSIX path containing spaces", async () => {
		const path = `${projectPath}/Folder Name/08-card.png`;
		await paint(`[View card](<${path}>)`);
		const link = await resolvedLink();
		await act(async () => link.click());
		expect(useFiles.getState().byView["reply-links"]?.active).toBe(path);
	});

	it.each(["https://example.test/Folder%20Name/card.png", "http://example.test/card.png", "mailto:example@example.test", "missing%20card.png"])("keeps the existing external dispatch for %s", async href => {
		await paint(`[View card](${href})`);
		const anchor = container.querySelector<HTMLAnchorElement>("a[href]")!;
		expect(anchor.dataset.filePath).toBeUndefined();
		await act(async () => anchor.click());
		expect(env.invoke).toHaveBeenCalledWith("app:openExternal", href);
		expect(useFiles.getState().byView).toEqual({});
	});

	it("leaves unsupported file URLs, fragments, malformed escapes and active schemes out of file resolution", () => {
		for (const href of ["file:///Users/example/Drive%20Files/card.png", "#notes.md", "?file=notes.md", "bad%ZZ.md", "javascript:alert%281%29", "//example.test/card.png"]) {
			expect(occurrences(parse(renderMarkdown(`[View card](${href})`))), href).toEqual([]);
		}
		expect(parse(renderMarkdown("[View card](file:///Users/example/Drive%20Files/card.png)")).querySelector("a")).toBeNull();
	});
});
