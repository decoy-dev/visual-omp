// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { getCommand } from "../../registry/commands";
import type { SessionController } from "../../state/session";
import "./commands";

const fake = vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin" } });
	return { transport: "classic" as "classic" | "tsp" | undefined, open: vi.fn(), terminalTabId: null as string | null, tabs: [] as { id: string }[], closeAll: vi.fn(), activate: vi.fn(), focused: "tab" };
});
vi.mock("../../state/app", () => ({
	canReopenChat: () => false, closeAllChats: fake.closeAll, closeChat: vi.fn(), closeIdleChats: vi.fn(),
	controllerFor: () => ({ tabId: "tab", getSnapshot: () => ({ host: { transport: fake.transport } }) }),
	focusedTabId: () => fake.focused,
	useApp: { getState: () => ({ terminalTabId: fake.terminalTabId, openTerminal: fake.open, tabs: fake.tabs, activateTab: fake.activate }) },
}));
vi.mock("../../shell/hooks", () => ({ chatStatus: () => "idle" }));
vi.mock("../../ui", () => ({ toast: vi.fn() }));
vi.mock("./run", () => ({ runCommand: vi.fn() }));
vi.mock("./TerminalSheet", () => ({ terminalSheet: { requestClose: null } }));

it.each(["tsp", "classic", undefined] as const)("names the palette entry and hint for a %s host and opens that chat", transport => {
	fake.transport = transport; fake.terminalTabId = null; fake.open.mockClear();
	const command = getCommand("view.terminal")!;
	expect(i18n.t(command.title)).toBe(transport === "tsp" ? "Show omp screen" : "Show omp terminal");
	expect(i18n.t(command.hint!)).toBe(transport === "tsp" ? "Open omp's menus and settings for this chat." : "Open omp's terminal screen for this chat.");
	// This command reads only the originating controller's tab id.
	const session = { tabId: "tab" } as SessionController;
	command.run({ session, projectPath: null });
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});

it("offers Close all chats only with open tabs and uses the shared confirmation operation", async () => {
	const command = getCommand("chat.closeAll")!;
	const context = { session: null, projectPath: null };
	fake.tabs = [];
	expect(command.when?.(context)).toBe(false);
	fake.tabs = [{ id: "tab" }];
	expect(command.when?.(context)).toBe(true);
	expect(i18n.t(command.title)).toBe("Close all chats");
	await command.run(context);
	expect(fake.closeAll).toHaveBeenCalledOnce();
});

it("cycles chats in the reordered tabs sequence", () => {
	fake.tabs = [{ id: "third" }, { id: "first" }, { id: "second" }];
	fake.focused = "first";
	getCommand("view.nextTab")!.run({ session: null, projectPath: null });
	expect(fake.activate).toHaveBeenLastCalledWith("second");
	getCommand("view.prevTab")!.run({ session: null, projectPath: null });
	expect(fake.activate).toHaveBeenLastCalledWith("third");
});
