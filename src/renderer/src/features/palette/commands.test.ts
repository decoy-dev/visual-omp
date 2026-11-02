// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { getCommand } from "../../registry/commands";
import type { SessionController } from "../../state/session";
import "./commands";

const fake = vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin" } });
	return { transport: "classic" as "classic" | "tsp" | undefined, open: vi.fn(), terminalTabId: null as string | null };
});
vi.mock("../../state/app", () => ({
	canReopenChat: () => false, closeChat: vi.fn(),
	controllerFor: () => ({ tabId: "tab", getSnapshot: () => ({ host: { transport: fake.transport } }) }),
	focusedTabId: () => "tab",
	useApp: { getState: () => ({ terminalTabId: fake.terminalTabId, openTerminal: fake.open }) },
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
