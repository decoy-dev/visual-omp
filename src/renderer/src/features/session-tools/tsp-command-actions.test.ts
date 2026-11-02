import { beforeEach, expect, it, vi } from "vitest";
import type { CommandSpec } from "../../registry/commands";
import type { SessionController } from "../../state/session";
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
vi.mock("./drive", () => ({ reportFailure: vi.fn(), runCommand: fake.runCommand, runAndReport: fake.runAndReport }));
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
