import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommandSpec } from "../../registry/commands";
import type { SessionController } from "../../state/session";
import type { CommandOptions, CommandResult } from "./drive";
import "./modes";

const fake = vi.hoisted(() => ({
	commands: new Map<string, CommandSpec>(), runCommand: vi.fn(), runAndReport: vi.fn(),
	toast: vi.fn(), openTerminal: vi.fn(), readyEditor: vi.fn(), invoke: vi.fn(), reportFailure: vi.fn(),
}));
vi.mock("@/ui", () => ({ Button: vi.fn(), Dialog: vi.fn(), DialogContent: vi.fn(), Input: vi.fn(), Textarea: vi.fn(), toast: fake.toast }));
vi.mock("../../registry/commands", () => ({ registerCommand: (spec: CommandSpec) => fake.commands.set(spec.id, spec) }));
vi.mock("../../registry/slots", () => ({ sheets: { register: vi.fn() } }));
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: vi.fn() }));
vi.mock("../../state/app", () => ({ controllerFor: vi.fn(), useApp: { getState: () => ({ openTerminal: fake.openTerminal }) } }));
vi.mock("./approval", () => ({ setApprovalMode: vi.fn(), acknowledgeAuto: vi.fn() }));
vi.mock("./drive", async () => ({ ...await vi.importActual<object>("./drive"), readyEditor: fake.readyEditor, reportFailure: fake.reportFailure, runCommand: fake.runCommand, runAndReport: fake.runAndReport }));
vi.mock("./plan", () => ({ exitPlan: vi.fn(), togglePlan: vi.fn() }));
vi.mock("./status", () => ({ useOmpScreen: vi.fn() }));
vi.mock("./pickers", () => ({ usePickerRequests: {} }));
vi.mock("./nativeModes", () => ({ sessionModes: vi.fn(), setSessionMode: vi.fn() }));

beforeEach(() => {
	fake.runCommand.mockReset().mockResolvedValue({ output: [], screen: [] });
	fake.runAndReport.mockReset().mockResolvedValue({ output: [], screen: [] });
	fake.toast.mockClear(); fake.openTerminal.mockClear();
	fake.readyEditor.mockReset().mockResolvedValue([]);
	fake.reportFailure.mockClear();
	fake.invoke.mockReset().mockResolvedValue({ path: exportPath, command: `/export ${exportPath}` });
	vi.stubGlobal("window", { vomp: { invoke: fake.invoke } });
});
afterEach(() => vi.unstubAllGlobals());
const exportPath = "C:\\fixture\\omp-session-chat.html";
const session = (transport: "tsp" | "classic") => ({ tabId: "chat", sessionFile: "C:\\sessions\\chat.jsonl", projectPath: "C:\\fixture", getSnapshot: () => ({ host: { transport } }) }) as unknown as SessionController;

it("reports TSP security feedback through notices without inventing a success toast or a second command", async () => {
	const chat = session("tsp");
	await fake.commands.get("chat.security")!.run({ session: chat, projectPath: "/tmp" });
	expect(fake.runCommand).toHaveBeenCalledExactlyOnceWith(chat, "/security scan", expect.objectContaining({ screenIntent: "request" }));
	expect(fake.toast).not.toHaveBeenCalled();
});

it("requests TSP cleanse live-board presentation without opening the classic sheet directly", async () => {
	const chat = session("tsp");
	await fake.commands.get("chat.cleanse")!.run({ session: chat, projectPath: "/tmp" });
	expect(fake.runAndReport).toHaveBeenCalledExactlyOnceWith(chat, "/cleanse", { screenIntent: "request" });
	expect(fake.openTerminal).not.toHaveBeenCalled();
});

it("preserves classic security disabled-result reporting", async () => {
	fake.runCommand.mockResolvedValue({ output: ["Security is disabled"], screen: [] });
	await fake.commands.get("chat.security")!.run({ session: session("classic"), projectPath: "/tmp" });
	expect(fake.runCommand).toHaveBeenCalledOnce();
	expect(fake.toast).toHaveBeenCalledWith({ tone: "warn", message: expect.any(String) });
});

it("preserves classic cleanse opening when the painted editor is replaced", async () => {
	await fake.commands.get("chat.cleanse")!.run({ session: session("classic"), projectPath: "/tmp" });
	expect(fake.openTerminal).toHaveBeenCalledExactlyOnceWith("chat");
});

it("displays native export success and preserves the complete path in its Show action", async () => {
	const chat = session("tsp");
	const result: CommandResult = { output: [`Session exported to: ${exportPath}`], screen: [], status: "success" };
	fake.runCommand.mockImplementation(async (_session: SessionController, _line: string, options: CommandOptions) => {
		expect(options.present?.(result)).toBe(true);
		return result;
	});
	await fake.commands.get("chat.export")!.run({ session: chat, projectPath: chat.projectPath });
	expect(fake.readyEditor).toHaveBeenCalledExactlyOnceWith(chat);
	expect(fake.invoke).toHaveBeenCalledExactlyOnceWith("share:defaultExport", chat.sessionFile, chat.projectPath, false);
	expect(fake.runCommand).toHaveBeenCalledExactlyOnceWith(chat, `/export ${exportPath}`, expect.anything());
	expect(fake.reportFailure).not.toHaveBeenCalled();
	expect(fake.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "ok", message: result.output[0] }));
	fake.toast.mock.calls[0]![0].action.onClick();
	expect(fake.invoke).toHaveBeenLastCalledWith("app:showItem", exportPath);
});

it("displays native export failures as errors without requiring an Error prefix or offering Show", async () => {
	const result: CommandResult = { output: ["Failed to export session: destination is read-only", "Choose another destination."], screen: [], status: "error" };
	fake.runCommand.mockImplementation(async (_session: SessionController, _line: string, options: CommandOptions) => {
		expect(options.present?.(result)).toBe(true);
		return result;
	});
	const chat = session("tsp");
	await fake.commands.get("chat.export")!.run({ session: chat, projectPath: chat.projectPath });
	expect(fake.invoke).toHaveBeenCalledExactlyOnceWith("share:defaultExport", chat.sessionFile, chat.projectPath, false);
	expect(fake.runCommand).toHaveBeenCalledExactlyOnceWith(chat, `/export ${exportPath}`, expect.anything());
	expect(fake.reportFailure).not.toHaveBeenCalled();
	expect(fake.toast).toHaveBeenCalledExactlyOnceWith({ tone: "err", message: result.output.join("\n") });
});
