// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitDiff, GitFileDiff, GitLogCommit, GitLogOptions, GitStatus } from "@shared/contracts/git";
import type { GitView } from "./git-store";
import { DiffPane } from "./DiffPane";
import { TooltipProvider } from "../../ui";
import type * as Ui from "../../ui";
import "../../i18n";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), view: {} as GitView, dirty: false }));
vi.mock("../../state/app", () => ({ currentDock: () => ({ width: 420 }), useApp: { getState: () => ({}) }, controllerFor: vi.fn() }));
vi.mock("./git-store", () => ({
	useGit: () => fake.view,
	refreshGit: vi.fn(),
	useFileChangesRequest: Object.assign((select: (state: { request: null }) => unknown) => select({ request: null }), { setState: vi.fn() }),
}));
vi.mock("./common", () => ({
	listRowMotion: {}, usePaneVisible: () => true,
	PaneToolbar: ({ children }: PropsWithChildren) => createElement("div", null, children),
}));
vi.mock("../../ui/TargetContextMenu", () => ({ TargetContextMenu: ({ children }: PropsWithChildren) => children }));
vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { AnimatePresence: ({ children }: PropsWithChildren) => children, MotionConfig: ({ children }: PropsWithChildren) => children, motion: { div: tag("div"), ul: tag("ul"), li: tag("li"), span: tag("span") }, useReducedMotionConfig: () => true };
});
vi.mock("../../ui", async () => ({
	...await vi.importActual<typeof Ui>("../../ui"),
	PresenceSwap: ({ children }: PropsWithChildren) => children,
	Expand: ({ children, open }: PropsWithChildren<{ open: boolean }>) => open ? children : null,
	useMotionReduced: () => true,
}));

const commit = (i: number): GitLogCommit => ({ sha: (i + 1).toString(16).padStart(40, "0"), shortSha: (i + 1).toString(16).padStart(7, "0"), subject: `Commit ${i}`, body: "", author: "Author", authorDate: "2026-10-29T12:00:00+00:00", files: 1, additions: 1, deletions: 0 });
const file: GitFileDiff = { path: "example.ts", origPath: null, kind: "added", untracked: false, binary: false, oldMode: null, newMode: "100644", additions: 1, deletions: 0, patch: "", truncated: false, hunks: [{ header: "@@ -0,0 +1 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, section: "", lines: [{ kind: "add", text: "export const example = 1;", oldLine: null, newLine: 1, noNewline: false }] }] };
let element: HTMLDivElement;
let root: Root;
let snapshots: Map<string, GitLogCommit[]>;
let initial: GitLogCommit[];
const buttons = () => [...element.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string) => buttons().find(node => node.textContent === name)!;
const rows = () => [...element.querySelectorAll<HTMLButtonElement>('ul[aria-label="Commit history"] button')];
const logCalls = () => fake.invoke.mock.calls.filter(call => call[0] === "git:log");
const render = async () => { await act(async () => root.render(createElement(TooltipProvider, null, createElement(DiffPane, { projectPath: "/repo", session: null })))); };
const click = async (node: HTMLButtonElement) => { await act(async () => node.click()); };
const update = async (head: string, dirty = false) => {
	fake.dirty = dirty;
	fake.view = { ...fake.view, version: fake.view.version + 1, status: { ...fake.view.status!, head } };
	await render();
};

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.invoke.mockReset(); fake.dirty = false;
	initial = Array.from({ length: 65 }, (_, i) => commit(i));
	snapshots = new Map([[initial[0]!.sha, initial]]);
	fake.view = { version: 1, notRepo: false, error: null, status: { head: initial[0]!.sha, files: [] } as unknown as GitStatus };
	fake.invoke.mockImplementation(async (channel: string, _cwd: string, options?: GitLogOptions & { commit?: string }) => {
		if (channel === "git:log") {
			const history = snapshots.get(options!.head!);
			if (!history) throw new Error("Unknown history snapshot");
			return history.slice(options?.skip ?? 0, (options?.skip ?? 0) + (options?.limit ?? 30));
		}
		if (channel === "git:diff") return { root: "/repo", base: options?.commit ? "empty" : "HEAD", files: options?.commit || fake.dirty ? [file] : [] } satisfies GitDiff;
	});
	Object.assign(window, { vomp: { platform: "darwin", invoke: fake.invoke } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it("pins older pages while a new commit arrives, then refreshes the entire loaded window coherently", async () => {
	await render(); expect(rows()).toHaveLength(30);
	await click(button("Show more")); expect(rows()).toHaveLength(60);
	const added = commit(999);
	snapshots.set(added.sha, [added, ...initial]);
	// HEAD changes in Git before the watcher delivers its next status snapshot.
	await click(button("Show more"));
	expect(rows()).toHaveLength(65);
	expect(rows().map(row => row.title)).toEqual(initial.map(item => item.subject));
	await update(added.sha);
	expect(rows()).toHaveLength(66);
	expect(rows().map(row => row.title)).toEqual([added, ...initial].map(item => item.subject));
	expect(new Set(rows().map(row => row.title)).size).toBe(66);
	expect(logCalls().every(call => call[2].limit === 30)).toBe(true);
});

it("retains loaded pages and avoids history requests when working files change but HEAD does not", async () => {
	await render(); await click(button("Show more"));
	const calls = logCalls().length;
	await update(initial[0]!.sha, true);
	expect(element.textContent!.indexOf("Uncommitted changes")).toBeLessThan(element.textContent!.indexOf("Commit history"));
	expect(rows()).toHaveLength(60);
	expect(logCalls()).toHaveLength(calls);
	expect(button("Review code")).toBeDefined();
	await update(initial[0]!.sha, false);
	expect(element.textContent).toContain("No uncommitted changes");
	expect(rows()).toHaveLength(60);
	expect(logCalls()).toHaveLength(calls);
});

it("supports keyboard history navigation and read-only selection while retaining history on Back", async () => {
	await render();
	const first = rows()[0]!;
	first.focus();
	await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
	expect(document.activeElement).toBe(rows()[1]);
	await click(document.activeElement as HTMLButtonElement);
	expect(button("Back to changes")).toBe(document.activeElement);
	expect(element.querySelector('[role="region"][aria-label="Commit details"]')?.textContent).toContain("Read-only");
	expect(element.querySelector('ul[aria-label="Changed files"]')).not.toBeNull();
	expect(element.querySelector('button[aria-label="Discard changes to this file"]')).toBeNull();
	expect(element.querySelector('button[aria-label^="Comment on line"]')).toBeNull();
	expect(button("Review code")).toBeUndefined();
	await click(element.querySelector<HTMLButtonElement>('button[aria-label="Collapse this file"]')!);
	expect(element.querySelector('button[aria-label="Expand this file"]')).not.toBeNull();
	const calls = logCalls().length;
	await click(button("Back to changes"));
	expect(document.activeElement?.textContent).toBe("Commit history");
	expect(rows()).toHaveLength(30);
	expect(logCalls()).toHaveLength(calls);
});
