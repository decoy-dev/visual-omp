import { beforeEach, expect, it, vi } from "vitest";
import { runOmp } from "./cli";

const fake = vi.hoisted(() => ({ exec: vi.fn(), locate: vi.fn(), env: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: fake.exec }));
vi.mock("./locate", () => ({ ompPath: fake.locate }));
vi.mock("../env", () => ({ userEnv: fake.env }));
vi.mock("./refused", () => ({ ompStartError: async (error: unknown) => error }));

beforeEach(() => {
	vi.resetAllMocks();
	fake.locate.mockResolvedValue("C:\\Program Files\\Bun\\omp.exe");
	fake.env.mockResolvedValue({ PATH: "user path", HOME: "C:\\Users\\A User" });
	fake.exec.mockImplementation((_bin, _argv, _options, callback) => callback(null, "Exported to: C:\\project folder\\chat.html\r\n", ""));
});

it("executes CLI export with the located binary, inherited environment, timeout and exact argv, without a shell", async () => {
	const argv = ["--export", "C:\\sessions folder\\chat.jsonl", "C:\\project folder\\chat & notes.html"];
	await expect(runOmp(argv, { cwd: "C:\\project folder", timeoutMs: 180_000 })).resolves.toEqual({ code: 0, stdout: "Exported to: C:\\project folder\\chat.html\r\n", stderr: "" });
	expect(fake.locate).toHaveBeenCalledWith({ allowUnsupported: undefined });
	expect(fake.exec).toHaveBeenCalledWith("C:\\Program Files\\Bun\\omp.exe", argv, {
		cwd: "C:\\project folder", env: { PATH: "user path", HOME: "C:\\Users\\A User", NO_COLOR: "1" }, timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
	}, expect.any(Function));
	expect(fake.exec.mock.calls[0]?.[2]).not.toHaveProperty("shell");
});
