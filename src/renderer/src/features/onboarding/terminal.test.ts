// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { CommandRun } from "./terminal";

const listeners = new Map<string, (event: unknown) => void>();
const invoke = vi.fn();
const off = vi.fn();
const options = { command: "omp login google-antigravity", cwd: "/isolated", cols: 88, rows: 18 };

beforeEach(() => {
	vi.clearAllMocks();
	listeners.clear();
	invoke.mockResolvedValue("login-terminal");
	Object.assign(window, { vomp: {
		invoke,
		on: (channel: string, listener: (event: unknown) => void) => {
			listeners.set(channel, listener);
			return off;
		},
	} });
});

it("forwards typed risk answers exactly and never submits an answer on its own", async () => {
	const run = await CommandRun.start(options);
	expect(invoke).toHaveBeenCalledExactlyOnceWith("term:start", options);
	run.write("yes");
	expect(invoke).toHaveBeenLastCalledWith("term:write", "login-terminal", "yes");
	expect(invoke).toHaveBeenCalledTimes(2);
	run.write("\x7f\x7f\x7fno\r");
	expect(invoke).toHaveBeenLastCalledWith("term:write", "login-terminal", "\x7f\x7f\x7fno\r");
	listeners.get("term:exit")!({ termId: "login-terminal", code: 1 });
	run.write("yes\r");
	expect(invoke).toHaveBeenCalledTimes(3);
	expect(run.exitCode).toBe(1);
	expect(off).toHaveBeenCalledTimes(2);
});

it("replays an early warning and cancellation to a terminal attached after startup", async () => {
	invoke.mockImplementation(async () => {
		listeners.get("term:data")!({ termId: "another-terminal", data: "Ignore this output" });
		listeners.get("term:data")!({ termId: "login-terminal", data: "Type yes to accept the risk" });
		listeners.get("term:exit")!({ termId: "login-terminal", code: 1 });
		return "login-terminal";
	});
	const run = await CommandRun.start(options);
	const data = vi.fn();
	const exit = vi.fn();
	run.attach({ data, exit });
	expect(data).toHaveBeenCalledExactlyOnceWith("Type yes to accept the risk");
	expect(exit).toHaveBeenCalledExactlyOnceWith(1);
	expect(invoke).toHaveBeenCalledExactlyOnceWith("term:start", options);
});
