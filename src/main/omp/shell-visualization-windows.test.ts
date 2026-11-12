import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { createWindowsShellJob, type WindowsShellJob } from "./shell-visualization-windows";
import { SHELL_WINDOWS_MONITOR } from "./shell-visualization-windows-source";

type Helper = EventEmitter & { pid: number; stdin: Writable; stdout: PassThrough; kill: Mock };
const state = vi.hoisted(() => ({ helpers: [] as Helper[], launches: [] as { file: string; args: string[]; options: SpawnOptions }[], commands: [] as string[], autoReady: true, autoSpawn: true, autoSample: true, autoStop: true, exitOnKill: true, rss: 64 * 1024 ** 2 }));
vi.mock("node:child_process", () => ({ spawn(file: string, args: string[], options: SpawnOptions) {
	const helper = new EventEmitter() as Helper;
	helper.pid = 810_000 + state.helpers.length;
	helper.stdout = new PassThrough();
	helper.stdin = new Writable({ write(chunk: Buffer, _encoding, done) {
		const line = chunk.toString().trim(); state.commands.push(line);
		const id = Number(line.split(":")[1]);
		if (line === "start" && state.autoSpawn) queueMicrotask(() => helper.stdout.write(JSON.stringify({ event: "spawned", pid: helper.pid + 100 }) + "\n"));
		if (line.startsWith("sample:") && state.autoSample) queueMicrotask(() => helper.stdout.write(JSON.stringify({ event: "sample", id, rssBytes: state.rss, pids: [helper.pid + 100, helper.pid + 101], cpuMs: 1, helperRssBytes: 16 * 1024 ** 2, memberRssBytes: [32 * 1024 ** 2, 16 * 1024 ** 2] }) + "\n"));
		if (line.startsWith("stop:") && state.autoStop) queueMicrotask(() => helper.stdout.write(JSON.stringify({ event: "stopped", id }) + "\n"));
		done();
	} });
	helper.kill = vi.fn(() => { if (state.exitOnKill) queueMicrotask(() => helper.emit("exit", 1, "SIGKILL")); return true; });
	state.helpers.push(helper); state.launches.push({ file, args, options });
	if (state.autoReady) queueMicrotask(() => helper.stdout.write('{"event":"ready"}\n'));
	return helper as unknown as ChildProcess;
} }));
let jobs: WindowsShellJob[];
const loss = vi.fn();
function start() {
	const job = createWindowsShellJob({ powerShell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", script: "C:\\private\\monitor.ps1", config: "C:\\private\\monitor.json", cwd: "C:\\private\\work", env: { HOME: "C:\\private\\home" }, onLoss: loss });
	jobs.push(job); return job;
}
const memory = { jobRssBytes: 48 * 1024 ** 2, monitorRssBytes: 16 * 1024 ** 2, totalRssBytes: 64 * 1024 ** 2 };
function frame(value: unknown) {
	if (value && typeof value === "object" && "event" in value && value.event === "sample" && !Object.hasOwn(value, "helperRssBytes")) {
		const pids = "pids" in value && Array.isArray(value.pids) ? value.pids : [];
		value = { helperRssBytes: 16 * 1024 ** 2, memberRssBytes: pids.length === 1 ? [48 * 1024 ** 2] : pids.length === 0 ? [] : [32 * 1024 ** 2, 16 * 1024 ** 2], ...value };
	}
	state.helpers[0]!.stdout.write(JSON.stringify(value) + "\n");
}
function sampleId() { return Number(state.commands.findLast(line => line.startsWith("sample:"))!.split(":")[1]); }
beforeEach(() => {
	state.helpers = []; state.launches = []; state.commands = []; state.autoReady = true; state.autoSpawn = true; state.autoSample = true; state.autoStop = true; state.exitOnKill = true; state.rss = 64 * 1024 ** 2;
	jobs = []; loss.mockReset();
});
afterEach(async () => {
	state.autoStop = true; state.exitOnKill = true;
	vi.mocked(performance.now).mockRestore?.();
	for (const job of jobs) await job.stop().catch(() => {});
	vi.useRealTimers();
});

it("authorizes target creation only after the helper's ready gate and launches one OS-only helper", async () => {
	state.autoReady = false;
	const job = start();
	expect(state.commands).toEqual([]);
	frame({ event: "ready" });
	await job.started;
	expect(state.commands).toEqual(["start"]);
	expect(state.launches[0]).toMatchObject({ file: expect.stringContaining("System32\\WindowsPowerShell"), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\private\\monitor.ps1", "C:\\private\\monitor.json"], options: { stdio: ["pipe", "pipe", "ignore"], windowsHide: true } });
	expect(state.launches[0]!.options).not.toHaveProperty("shell");
	for (let index = 0; index < 20; index++) expect(await job.sample()).toEqual(memory);
	expect(state.launches).toHaveLength(1);
});

it("accepts a UTF-8 stream observer without changing framing or bounds", async () => {
	const job = start();
	state.helpers[0]!.stdout.setEncoding("utf8");
	await job.started;
	expect(await job.sample()).toEqual(memory);
});

it("cancels startup before creation without sending start or targeting an unverified PID", async () => {
	state.autoReady = false;
	const job = start();
	await job.stop();
	expect(state.commands).toEqual([]);
	expect(state.helpers[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
	frame({ event: "ready" });
	expect(state.commands).toEqual([]);
});

it("requires positive empty-job acknowledgement and helper exit, without taskkill or PID arguments", async () => {
	const job = start(); await job.started;
	const stopped = job.stop();
	await stopped;
	expect(job.stop()).toBe(stopped);
	expect(state.commands).toEqual(["start", "stop:1"]);
	expect(state.helpers[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
	expect(loss).not.toHaveBeenCalled();
});

it.each(["silent", "error", "exit"])("fails closed on %s after target authorization", async mode => {
	vi.useFakeTimers();
	const job = start(); await job.started;
	state.autoStop = false;
	const closing = job.stop();
	const rejected = expect(closing).rejects.toThrow("process tree could not be confirmed stopped");
	if (mode === "error") frame({ event: "error", id: 1 });
	if (mode === "exit") state.helpers[0]!.emit("exit", 1, null);
	else await vi.advanceTimersByTimeAsync(200);
	await rejected;
	expect(job.stop()).toBe(closing);
	expect(state.commands).toEqual(["start", "stop:1"]);
});

it("does not extend the 250 ms close window on repeated job acknowledgement", async () => {
	vi.useFakeTimers();
	const job = start(); await job.started;
	state.autoStop = false; state.exitOnKill = false;
	const closing = job.stop();
	const rejected = expect(closing).rejects.toThrow("process tree could not be confirmed stopped");
	frame({ event: "stopped", id: 1 });
	await vi.advanceTimersByTimeAsync(200);
	frame({ event: "stopped", id: 1 });
	await vi.advanceTimersByTimeAsync(50);
	await rejected;
	expect(state.helpers[0]!.kill).toHaveBeenCalledOnce();
});

it("lets the helper exit use the rest of the close window after an early acknowledgement", async () => {
	// Measured on Windows ARM64: acknowledgement after 16 ms, helper exit 89 ms later, 105 ms in all.
	vi.useFakeTimers();
	const job = start(); await job.started;
	state.autoStop = false; state.exitOnKill = false;
	const closing = job.stop();
	await vi.advanceTimersByTimeAsync(16);
	frame({ event: "stopped", id: 1 });
	await vi.advanceTimersByTimeAsync(89);
	state.helpers[0]!.emit("exit", 1, null);
	await expect(closing).resolves.toBeUndefined();
});

it("gives a late acknowledgement only what remains of the close window", async () => {
	vi.useFakeTimers();
	const job = start(); await job.started;
	state.autoStop = false; state.exitOnKill = false;
	const closing = job.stop();
	const rejected = expect(closing).rejects.toThrow("process tree could not be confirmed stopped");
	await vi.advanceTimersByTimeAsync(190);
	frame({ event: "stopped", id: 1 });
	await vi.advanceTimersByTimeAsync(60);
	await rejected;
});

it("rejects an acknowledgement read after 200 ms even before its overdue timer runs", async () => {
	vi.useFakeTimers();
	const job = start(); await job.started;
	state.autoStop = false; state.exitOnKill = false;
	const closing = job.stop();
	const rejected = expect(closing).rejects.toThrow("process tree could not be confirmed stopped");
	const now = performance.now();
	vi.spyOn(performance, "now").mockReturnValue(now + 210);
	frame({ event: "stopped", id: 1 });
	await rejected;
	expect(state.helpers[0]!.kill).toHaveBeenCalledOnce();
});

it("rejects a helper exit delivered after the close window even before its overdue timer runs", async () => {
	vi.useFakeTimers();
	const job = start(); await job.started;
	state.autoStop = false; state.exitOnKill = false;
	const closing = job.stop();
	const rejected = expect(closing).rejects.toThrow("process tree could not be confirmed stopped");
	await vi.advanceTimersByTimeAsync(16);
	frame({ event: "stopped", id: 1 });
	const now = performance.now();
	vi.spyOn(performance, "now").mockReturnValue(now + 240);
	state.helpers[0]!.emit("exit", 1, null);
	await rejected;
});

it("rejects concurrent sampling, cancels its deadline on close and ignores late responses", async () => {
	const job = start(); await job.started; state.autoSample = false;
	const sample = job.sample(); const rejected = expect(sample).rejects.toThrow("cancelled");
	const id = sampleId();
	await expect(job.sample()).rejects.toThrow("unavailable");
	await job.stop(); await rejected;
	frame({ event: "sample", id, rssBytes: 900 * 1024 ** 2, pids: [810_100], cpuMs: 1 });
	expect(loss).not.toHaveBeenCalled();
	expect(state.commands.filter(line => line.startsWith("sample:"))).toHaveLength(1);
});

it("enforces the existing one-second sample deadline and rejects obsolete completions", async () => {
	vi.useFakeTimers();
	const job = start(); await job.started; state.autoSample = false;
	const pending = job.sample(); const rejected = expect(pending).rejects.toThrow("cancelled");
	const id = sampleId();
	await vi.advanceTimersByTimeAsync(1000); await rejected;
	expect(loss).toHaveBeenCalledExactlyOnceWith("unavailable");
	frame({ event: "sample", id, rssBytes: state.rss, pids: [810_100], cpuMs: 1 });
	expect(loss).toHaveBeenCalledOnce();
});

it.each([
	{ rssBytes: 0 }, { rssBytes: -1 }, { rssBytes: "unknown" }, { pids: [0] }, { pids: [810_000] }, { pids: [810_100, 810_100] }, { pids: Array(4097).fill(810_100) }, { cpuMs: -1 },
])("refuses unverifiable native samples %j", async extra => {
	const job = start(); await job.started; state.autoSample = false;
	const pending = job.sample(); const rejected = expect(pending).rejects.toThrow();
	frame({ event: "sample", id: sampleId(), rssBytes: state.rss, pids: [810_100], cpuMs: 1, ...extra });
	await rejected; expect(loss).toHaveBeenCalledExactlyOnceWith("unavailable");
});

it("treats an empty owned job as process exit, while accepting retained descendants after launcher exit", async () => {
	const job = start(); await job.started; state.autoSample = false;
	const first = job.sample();
	frame({ event: "sample", id: sampleId(), rssBytes: state.rss, pids: [810_101], cpuMs: 1 });
	expect(await first).toEqual(memory);
	const second = job.sample(); const rejected = expect(second).rejects.toThrow();
	frame({ event: "sample", id: sampleId(), rssBytes: 16 * 1024 ** 2, pids: [], cpuMs: 1 });
	await rejected; expect(loss).toHaveBeenCalledExactlyOnceWith("crash");
});

it("bounds malformed or excessive helper output", async () => {
	const job = start(); await job.started;
	state.helpers[0]!.stdout.write(Buffer.alloc(64 * 1024 + 1, 120));
	expect(loss).toHaveBeenCalledExactlyOnceWith("unavailable");
});

it("accepts helper kill errors and pipe closure that race a confirmed job's natural exit", async () => {
	const job = start(); await job.started;
	state.autoStop = false; state.exitOnKill = false;
	state.helpers[0]!.kill.mockImplementationOnce(() => {
		state.helpers[0]!.emit("error", new Error("Process already exiting"));
		return false;
	});
	const closing = job.stop();
	frame({ event: "stopped", id: 1 });
	state.helpers[0]!.stdin.emit("error", new Error("Closed stdin after acknowledgement"));
	state.helpers[0]!.emit("exit", 0, null);
	await closing;
	expect(loss).not.toHaveBeenCalled();
});

it("kills only its retained helper on a broken stop pipe and reports unconfirmed cleanup", async () => {
	const job = start(); await job.started;
	state.autoStop = false;
	const closing = job.stop();
	const rejected = expect(closing).rejects.toThrow("process tree could not be confirmed stopped");
	state.helpers[0]!.stdin.emit("error", new Error("Broken stop pipe"));
	await rejected;
	expect(state.helpers[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});

it("keeps native job ownership atomic and the bootstrap compiler-free", () => {
	expect(SHELL_WINDOWS_MONITOR).toContain("DefinePInvokeMethod");
	expect(SHELL_WINDOWS_MONITOR).not.toMatch(/Add-Type|Get-CimInstance|taskkill|AssignProcessToJobObject/);
	expect(SHELL_WINDOWS_MONITOR).toContain("0x00002000");
	expect(SHELL_WINDOWS_MONITOR).toContain("0x0002000D");
	expect(SHELL_WINDOWS_MONITOR).toContain("IsProcessInJob");
	expect(SHELL_WINDOWS_MONITOR).toContain("TerminateJobObject");
	expect(SHELL_WINDOWS_MONITOR.indexOf(`Write-Protocol '{"event":"ready"}'`)).toBeLessThan(SHELL_WINDOWS_MONITOR.indexOf("if (-not $native::CreateProcessW("));
	expect(SHELL_WINDOWS_MONITOR).toContain("$limitBytes = 144");
	expect(SHELL_WINDOWS_MONITOR).toContain("$startupBytes = 112");
	expect(SHELL_WINDOWS_MONITOR).toContain("$attributeOffset = 104");
	expect(SHELL_WINDOWS_MONITOR).toContain("$memoryBytes = 72");
});

it("ignores pipe errors after confirmed teardown without attempting another helper kill", async () => {
	const job = start(); await job.started;
	await job.stop();
	state.helpers[0]!.stdin.emit("error", new Error("Late closed pipe"));
	expect(state.helpers[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
	expect(loss).not.toHaveBeenCalled();
});

it("allows a cold sample inside the unchanged one-second budget", async () => {
	vi.useFakeTimers();
	const job = start(); await job.started; state.autoSample = false;
	const pending = job.sample();
	await vi.advanceTimersByTimeAsync(180);
	expect(loss).not.toHaveBeenCalled();
	frame({ event: "sample", id: sampleId(), rssBytes: state.rss, pids: [810_100, 810_101], cpuMs: 1 });
	expect(await pending).toEqual(memory);
	expect(SHELL_WINDOWS_MONITOR).toContain("Assert-Deadline 1000");
	expect(SHELL_WINDOWS_MONITOR).not.toMatch(/Assert-Deadline\s+80\b/);
});

it("accepts a complete helper/member working-set breakdown without changing the charged total", async () => {
	const job = start(); await job.started; state.autoSample = false;
	const pending = job.sample();
	frame({ event: "sample", id: sampleId(), rssBytes: state.rss, pids: [810_100, 810_101], cpuMs: 1,
		helperRssBytes: 16 * 1024 ** 2, memberRssBytes: [32 * 1024 ** 2, 16 * 1024 ** 2] });
	expect(await pending).toEqual(memory);
	expect(loss).not.toHaveBeenCalled();
});

it.each([
	{ helperRssBytes: 0 }, { helperRssBytes: 100 * 1024 ** 2 }, { memberRssBytes: [1] },
	{ memberRssBytes: [1, 2] }, { memberRssBytes: [-1, 2] }, { memberRssBytes: ["1", 2] },
	{ breakdownOmitted: true }, { breakdownOmitted: false },
])("refuses inconsistent working-set diagnostic totals %j", async extra => {
	const job = start(); await job.started; state.autoSample = false;
	const pending = job.sample(); const rejected = expect(pending).rejects.toThrow();
	frame({ event: "sample", id: sampleId(), rssBytes: state.rss, pids: [810_100, 810_101], cpuMs: 1,
		helperRssBytes: 16 * 1024 ** 2, memberRssBytes: [32 * 1024 ** 2, 16 * 1024 ** 2], ...extra });
	await rejected; expect(loss).toHaveBeenCalledExactlyOnceWith("unavailable");
});

it("permits explicit diagnostic omission for larger jobs while retaining their complete total and membership", async () => {
	const job = start(); await job.started; state.autoSample = false;
	const pending = job.sample();
	frame({ event: "sample", id: sampleId(), rssBytes: state.rss, pids: Array.from({ length: 257 }, (_, index) => 810_100 + index), cpuMs: 1,
		helperRssBytes: 16 * 1024 ** 2, breakdownOmitted: true });
	expect(await pending).toEqual(memory);
});

it("keeps sample errors fail-closed while exposing only fixed machine diagnostics", async () => {
	const job = start(); await job.started; state.autoSample = false;
	const pending = job.sample(); const rejected = expect(pending).rejects.toThrow();
	frame({ event: "error", id: sampleId(), phase: "sample", code: "deadline" });
	await rejected; expect(loss).toHaveBeenCalledExactlyOnceWith("unavailable");
	expect(SHELL_WINDOWS_MONITOR).toContain("'deadline'");
	expect(SHELL_WINDOWS_MONITOR).toContain("'sample'");
	expect(SHELL_WINDOWS_MONITOR).not.toContain("$_.Exception.Message");
});

it("fails closed when monitor accounting is missing even if a total is supplied", async () => {
	const job = start(); await job.started; state.autoSample = false;
	const pending = job.sample(); const rejected = expect(pending).rejects.toThrow();
	frame({ event: "sample", id: sampleId(), rssBytes: state.rss, pids: [810_100], cpuMs: 1, helperRssBytes: undefined, memberRssBytes: undefined });
	await rejected; expect(loss).toHaveBeenCalledExactlyOnceWith("unavailable");
});
