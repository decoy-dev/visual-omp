import { type ChildProcess, execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeTeardownError, terminateOfficeTree } from "./preview-office-process";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const child = { pid: 123456 } as ChildProcess;
describe("confirmed Office process-tree teardown", () => {
	it("awaits successful taskkill without requiring a child close event", async () => {
		const callback = Promise.withResolvers<(error: Error | null) => void>();
		vi.mocked(execFile).mockImplementation((...args: unknown[]) => { callback.resolve(args.at(-1) as (error: Error | null) => void); return {} as never; });
		const pending = terminateOfficeTree(child, "C:\\Windows\\taskkill.exe", "win32");
		let settled = false; void pending.then(() => { settled = true; });
		const finish = await callback.promise; expect(settled).toBe(false);
		finish(null); await pending;
		expect(execFile).toHaveBeenCalledWith("C:\\Windows\\taskkill.exe", ["/pid", "123456", "/T", "/F"], expect.objectContaining({ timeout: 5000 }), expect.any(Function));
	});
	it("reports taskkill failure when the child never emits close", async () => {
		vi.mocked(execFile).mockImplementation((...args: unknown[]) => { (args.at(-1) as (error: Error) => void)(new Error("Access denied")); return {} as never; });
		await expect(terminateOfficeTree(child, "taskkill.exe", "win32")).rejects.toBeInstanceOf(OfficeTeardownError);
	});
	it("bounds a taskkill that never invokes its callback", async () => {
		vi.useFakeTimers(); vi.mocked(execFile).mockReturnValue({} as never);
		const pending = terminateOfficeTree(child, "taskkill.exe", "win32");
		const failed = expect(pending).rejects.toBeInstanceOf(OfficeTeardownError);
		await vi.advanceTimersByTimeAsync(5000); await failed;
	});
	it("confirms a POSIX group is gone after SIGKILL", async () => {
		const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => { if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return true; });
		await terminateOfficeTree(child, null, "darwin");
		expect(kill).toHaveBeenCalledWith(-123456, "SIGKILL"); expect(kill).toHaveBeenCalledWith(-123456, 0);
	});
});
