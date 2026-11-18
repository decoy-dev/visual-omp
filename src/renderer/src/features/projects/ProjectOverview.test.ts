// @vitest-environment happy-dom
import type * as MotionReact from "motion/react";
import { act, createElement, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { TooltipProvider } from "../../ui/Tooltip";
import { ProjectOverview } from "./ProjectOverview";

const fake = vi.hoisted(() => {
	const appState = {
		projects: [{ path: "/project", name: "Project", exists: true }],
		sessionsByProject: { "/project": [] },
		tabs: [],
		unseenChats: {},
		prefs: { pinnedProjects: [], projectColors: {} },
		loadSessions: vi.fn(),
	};
	return {
		invoke: vi.fn(),
		git: null as unknown,
		appState,
		useApp: Object.assign((select: (state: typeof appState) => unknown) => select(appState), { getState: () => appState }),
	};
});

vi.mock("@/state/app", () => ({ controllerFor: () => null, useApp: fake.useApp }));
vi.mock("@/state/navigation", () => ({ openProjectInstructions: vi.fn(), openProjectSettings: vi.fn() }));
vi.mock("../git/actions", () => ({ initGit: vi.fn() }));
vi.mock("../git/store", () => ({ useGit: () => fake.git }));
vi.mock("./actions", () => ({ addProject: vi.fn(), chooseFolder: vi.fn(), openFolder: vi.fn(), startDraft: vi.fn() }));
vi.mock("motion/react", async importOriginal => {
	const actual = await importOriginal<typeof MotionReact>();
	const primitive = (tag: "div" | "li" | "section") => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) => {
		const dom: Record<string, unknown> = { ref };
		for (const [key, value] of Object.entries(props)) if (key === "className" || key === "id" || key.startsWith("aria-")) dom[key] = value;
		return createElement(tag, dom, children as ReactNode);
	});
	const primitives = { div: primitive("div"), li: primitive("li"), section: primitive("section") };
	return {
		...actual,
		motion: new Proxy(actual.motion, { get: (target, key) => key in primitives ? primitives[key as keyof typeof primitives] : Reflect.get(target, key) }),
		AnimatePresence: ({ children }: { children: ReactNode }) => children,
		LayoutGroup: ({ children }: { children: ReactNode }) => children,
	};
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const path = "/project";
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => { await i18n.loadNamespaces(["projects", "git", "shell", "chat", "tools"]); });
beforeEach(() => {
	fake.invoke.mockReset();
	fake.invoke.mockImplementation(async (channel: string) => {
		switch (channel) {
			case "project:instructions": return { files: [], activeRelPath: null };
			case "project:rules": return [];
			case "config:roles": return { roles: [] };
			case "config:approval": return { mode: "write", modeSource: "global", policies: [], unrecognized: [] };
			default: return undefined;
		}
	});
	fake.git = {
		loading: false,
		repo: { isRepo: true },
		status: {
			root: path,
			branch: "feature/overview",
			head: "0123456789abcdef",
			detached: false,
			unborn: false,
			upstream: "origin/main",
			ahead: 2,
			behind: 1,
			operation: null,
			files: [],
			totals: { files: 3, staged: 0, unstaged: 3, untracked: 0, conflicted: 0, additions: 12, deletions: 5 },
		},
		pr: null,
		error: null,
	};
	Object.assign(window, { vomp: { invoke: fake.invoke, platform: "darwin" } });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function render() {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(ProjectOverview, { projectPath: path }))));
}

describe("project overview Git summary", () => {
	it("shows the branch, changed-file count, line totals and upstream state", async () => {
		await render();
		expect(container.textContent).toContain("feature/overview");
		expect(container.textContent).toContain("3 files changed");
		expect(container.textContent).toContain("+12");
		expect(container.textContent).toContain("−5");
		expect(container.textContent).toContain("origin/main");
		expect(container.textContent).toContain("2 commits to push");
		expect(container.textContent).toContain("1 new commit to pull");
		expect(container.textContent).toContain("Review changes");
	});

	it("names a pinned project's pin as a state, not an action", async () => {
		fake.appState.prefs.pinnedProjects = [path] as never;
		try {
			await render();
			expect(container.querySelector('h1 [aria-label="Pinned"]')).not.toBeNull();
			expect(container.querySelector('[aria-label="Pin project"]')).toBeNull();
		} finally {
			fake.appState.prefs.pinnedProjects = [];
		}
	});
});
