import { beforeEach, describe, expect, it, vi } from "vitest";
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
		openThinking: vi.fn(),
		focusChatSearch: vi.fn(),
		toast: vi.fn(),
	};
});
vi.mock("@/ui", () => ({ toast: mocks.toast }));
vi.mock("../../i18n", () => ({ i18n: { t: (key: string) => key.replace(/^composer:/, "") } }));
vi.mock("../palette/run", () => ({ runCommand: mocks.runCommand }));
vi.mock("../../state/navigation", () => ({ openSettings: mocks.openSettings }));
vi.mock("../../state/app", () => ({ useApp: { getState: () => ({ openSheet: mocks.openSheet }) } }));
vi.mock("../../shell/Sidebar", () => ({ focusChatSearch: mocks.focusChatSearch }));
vi.mock("./pickers", () => ({ usePickerRequests: { getState: () => ({ openThinking: mocks.openThinking }) } }));

const session = { tabId: "tab-1", projectPath: "/project", sessionFile: "/sessions/a.jsonl" } as unknown as SessionController;
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
	it("opens the app's UI for bare commands and keeps them from omp", async () => {
		expect(await routeSlash(session, "/settings")).toBe(true);
		expect(await routeSlash(session, "/tree")).toBe(true);
		expect(await routeSlash(session, "/switch")).toBe(true);
		expect(ranCommands()).toEqual(["app.settings", "chat.tree", "chat.model"]);
	});

	it("leaves argument forms the matrix gives to omp", async () => {
		for (const line of ["/fast on", "/goal pause", "/model x", "/mcp list", "/login anthropic", "/switch @smol", "/resume abc123", "/fork elsewhere"]) {
			expect(await routeSlash(session, line), line).toBe(false);
		}
		expect(mocks.runCommand).not.toHaveBeenCalled();
		expect(mocks.toast).not.toHaveBeenCalled();
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

	it("refuses commands that break how the app hosts omp, with a reason and the app's way", async () => {
		for (const line of ["/collab stop", "/collab", "/collab https://relay.example", "/leave", "/move ../other", "/wt feature", "/fork pane"]) {
			expect(await routeSlash(session, line), line).toBe(true);
		}
		expect(mocks.runCommand).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledTimes(7);
		const first = mocks.toast.mock.calls[0]?.[0];
		expect(first).toMatchObject({ tone: "warn", message: "slash.guard.notSent", description: "slash.guard.collab" });
		first.action.onClick();
		expect(mocks.openSheet).toHaveBeenCalledWith("share", { tabId: "tab-1", tab: "invite" });
		mocks.toast.mock.calls[5]?.[0].action.onClick();
		expect(ranCommands()).toEqual(["git.worktree"]);
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
