import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResumeDeclinedError } from "../../registry/guards";
import type { SessionController } from "../../state/session";
import { parseSlash, routeSlash, slashCommands } from "./slash";

const mocks = vi.hoisted(() => {
	const invoke = vi.fn();
	vi.stubGlobal("window", { vomp: { on: () => () => undefined, invoke } });
	return {
		invoke,
		runCommand: vi.fn((_id: string) => true),
		openSettings: vi.fn(),
		openSheet: vi.fn(),
		showPane: vi.fn(),
		returnToChat: vi.fn(),
		setState: vi.fn((update: (state: { btwDrawers: Record<string, boolean> }) => unknown) => update({ btwDrawers: {} })),
		openThinking: vi.fn(),
		focusChatSearch: vi.fn(),
		toast: vi.fn(),
		setMode: vi.fn(),
		exportChat: vi.fn(),
	};
});
vi.mock("@/ui", () => ({ toast: mocks.toast }));
vi.mock("../../i18n", () => ({ i18n: { t: (key: string) => key.replace(/^composer:/, "") } }));
vi.mock("../palette/run", () => ({ runCommand: mocks.runCommand }));
vi.mock("../../state/navigation", () => ({ openSettings: mocks.openSettings }));
vi.mock("../../state/app", () => ({ useApp: { setState: mocks.setState, getState: () => ({ openSheet: mocks.openSheet, showPane: mocks.showPane, returnToChat: mocks.returnToChat }) } }));
vi.mock("../../shell/Sidebar", () => ({ focusChatSearch: mocks.focusChatSearch }));
vi.mock("./pickers", () => ({ usePickerRequests: { getState: () => ({ openThinking: mocks.openThinking }) } }));
vi.mock("./nativeModes", () => ({ setSessionMode: mocks.setMode }));
vi.mock("./export", () => ({ exportChat: mocks.exportChat }));
vi.mock("../btw/BtwPane", () => ({ BtwDrawerContent: { preload: async () => {} } }));
vi.mock("../btw/BtwPaneContent", () => ({ openBtwDrawer: async (session: { tabId: string }, host: { hostId: string; generation: number; tspEpoch: number }, question: string) => {
	mocks.setState(state => ({ btwDrawers: { ...state.btwDrawers, [session.tabId]: true } }));
	mocks.returnToChat();
	await Promise.resolve(mocks.invoke("btw:ask", host.hostId, question, { generation: host.generation, epoch: host.tspEpoch })).catch(() => {});
} }));

const session = { tabId: "tab-1", projectPath: "/project", sessionFile: "/sessions/a.jsonl", getSnapshot: () => ({ host: null, guest: null }) } as unknown as SessionController;
const ranCommands = () => mocks.runCommand.mock.calls.map(([id]) => id);

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockClear();
});

describe("parseSlash", () => {
	it("ends the name at whitespace or a colon, like omp", () => {
		expect(parseSlash("/force:bash run it")).toEqual({ name: "force", args: "bash run it" });
		expect(parseSlash("  /mcp   add  ")).toEqual({ name: "mcp", args: "add" });
		expect(parseSlash("hello /settings")).toBeNull();
		expect(parseSlash("/")).toBeNull();
	});
});

