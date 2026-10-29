// @vitest-environment happy-dom
import type * as MotionReact from "motion/react";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptResult } from "../../collab/lib/client";
import "../../i18n";
import type { SessionController, SessionView } from "../../state/session";
import { TooltipProvider } from "../../ui";
import { TasksPane } from "./TasksPane";

vi.mock("../session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../session-tools/drive", () => ({ reportFailure: vi.fn() }));
vi.mock("../../ui/TargetContextMenu", () => ({ TargetContextMenu: ({ children }: { children: ReactNode }) => children }));
vi.mock("./common", async importOriginal => ({ ...await importOriginal<object>(), usePaneVisible: () => true }));
vi.mock("motion/react", async importOriginal => {
	const actual = await importOriginal<typeof MotionReact>();
	// The hoisted mock loads React before this test module's imports initialize.
	const { createElement, forwardRef } = await import("react");
	const Div = forwardRef<HTMLDivElement, { children?: ReactNode; className?: string; id?: string }>(({ children, className, id }, ref) => createElement("div", { ref, className, id }, children));
	const Li = forwardRef<HTMLLIElement, { children?: ReactNode; className?: string }>(({ children, className }, ref) => createElement("li", { ref, className }, children));
	return {
		...actual,
		motion: new Proxy(actual.motion, { get: (target, key) => key === "div" ? Div : key === "li" ? Li : Reflect.get(target, key) }),
		AnimatePresence: ({ children }: { children: ReactNode }) => children,
	};
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: { root: Root; container: HTMLElement }[] = [];

afterEach(async () => {
	for (const { root, container } of mounted.splice(0)) {
		await act(async () => root.unmount());
		container.remove();
	}
});

const childTranscript = [
	{ type: "session", id: "child-session", cwd: "/helper" },
	{ type: "message", id: "call", timestamp: "2026-10-29T12:00:00Z", message: { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "make", async: true } }] } },
	{ type: "message", id: "result", timestamp: "2026-10-29T12:00:01Z", message: { role: "toolResult", toolCallId: "bash", toolName: "bash", timestamp: 2, content: [], details: { async: { jobId: "child-job", state: "running" } } } },
].map(entry => JSON.stringify(entry)).join("\n") + "\n";

async function mountHelpers(ids: string[], fetchTranscript: (id: string, offset: number) => Promise<TranscriptResult | null>) {
	const client = { fetchTranscript };
	const view = {
		mode: "live", working: false, history: null, displayLeaf: null, readOnly: false,
		guest: {
			phase: "live", entries: [], header: { cwd: "/project" },
			agents: ids.map((id, index) => ({ id, displayName: id, kind: "sub", status: "idle", hasSessionFile: true, createdAt: 0, lastActivity: 100 - index })),
			progress: new Map(), lifecycle: new Map(), activeTools: new Map(), backgroundTools: new Map(),
		},
	} as unknown as SessionView;
	const session = { tabId: "test", projectPath: "/project", getSnapshot: () => view, subscribe: () => () => {}, guestClient: () => client } as unknown as SessionController;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(TasksPane, { session, projectPath: "/project" }))));
	return container;
}

function button(container: HTMLElement, label: string) {
	const match = [...container.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
	expect(match).toBeDefined();
	return match!;
}

describe("helper list controls", () => {
	it("keeps Show fewer available after expansion and retains an older helper with a running child on collapse", async () => {
		const ids = ["D1", "D2", "D3", "P1", "P2", "P3"];
		const container = await mountHelpers(ids, async (id, offset) => ({ kind: "rows", text: id === "P2" && offset === 0 ? childTranscript : "", newSize: id === "P2" ? childTranscript.length : 0 }));
		expect(container.querySelector('p[title="P2"]')).not.toBeNull();
		await act(async () => button(container, "Show 3 earlier helpers").click());
		for (const id of ids) expect(container.querySelector(`p[title="${id}"]`)).not.toBeNull();
		expect(button(container, "Show fewer helpers").getAttribute("aria-expanded")).toBe("true");
		await act(async () => button(container, "Show fewer helpers").click());
		expect(container.querySelector('p[title="P2"]')).not.toBeNull();
		expect(container.querySelector('p[title="P1"]')).toBeNull();
		expect(container.querySelector('p[title="P3"]')).toBeNull();
		expect(button(container, "Show 3 earlier helpers").getAttribute("aria-expanded")).toBe("false");
	});

	it("shows a concise unavailable state when omp reports a terminal helper transcript error", async () => {
		const fetchTranscript = vi.fn(async (): Promise<TranscriptResult> => ({ kind: "error", message: "no transcript available" }));
		const container = await mountHelpers(["Atlas"], fetchTranscript);
		const unavailable = [...container.querySelectorAll('[role="status"]')].find(element => element.textContent === "Background jobs unavailable.");
		expect(unavailable?.getAttribute("title")).toBe("no transcript available");
		expect(fetchTranscript).toHaveBeenCalledTimes(1);
	});
});
