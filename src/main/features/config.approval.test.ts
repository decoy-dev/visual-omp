import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalState } from "@shared/contracts/config";
import type { RpcRequestOptions } from "../omp/rpc";
import { register } from "./config";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	mode: "always-ask-cached" as unknown,
	values: ["always-ask", "always-ask-cached", "write", "yolo"],
	write: vi.fn(),
	rpc: vi.fn(),
	cli: vi.fn(),
}));
vi.mock("../ipc", () => ({
	handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler),
	broadcast: vi.fn(),
}));
vi.mock("../prefs", () => ({ getPrefs: () => ({ newUserApproval: "done" }), setPrefs: vi.fn() }));
vi.mock("../omp/cli", () => ({
	runOmp: async (args: string[]) => {
		fake.cli(args);
		return {
			code: 0,
			stderr: "",
			stdout: args[0] === "config" ? "{}" : args[1] === "cfg://tools.approvalMode"
				? `tools.approvalMode: ${JSON.stringify(fake.mode)}\ntype: enum\ndefault: "yolo"\nsource: project config\nvalues: [${fake.values.join(", ")}]\ndescription: Approval mode`
				: 'tools.approval: {"read":"prompt","bash":"future-policy"}\ntype: record\ndefault: {}\nsource: global config\ndescription: Tool policies',
		};
	},
}));
vi.mock("../omp/config-file", () => ({
	NEUTRAL_CWD: "/tmp",
	configFile: async (scope: string) => `/tmp/${scope}.yml`,
	setConfigPath: (...args: unknown[]) => fake.write(...args),
}));
vi.mock("../omp/rpc", () => ({ rpcRequest: (...args: unknown[]) => fake.rpc(...args) }));

register();
const call = (channel: string, ...args: unknown[]) => fake.handlers.get(channel)!(...args);

beforeEach(() => {
	fake.mode = "always-ask-cached";
	fake.values = ["always-ask", "always-ask-cached", "write", "yolo"];
	fake.write.mockReset();
	fake.rpc.mockReset();
	fake.cli.mockClear();
});

describe("approval configuration", () => {
	it("reads Ask and remember, all supported choices and per-tool policies", async () => {
		await expect(call("config:approval", "/tmp/project")).resolves.toMatchObject({
			mode: "always-ask-cached", rawMode: "always-ask-cached", modeSource: "project",
			supportedModes: ["always-ask", "always-ask-cached", "write", "yolo"],
			policies: [{ tool: "read", policy: "prompt", source: "global" }],
			unrecognized: [{ tool: "bash", value: "future-policy" }],
		});
	});

	it.each(["future-approval-mode", 42, null, { future: true }])("keeps an unknown raw mode %j without throwing or claiming another mode", async raw => {
		fake.mode = raw;
		const state = await call("config:approval") as ApprovalState;
		expect(state.mode).toBeNull();
		expect(state.rawMode).toEqual(raw);
		expect(fake.write).not.toHaveBeenCalled();
	});

	it("writes Ask and remember without an older schema capability gate", async () => {
		fake.values = ["always-ask", "write", "yolo"];
		await call("config:approval:setMode", "always-ask-cached", "project", "/tmp/project");
		expect(fake.write).toHaveBeenCalledWith("project", "/tmp/project", ["tools", "approvalMode"], "always-ask-cached");
		await expect(call("config:approval")).resolves.toMatchObject({ supportedModes: ["always-ask", "always-ask-cached", "write", "yolo"] });
	});

	it("filters future schema choices while keeping their effective value", async () => {
		fake.values.push("future-mode");
		fake.mode = "future-mode";
		await expect(call("config:approval")).resolves.toMatchObject({ mode: null, rawMode: "future-mode", supportedModes: ["always-ask", "always-ask-cached", "write", "yolo"] });
	});
});

describe("forget remembered approvals", () => {
	it("sends only the builtin through a no-session RPC and returns omp's output", async () => {
		fake.rpc.mockImplementation(async (_cwd: string, _type: string, options: RpcRequestOptions) => {
			options.onMessage?.({ type: "command_output", text: "Remembered approvals forgotten; the next read or write asks again." });
			return { agentInvoked: false };
		});
		await expect(call("config:approval:forget")).resolves.toContain("Remembered approvals forgotten");
		expect(fake.rpc).toHaveBeenCalledWith("/tmp", "prompt", expect.objectContaining({ flags: expect.arrayContaining(["--no-session", "--no-tools", "--no-extensions"]) }), { message: "/forget-approvals" });
	});

	it("runs the builtin without probing for older remembered-approval support", async () => {
		fake.values = ["always-ask", "write", "yolo"];
		fake.rpc.mockImplementation(async (_cwd: string, _type: string, options: RpcRequestOptions) => {
			options.onMessage?.({ type: "command_output", text: "Remembered approvals forgotten." });
			return { agentInvoked: false };
		});
		await expect(call("config:approval:forget")).resolves.toContain("Remembered approvals forgotten");
		expect(fake.cli).not.toHaveBeenCalled();
	});

	it.each([undefined, { agentInvoked: true }, { agentInvoked: false }])("does not claim success without output and a consumed builtin response %j", async response => {
		fake.rpc.mockResolvedValue(response);
		await expect(call("config:approval:forget")).rejects.toThrow("did not confirm");
		expect(fake.rpc).toHaveBeenCalledTimes(1);
	});
});
