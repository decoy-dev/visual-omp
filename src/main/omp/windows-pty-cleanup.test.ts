import { once } from "node:events";
import { Worker } from "node:worker_threads";
import type { IPty } from "node-pty";
import { describe, expect, it, vi } from "vitest";
import { releaseWindowsConpty } from "./windows-pty-cleanup";

function fixture(worker: Pick<Worker, "threadId" | "terminate">, useConptyDll = true) {
	const input = { destroy: vi.fn() };
	const output = { destroy: vi.fn() };
	const pty = {
		pid: 1, cols: 80, rows: 24, process: "omp", handleFlowControl: false,
		onData: vi.fn(() => ({ dispose() {} })), onExit: vi.fn(() => ({ dispose() {} })),
		resize: vi.fn(), clear: vi.fn(), write: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
		_agent: { _useConpty: true, _useConptyDll: useConptyDll, _inSocket: input, _outSocket: output, _conoutSocketWorker: { _worker: worker } },
	} satisfies IPty & { _agent: unknown };
	return { pty, input, output };
}

describe("post-exit Windows ConPTY cleanup", () => {
	it.each([true, false])("releases both pipes and awaits worker termination for bundled=%s without another native kill", async bundled => {
		const terminated = Promise.withResolvers<number>();
		const worker = { threadId: 42, terminate: vi.fn(() => terminated.promise) };
		const { pty, input, output } = fixture(worker, bundled);
		let completed = false;
		const cleanup = releaseWindowsConpty(pty, "win32").then(() => { completed = true; });
		expect(input.destroy).toHaveBeenCalledOnce();
		expect(output.destroy).toHaveBeenCalledOnce();
		expect(worker.terminate).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(completed).toBe(false);
		worker.threadId = -1;
		terminated.resolve(1);
		await cleanup;
		expect(completed).toBe(true);
		expect(pty.kill).not.toHaveBeenCalled();
		await releaseWindowsConpty(pty, "win32");
		expect(worker.terminate).toHaveBeenCalledOnce();
	});

	it("terminates a real referenced worker and leaves its thread exited", async () => {
		// This resource regression requires a real worker, rather than a mocked exit callback.
		const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
		try {
			await once(worker, "online");
			const { pty } = fixture(worker);
			await releaseWindowsConpty(pty, "win32");
			expect(worker.threadId).toBe(-1);
			expect(pty.kill).not.toHaveBeenCalled();
		} finally { if (worker.threadId !== -1) await worker.terminate(); }
	});

	it("does not inspect Windows private state on other platforms", async () => {
		const { pty } = fixture({ threadId: -1, terminate: vi.fn() });
		Object.defineProperty(pty, "_agent", { get() { throw new Error("must not inspect"); } });
		await expect(releaseWindowsConpty(pty, "darwin")).resolves.toBeUndefined();
	});

	it("leaves the WinPTY backend alone", async () => {
		const worker = { threadId: 42, terminate: vi.fn() };
		const { pty, input, output } = fixture(worker);
		pty._agent._useConpty = false;
		await releaseWindowsConpty(pty, "win32");
		expect(input.destroy).not.toHaveBeenCalled();
		expect(output.destroy).not.toHaveBeenCalled();
		expect(worker.terminate).not.toHaveBeenCalled();
	});

	it("rejects a changed private interface instead of silently retaining resources", async () => {
		const { pty } = fixture({ threadId: 42, terminate: vi.fn() });
		Object.assign(pty, { _agent: { _useConpty: true } });
		await expect(releaseWindowsConpty(pty, "win32")).rejects.toThrow("review the 1.1.0 cleanup adapter");
	});

	it("surfaces worker termination failure after releasing the pipe handles", async () => {
		const worker = { threadId: 42, terminate: vi.fn().mockRejectedValue(new Error("worker termination failed")) };
		const { pty, input, output } = fixture(worker);
		await expect(releaseWindowsConpty(pty, "win32")).rejects.toThrow("worker termination failed");
		expect(input.destroy).toHaveBeenCalledOnce();
		expect(output.destroy).toHaveBeenCalledOnce();
		expect(pty.kill).not.toHaveBeenCalled();
	});
});
