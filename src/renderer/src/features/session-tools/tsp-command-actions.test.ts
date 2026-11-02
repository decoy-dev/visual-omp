import { beforeEach, expect, it, vi } from "vitest";
import type { CommandSpec } from "../../registry/commands";
import type { SessionController } from "../../state/session";
import type { CommandOptions, CommandResult } from "./drive";
import "./modes";

const fake = vi.hoisted(() => ({
	commands: new Map<string, CommandSpec>(), runCommand: vi.fn(), runAndReport: vi.fn(),
	toast: vi.fn(), openTerminal: vi.fn(),
}));
vi.mock("@/ui", () => ({ Button: vi.fn(), Dialog: vi.fn(), DialogContent: vi.fn(), Input: vi.fn(), Textarea: vi.fn(), toast: fake.toast }));
vi.mock("../../registry/commands", () => ({ registerCommand: (spec: CommandSpec) => fake.commands.set(spec.id, spec) }));
vi.mock("../../registry/slots", () => ({ sheets: { register: vi.fn() } }));
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: vi.fn() }));
vi.mock("../../state/app", () => ({ controllerFor: vi.fn(), useApp: { getState: () => ({ openTerminal: fake.openTerminal }) } }));
vi.mock("./approval", () => ({ setApprovalMode: vi.fn(), acknowledgeAuto: vi.fn() }));
vi.mock("./drive", async () => ({ ...await vi.importActual<object>("./drive"), reportFailure: vi.fn(), runCommand: fake.runCommand, runAndReport: fake.runAndReport }));
vi.mock("./plan", () => ({ exitPlan: vi.fn(), togglePlan: vi.fn() }));
vi.mock("./status", () => ({ useOmpScreen: vi.fn() }));
vi.mock("./pickers", () => ({ usePickerRequests: {} }));
vi.mock("./nativeModes", () => ({ sessionModes: vi.fn(), setSessionMode: vi.fn() }));

beforeEach(() => {
	fake.runCommand.mockReset().mockResolvedValue({ output: [], screen: [] });
	fake.runAndReport.mockReset().mockResolvedValue({ output: [], screen: [] });
	fake.toast.mockClear(); fake.openTerminal.mockClear();
});
const session = (transport: "tsp" | "classic") => ({ tabId: "chat", getSnapshot: () => ({ host: { transport } }) }) as unknown as SessionController;

it("reports TSP security feedback through notices without inventing a success toast or a second command", async () => {
	const chat = session("tsp");
	await fake.commands.get("chat.security")!.run({ session: chat, projectPath: "/tmp" });
	expect(fake.runCommand).toHaveBeenCalledExactlyOnceWith(chat, "/security scan", expect.anything());
	expect(fake.toast).not.toHaveBeenCalled();
});

it("leaves TSP cleanse screen opening to OverlayWatcher", async () => {
	await fake.commands.get("chat.cleanse")!.run({ session: session("tsp"), projectPath: "/tmp" });
	expect(fake.runAndReport).toHaveBeenCalledOnce();
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
	const invoke = vi.fn();
	vi.stubGlobal("window", { vomp: { invoke } });
	const result: CommandResult = { output: ["Session exported to: C:\\fixture\\session.html"], screen: [], status: "success" };
	fake.runCommand.mockImplementation(async (_session: SessionController, _line: string, options: CommandOptions) => {
		expect(options.present?.(result)).toBe(true);
		return result;
	});
	await fake.commands.get("chat.export")!.run({ session: session("tsp"), projectPath: "/tmp" });
	expect(fake.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "ok", message: result.output[0] }));
	fake.toast.mock.calls[0]![0].action.onClick();
	expect(invoke).toHaveBeenCalledWith("app:showItem", "C:\\fixture\\session.html");
	vi.unstubAllGlobals();
});

it("displays native export failures as errors without requiring an Error prefix or offering Show", async () => {
	const result: CommandResult = { output: ["Failed to export session: destination is read-only", "Choose another destination."], screen: [], status: "error" };
	fake.runCommand.mockImplementation(async (_session: SessionController, _line: string, options: CommandOptions) => {
		expect(options.present?.(result)).toBe(true);
		return result;
	});
	await fake.commands.get("chat.export")!.run({ session: session("tsp"), projectPath: "/tmp" });
	expect(fake.toast).toHaveBeenCalledExactlyOnceWith({ tone: "err", message: result.output.join("\n") });
});
