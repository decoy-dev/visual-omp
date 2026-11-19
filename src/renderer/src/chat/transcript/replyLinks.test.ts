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
import { toolBasesByReply } from "./fileRefScope";
import "../../i18n";

const env = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin", invoke: env.invoke, on: () => () => undefined } });
});
vi.mock("../../features/projects/folders/homeDir", () => ({ useHomeDir: () => "/Users/example" }));
vi.mock("./pace", async importOriginal => ({ ...await importOriginal<typeof PaceModule>(), usePlayout: () => null }));

const projectPath = "/Users/example/Drive-example@example.test/Drive Files/Ads";
const existingFiles = ["Folder Name/08-card.png", "notes.md", "literal%20name.md"].map(ref => `${projectPath}/${ref}`);

function assistantEntry(timestamp: number, content: AssistantMessage["content"]): SessionEntry {
	return {
		type: "message",
		id: `entry-${timestamp}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content,
			model: "fixture",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "stop",
			timestamp,
		} as AssistantMessage,
	};
}

function toolBlock(id: string, name: string, args: Record<string, unknown>) {
	return { type: "toolCall" as const, id, name, arguments: args };
}

describe("tool folder snapshots", () => {
	const home = "/Users/example";

	it("keeps earlier reply bases and gives a stream the latest snapshot", () => {
		const firstBase = `${home}/Work/first`;
		const secondBase = `${home}/Work/second`;
		const entries = [
			assistantEntry(1, [{ type: "text", text: "Before a tool call" }]),
			assistantEntry(2, [toolBlock("read", "read", { path: `${firstBase}/source.ts` })]),
			assistantEntry(3, [{ type: "text", text: "First reply" }]),
			assistantEntry(4, [toolBlock("bash", "bash", { cwd: secondBase })]),
			assistantEntry(5, [{ type: "text", text: "Second reply" }]),
		];
		const bases = toolBasesByReply(entries, home, "darwin", 6);
		expect(bases.get(1)).toEqual([]);
		expect(bases.get(3)).toContain(firstBase);
		expect(bases.get(3)).not.toContain(secondBase);
		expect(bases.get(5)).toContain(secondBase);
		expect(bases.get(3)).not.toContain(secondBase);
		expect(bases.get(6)).toContain(secondBase);
	});

	it("caps each reply at seven tool folders", () => {
		const entries = Array.from({ length: 10 }, (_, index) => {
			const timestamp = index + 1;
			return assistantEntry(timestamp, [toolBlock(`read-${index}`, "read", { path: `${home}/Projects/p${index}/source.ts` })]);
		});
		entries.push(assistantEntry(100, [{ type: "text", text: "Reply" }]));
		expect(toolBasesByReply(entries, home, "darwin").get(100)).toHaveLength(7);
	});

	it("accepts another Windows drive and excludes duplicate case, UNC, home and root paths", () => {
		const windowsHome = "C:\\Users\\Example";
		const entries = [
			assistantEntry(1, [toolBlock("drive", "read", { path: "D:\\Work\\source.md" })]),
			assistantEntry(2, [toolBlock("case-one", "read", { path: "C:\\Users\\Example\\Work\\source.md" })]),
			assistantEntry(3, [toolBlock("case-two", "read", { path: "c:\\users\\example\\WORK\\other.md" })]),
			assistantEntry(4, [toolBlock("unc", "read", { path: "\\\\server\\share\\source.md" })]),
			assistantEntry(5, [toolBlock("home", "read", { path: `${windowsHome}\\source.md` })]),
			assistantEntry(6, [toolBlock("root", "read", { path: "C:\\source.md" })]),
			assistantEntry(7, [{ type: "text", text: "Reply" }]),
		];
		const bases = toolBasesByReply(entries, windowsHome, "win32");
		expect(bases.get(2)).toContain("D:/Work");
		expect(bases.get(4)?.filter(path => path.toLowerCase() === "c:/users/example/work")).toHaveLength(1);
		expect(bases.get(5)).toEqual(bases.get(4));
		expect(bases.get(7)).toEqual(bases.get(6));
		expect(bases.get(7)).not.toContain("C:/");
		expect(bases.get(7)).not.toContain(windowsHome);
	});
});
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

async function paint(text: string, earlier: readonly SessionEntry[] = [], settle = true): Promise<void> {
	const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: "stop", timestamp: 1000 };
	const reply: SessionEntry = { type: "message", id: "reply", parentId: null, timestamp: new Date(1000).toISOString(), message };
	const entries: SessionEntry[] = [...earlier, reply];
	await act(async () => root.render(createElement(MotionProvider, null, createElement(TooltipProvider, null, createElement(TranscriptBody, {
		scope: { projectPath, tabId: "reply-links" }, entries, mode: "normal", ready: true, identity: projectPath,
	})))));
	if (settle) await act(async () => { await Promise.all(env.invoke.mock.results.map(result => result.value)); });
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

	it("links a relative path beneath a folder reached by an earlier absolute tool path", async () => {
		const laptop = "/Users/example/Library/CloudStorage/GoogleDrive-example/Other computers/My Laptop";
		const inspected = `${laptop}/ReadyCloud Files/Asset Retrieval Return Email/source.md`;
		const ref = "ReadyCloud Files/Asset Retrieval Return Email/asset-retrieval-return-email.zip";
		const file = `${laptop}/${ref}`;
		env.invoke.mockImplementation(async (channel: string, request: FileRefRequest) => {
			if (channel !== "fs:resolveRefs") return;
			return request.refs.map(candidate => candidate === ref && request.toolBases?.includes(laptop) ? { path: file, kind: "file" } : null);
		});
		const earlier: SessionEntry = {
			type: "message",
			id: "earlier-tool",
			parentId: null,
			timestamp: new Date(500).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-source", name: "read", arguments: { path: inspected } }],
				model: "fixture",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: 500,
			} as AssistantMessage,
		};
		await paint(`The archive is \`${ref}\`.`, [earlier]);
		expect(env.invoke).toHaveBeenCalledWith("fs:resolveRefs", expect.objectContaining({
			refs: [ref],
			bases: [projectPath],
			toolBases: expect.arrayContaining([laptop]),
		}));
		await vi.waitFor(async () => {
			await act(async () => {});
			expect(container.querySelector("[data-file-path]")).not.toBeNull();
		});
		const link = container.querySelector<HTMLElement>("[data-file-path]")!;
		expect(link.getAttribute("role")).toBe("link");
		expect(link.dataset.filePath).toBe(file);
	});

	it.each([
		["bash", "cwd", true],
		["glob", "path", true],
		["grep", "path", true],
		["find", "path", true],
		["write", "file_path", false],
		["edit", "path", false],
	] as const)("uses absolute %s tool folders as reply candidates", async (name, argument, directory) => {
		const folder = "/Users/example/Projects/Local docs";
		const touched = directory ? folder : `${folder}/source.md`;
		const ref = "notes.md";
		const file = `${folder}/${ref}`;
		env.invoke.mockImplementation(async (channel: string, request: FileRefRequest) => {
			if (channel !== "fs:resolveRefs") return;
			return request.refs.map(candidate => candidate === ref && request.toolBases?.includes(folder) ? { path: file, kind: "file" } : null);
		});
		const earlier: SessionEntry = {
			type: "message",
			id: `earlier-${name}`,
			parentId: null,
			timestamp: new Date(500).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${name}`, name, arguments: { [argument]: touched } }],
				model: "fixture",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: 500,
			} as AssistantMessage,
		};
		await paint(`The file from ${name} is \`${ref}\`.`, [earlier]);
		expect(env.invoke).toHaveBeenCalledWith("fs:resolveRefs", expect.objectContaining({ toolBases: expect.arrayContaining([folder]) }));
		await vi.waitFor(async () => {
			await act(async () => {});
			expect(container.querySelector("[data-file-path]")).not.toBeNull();
		});
		expect(container.querySelector<HTMLElement>("[data-file-path]")?.dataset.filePath).toBe(file);
	});

	it("removes a cached link when earlier tool folders change", async () => {
		const firstBase = "/Users/example/first";
		const secondBase = "/Users/example/second";
		const firstFile = `${firstBase}/notes.md`;
		const secondFile = `${secondBase}/notes.md`;
		const ref = "notes.md";
		const text = `See \`${ref}\`.`;
		env.invoke.mockImplementation(async (channel: string, request: FileRefRequest) => {
			if (channel !== "fs:resolveRefs") return;
			return request.refs.map(candidate => candidate === ref && request.toolBases?.includes(firstBase) ? { path: firstFile, kind: "file" } : null);
		});
		await paint(text, [assistantEntry(500, [toolBlock("read-first", "read", { path: `${firstBase}/source.md` })])]);
		expect(container.querySelector<HTMLElement>("[data-file-path]")?.dataset.filePath).toBe(firstFile);

		const pending = Promise.withResolvers<({ path: string; kind: "file" } | null)[]>();
		env.invoke.mockImplementation(async (channel: string) => channel === "fs:resolveRefs" ? pending.promise : undefined);
		await paint(text, [assistantEntry(500, [toolBlock("read-second", "read", { path: `${secondBase}/source.md` })])], false);
		expect(env.invoke).toHaveBeenCalledWith("fs:resolveRefs", expect.objectContaining({ toolBases: expect.arrayContaining([secondBase]) }));
		expect(container.querySelector("[data-file-path]")).toBeNull();

		pending.resolve([{ path: secondFile, kind: "file" }]);
		await act(async () => { await pending.promise; });
		await vi.waitFor(() => expect(container.querySelector<HTMLElement>("[data-file-path]")?.dataset.filePath).toBe(secondFile));
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