describe("routeSlash", () => {
	it("routes TSP side questions to their chat drawer and leaves classic delivery unchanged", async () => {
		const tsp = { ...session, getSnapshot: () => ({ host: { hostId: "tsp-host", transport: "tsp", generation: 2, tspEpoch: 3 }, guest: null }) } as unknown as SessionController;
		expect(await routeSlash(tsp, "/btw How does this work?")).toBe(true);
		expect(mocks.setState.mock.results[0]?.value).toEqual({ btwDrawers: { "tab-1": true } });
		expect(mocks.returnToChat).toHaveBeenCalledOnce();
		expect(mocks.showPane).not.toHaveBeenCalled();
		expect(mocks.setState.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[0]!);
		expect(mocks.invoke).toHaveBeenLastCalledWith("btw:ask", "tsp-host", "How does this work?", { generation: 2, epoch: 3 });
		expect(await routeSlash(tsp, "/btw")).toBe(true);
		expect(mocks.invoke).toHaveBeenLastCalledWith("btw:ask", "tsp-host", "", { generation: 2, epoch: 3 });
		expect(mocks.setState.mock.results[1]?.value).toEqual({ btwDrawers: { "tab-1": true } });
		expect(mocks.returnToChat).toHaveBeenCalledTimes(2);
		expect(mocks.showPane).not.toHaveBeenCalled();
		mocks.invoke.mockClear();
		expect(await routeSlash(session, "/btw How does this work?")).toBe(false);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
	it("leaves native opening errors with the drawer recovery handler", async () => {
		const tsp = { ...session, getSnapshot: () => ({ host: { hostId: "tsp-host", transport: "tsp", generation: 2, tspEpoch: 3 }, guest: null }) } as unknown as SessionController;
		mocks.invoke.mockRejectedValueOnce(new Error("The fixture refused the side question."));
		await expect(routeSlash(tsp, "/btw Question")).resolves.toBe(true);
		expect(mocks.setState.mock.results.map(result => result.value)).toEqual([
			{ btwDrawers: { "tab-1": true } },
		]);
		expect(mocks.showPane).not.toHaveBeenCalled();
	});
	it("refuses app-owned and pass-through slash actions while a TSP approval waits", async () => {
		const blocked = { ...session, getSnapshot: () => ({ host: { transport: "tsp", tspComposer: { blockedBy: "approval" } }, guest: null }) } as unknown as SessionController;
		for (const line of ["/switch", "/goal pause", "/extension-command"]) await expect(routeSlash(blocked, line)).rejects.toThrow("Answer the approval");
		expect(mocks.runCommand).not.toHaveBeenCalled();
		expect(mocks.setMode).not.toHaveBeenCalled();
	});
	it("opens the app's UI for bare commands and keeps them from omp", async () => {
		expect(await routeSlash(session, "/settings")).toBe(true);
		expect(await routeSlash(session, "/tree")).toBe(true);
		expect(await routeSlash(session, "/switch")).toBe(true);
		expect(ranCommands()).toEqual(["app.settings", "chat.tree", "chat.model"]);
	});

	it("shares the Export command for bare export and preserves the themes flag", async () => {
		expect(await routeSlash(session, " /export  ")).toBe(true);
		expect(ranCommands()).toEqual(["chat.export"]);
		expect(await routeSlash(session, "/export --themes")).toBe(true);
		expect(mocks.exportChat).toHaveBeenCalledWith(session, true);
		for (const line of ["/export /tmp/out.html", "/export --themes C:\\chat.html", "/export --other"]) expect(await routeSlash(session, line)).toBe(false);
	});

	it("leaves argument forms the matrix gives to omp", async () => {
		for (const line of ["/fast on", "/goal budget 100k", "/model x", "/mcp list", "/login anthropic", "/switch @smol", "/resume abc123", "/fork elsewhere"]) {
			expect(await routeSlash(session, line), line).toBe(false);
		}
		expect(mocks.runCommand).not.toHaveBeenCalled();
		expect(mocks.toast).not.toHaveBeenCalled();
	});

	it("switches goal state through the extension without typing a command", async () => {
		expect(await routeSlash(session, "/goal pause")).toBe(true);
		expect(mocks.setMode).toHaveBeenCalledWith(session, { mode: "goal", action: "pause" });
		expect(mocks.runCommand).not.toHaveBeenCalled();
	});

	describe("in a chat whose omp is not running", () => {
		const ensureLive = vi.fn<() => Promise<void>>();
		const saved = { ...session, getSnapshot: () => ({ mode: "history", host: null, guest: null }), ensureLive } as unknown as SessionController;
		beforeEach(() => {
			ensureLive.mockReset().mockResolvedValue(undefined);
		});

		it.each(["/restart", "/plan", "/vibe", "/export", "/export --themes", "/goal pause"])("returns %s to the composer when the user declines resuming the chat", async line => {
			ensureLive.mockRejectedValue(new ResumeDeclinedError());
			await expect(routeSlash(saved, line)).rejects.toBeInstanceOf(ResumeDeclinedError);
			expect(mocks.runCommand).not.toHaveBeenCalled();
			expect(mocks.setMode).not.toHaveBeenCalled();
		});

		it("treats starting omp as the whole /restart and runs other commands after it", async () => {
			expect(await routeSlash(saved, "/restart")).toBe(true);
			expect(mocks.runCommand).not.toHaveBeenCalled();
			expect(await routeSlash(saved, "/plan")).toBe(true);
			expect(ranCommands()).toEqual(["chat.plan"]);
			expect(ensureLive).toHaveBeenCalledTimes(2);
			expect(await routeSlash(saved, "/settings")).toBe(true);
			expect(ensureLive).toHaveBeenCalledTimes(2);
		});
	});

	it("opens the native advisor configuration while leaving runtime toggles to omp", async () => {
		expect(await routeSlash(session, "/advisor configure")).toBe(true);
		expect(ranCommands()).toEqual(["chat.advisor"]);
		expect(await routeSlash(session, "/advisor on")).toBe(false);
	});

	it("routes the bare subcommands the matrix names", async () => {
		expect(await routeSlash(session, "/mcp add")).toBe(true);
		expect(await routeSlash(session, "/usage show")).toBe(true);
		expect(await routeSlash(session, "/memory VIEW")).toBe(true);
		expect(ranCommands()).toEqual(["manage.mcp", "manage.usage", "manage.memory"]);
		expect(await routeSlash(session, "/marketplace install")).toBe(true);
		expect(mocks.openSettings).toHaveBeenCalledWith("skills", { projectPath: "/project", sectionProps: { tab: "plugins" } });
		expect(await routeSlash(session, "/marketplace install foo@bar")).toBe(false);
	});

	it("resolves aliases to their command", async () => {
		expect(await routeSlash(session, "/models")).toBe(true);
		expect(await routeSlash(session, "/providers")).toBe(true);
		expect(await routeSlash(session, "/rewind")).toBe(true);
		expect(await routeSlash(session, "/q")).toBe(true);
		expect(ranCommands()).toEqual(["manage.roles", "manage.providers", "chat.tree", "chat.close"]);
		expect(await routeSlash(session, "/plugin")).toBe(true);
		expect(mocks.openSettings).toHaveBeenCalledWith("skills", expect.objectContaining({ sectionProps: { tab: "plugins" } }));
	});

	it("routes subagents like hub while leaving argument forms to omp", async () => {
		expect(await routeSlash(session, "/hub")).toBe(true);
		expect(await routeSlash(session, "/subagents")).toBe(true);
		expect(ranCommands()).toEqual(["panes.show.tasks", "panes.show.tasks"]);
		expect(await routeSlash(session, "/subagents details")).toBe(false);
		expect(await routeSlash(session, "/local")).toBe(false);
		expect(await routeSlash(session, "/local notes.md")).toBe(false);
		expect(await routeSlash(session, "/context")).toBe(false);
		expect(await routeSlash(session, "/forget-approvals")).toBe(false);
	});

	it("refuses commands that break how the app hosts omp, with a reason and the app's way", async () => {
		for (const line of ["/collab stop", "/collab", "/collab https://relay.example", "/leave", "/fork pane"]) {
			expect(await routeSlash(session, line), line).toBe(true);
		}
		expect(mocks.runCommand).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledTimes(5);
		const first = mocks.toast.mock.calls[0]?.[0];
		expect(first).toMatchObject({ tone: "warn", message: "slash.guard.notSent", description: "slash.guard.collab" });
		first.action.onClick();
		expect(mocks.openSheet).toHaveBeenCalledWith("share", { tabId: "tab-1", tab: "invite" });
	});

	it("lets omp move the current session and create its own worktree", async () => {
		for (const line of ["/move ../other", "/wt feature", "/worktree"]) expect(await routeSlash(session, line)).toBe(false);
		expect(mocks.toast).not.toHaveBeenCalled();
	});

	it("lets the collab reports through and refuses /join without offering Share", async () => {
		expect(await routeSlash(session, "/collab list")).toBe(false);
		expect(await routeSlash(session, "/collab STATUS")).toBe(false);
		expect(await routeSlash(session, "/join https://relay/x")).toBe(true);
		expect(mocks.toast).toHaveBeenCalledTimes(1);
		expect(mocks.toast.mock.calls[0]?.[0]).toMatchObject({ description: "slash.guard.join", action: undefined });
	});

	it("asks omp for a fresh listing after a typed line that can change the commands", async () => {
		mocks.invoke.mockResolvedValue({ commands: [], complete: true });
		await slashCommands("/other");
		expect(mocks.invoke).toHaveBeenLastCalledWith("composer:slashCommands", "/other", false);
		expect(await routeSlash({ ...session, projectPath: "/other" } as unknown as SessionController, "/reload-plugins")).toBe(false);
		await slashCommands("/other");
		expect(mocks.invoke).toHaveBeenLastCalledWith("composer:slashCommands", "/other", true);
	});

	it("sends a line to omp when the app command isn't available", async () => {
		mocks.runCommand.mockReturnValueOnce(false);
		expect(await routeSlash(session, "/share")).toBe(false);
	});

	it("opens the thinking picker, chat search and trash confirmation", async () => {
		expect(await routeSlash(session, "/effort")).toBe(true);
		expect(mocks.openThinking).toHaveBeenCalledWith("tab-1");
		expect(await routeSlash(session, "/effort high")).toBe(false);
		expect(await routeSlash(session, "/resume")).toBe(true);
		expect(mocks.focusChatSearch).toHaveBeenCalled();
		expect(await routeSlash(session, "/session delete")).toBe(true);
		expect(mocks.openSheet).toHaveBeenCalledWith("chat-trash", { tabId: "tab-1" });
		expect(await routeSlash(session, "/session info")).toBe(false);
	});

	it("explains instead of deleting a chat that has no session file", async () => {
		const unsaved = { ...session, sessionFile: null } as unknown as SessionController;
		expect(await routeSlash(unsaved, "/delete")).toBe(true);
		expect(mocks.openSheet).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ message: "slash.guard.unsaved" }));
	});

	it("ignores skills, custom commands and unknown names", async () => {
		for (const line of ["/skill:pdf make one", "/review", "/nonsense", "/constructor"]) {
			expect(await routeSlash(session, line), line).toBe(false);
		}
	});
});
