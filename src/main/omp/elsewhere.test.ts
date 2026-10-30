import type * as ChildProcessModule from "node:child_process";
import type * as FsPromisesModule from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ExecutableModule from "../services/executable";
import { sessionOwnership } from "./elsewhere";
import { leaseMemoryName } from "./lease-name";

const mocks = vi.hoisted(() => ({
	env: {} as NodeJS.ProcessEnv,
	hosts: [] as { pid: number; sessionId: string; phase: string }[],
	run: vi.fn(),
	sockets: null as string | null,
	leases: "",
	leaseMode: 0o700,
	actualExecutableSearch: false,
}));
vi.mock("node:child_process", async importOriginal => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	return { ...actual, execFile: (...args: unknown[]) => mocks.run(...args) };
});
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof FsPromisesModule>();
	return { ...actual,
		// The Darwin branch checks Unix permissions, which Windows directories do not expose.
		lstat: async (...args: Parameters<typeof FsPromisesModule.lstat>) => {
			const entry = await actual.lstat(...args);
			return args[0] === mocks.leases ? Object.assign(entry, { mode: (Number(entry.mode) & ~0o777) | mocks.leaseMode }) : entry;
		},
		readFile: (...args: Parameters<typeof FsPromisesModule.readFile>) =>
			args[0] === "/proc/net/unix" && mocks.sockets !== null ? Promise.resolve(mocks.sockets) : actual.readFile(...args) };
});
vi.mock("../env", () => ({ userEnv: async () => mocks.env }));
vi.mock("../services/executable", async importOriginal => {
	const actual = await importOriginal<typeof ExecutableModule>();
	return { ...actual, resolveExecutable: (command: string, env: NodeJS.ProcessEnv) =>
		mocks.actualExecutableSearch ? actual.resolveExecutable(command, env) : Promise.resolve(`/system-tools/${command}`) };
});
vi.mock("./host", () => ({ listHosts: () => mocks.hosts }));

let root: string;
let file: string;
let leases: string;
const platform = process.platform;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vomp-ownership-"));
	file = join(root, "source.jsonl");
	leases = join(root, "leases");
	mocks.leases = leases;
	mocks.leaseMode = 0o700;
	await mkdir(leases, { mode: 0o700 });
	await writeFile(file, `${JSON.stringify({ type: "title", title: "Chat" })}\n${JSON.stringify({ type: "session", id: "source-id" })}\n`);
	mocks.env = { PI_CODING_AGENT_DIR: root, PI_TEST_SESSION_OWNERS_DIR: leases };
	mocks.hosts = [];
	mocks.sockets = null;
	mocks.actualExecutableSearch = false;
	mocks.run.mockReset();
	mocks.run.mockImplementation((_command, _args, _options, callback) => callback(null, "", ""));
	Object.defineProperty(process, "platform", { value: "darwin" });
});
afterEach(async () => {
	Object.defineProperty(process, "platform", { value: platform });
	await rm(root, { recursive: true, force: true });
});

it("treats a persistent sidecar with no holder as free without running legacy process checks", async () => {
	await writeFile(join(leases, "source-id.lock"), "");
	expect((await sessionOwnership([file])).get(file)).toBe("free");
	expect(mocks.run.mock.calls.map(call => call[0])).toEqual(["/system-tools/lsof"]);
	expect(mocks.run.mock.calls[0]?.[1]).toContain(join(leases, "source-id.lock"));
});

it("finds an external lease holder even when the session itself has no writable descriptor", async () => {
	await writeFile(join(leases, "source-id.lock"), "");
	mocks.run.mockImplementation((_command, _args, _options, callback) => callback(null, "p93412\n", ""));
	expect((await sessionOwnership([file])).get(file)).toBe("elsewhere");
	expect(mocks.run).toHaveBeenCalledTimes(1);
});

it("reports the external lease holder even when an app host resumed the same session id", async () => {
	mocks.hosts = [{ pid: 1234, sessionId: "source-id", phase: "live" }];
	await writeFile(join(leases, "source-id.lock"), "");
	mocks.run.mockImplementation((_command, _args, _options, callback) => callback(null, "p93412\n", ""));
	expect((await sessionOwnership([file])).get(file)).toBe("elsewhere");
	expect(mocks.run).toHaveBeenCalledTimes(1);
});

it("excludes this app only when its PID is the observed lease holder", async () => {
	mocks.hosts = [{ pid: 1234, sessionId: "source-id", phase: "live" }];
	await writeFile(join(leases, "source-id.lock"), "");
	mocks.run.mockImplementation((_command, _args, _options, callback) => callback(null, "p1234\n", ""));
	expect((await sessionOwnership([file])).get(file)).toBe("free");
});

it("falls back to writable descriptors when reading the lease fails", async () => {
	await writeFile(join(leases, "source-id.lock"), "");
	mocks.run.mockImplementation((command, args, _options, callback) => {
		if (command === "/system-tools/ps") callback(null, "", "");
		else if (args.includes("pan")) callback(null, `p93412\nau\nn${file}\n`, "");
		else callback(Object.assign(new Error("unavailable"), { code: 2 }), "", "cannot inspect lease");
	});
	expect((await sessionOwnership([file])).get(file)).toBe("elsewhere");
	expect(mocks.run.mock.calls.some(call => call[0] === "/system-tools/ps")).toBe(true);
});

it("keeps failed legacy observations unknown", async () => {
	await writeFile(file, "damaged header\n");
	mocks.run.mockImplementation((_command, _args, _options, callback) => callback(Object.assign(new Error("unavailable"), { code: 2 }), "", ""));
	expect((await sessionOwnership([file])).get(file)).toBe("unknown");
});

it("falls back when the Darwin lease directory is accessible to other users", async () => {
	mocks.leaseMode = 0o777;
	await writeFile(join(leases, "source-id.lock"), "");
	mocks.run.mockImplementation((command, _args, _options, callback) => {
		if (command === "/system-tools/ps") callback(null, "", "");
		else callback(null, `p93412\nau\nn${file}\n`, "");
	});
	expect((await sessionOwnership([file])).get(file)).toBe("elsewhere");
	expect(mocks.run.mock.calls.map(call => call[0])).toEqual(["/system-tools/ps", "/system-tools/lsof"]);
	expect(mocks.run.mock.calls[1]?.[1]).toContain("pan");
});

it("reads Linux abstract socket names without treating a persistent sidecar as held", async () => {
	Object.defineProperty(process, "platform", { value: "linux" });
	mocks.sockets = `Num RefCount Protocol Flags Type St Inode Path\n000: 2 0 0 0002 01 42 @${leaseMemoryName(join(leases, "source-id.lock"))}\n`;
	expect((await sessionOwnership([file])).get(file)).toBe("elsewhere");
	expect(mocks.run).not.toHaveBeenCalled();
});

it("observes the Windows global mutex without creating or waiting on it", async () => {
	Object.defineProperty(process, "platform", { value: "win32" });
	mocks.run.mockImplementation((_command, _args, _options, callback) => callback(null, "held\r\n", ""));
	expect((await sessionOwnership([file])).get(file)).toBe("elsewhere");
	const script = mocks.run.mock.calls[0]?.[1].at(-1);
	expect(script).toContain(`Global\\${leaseMemoryName(join(leases, "source-id.lock"))}`);
	expect(script).toContain("OpenExisting");
	expect(script).not.toContain("WaitOne");
});

it.each([
	{ code: 2, stdout: "", stderr: "PowerShell unavailable" },
	{ code: 1, stdout: "", stderr: "Access denied" },
	{ code: 0, stdout: "unexpected response", stderr: "" },
])("keeps unreadable Windows leases unknown: $stderr$stdout", async ({ code, stdout, stderr }) => {
	Object.defineProperty(process, "platform", { value: "win32" });
	mocks.run.mockImplementation((_command, _args, _options, callback) =>
		callback(code ? Object.assign(new Error(stderr), { code }) : null, stdout, stderr));
	expect((await sessionOwnership([file])).get(file)).toBe("unknown");
});

// Explicit opt-in fixture: the binary and source are created outside the owner's omp directory.
describe.skipIf(!process.env.VOMP_OWNERSHIP_FIXTURE_FILE)("omp 18.14 fixture lease", () => {
	it("observes the live isolated process lease through the production ownership checker", async () => {
		mocks.env = { ...process.env, PI_TEST_SESSION_OWNERS_DIR: process.env.VOMP_OWNERSHIP_FIXTURE_LEASES };
		mocks.actualExecutableSearch = true;
		const actual = await vi.importActual<typeof ChildProcessModule>("node:child_process");
		mocks.run.mockImplementation((...args: Parameters<typeof ChildProcessModule.execFile>) => actual.execFile(...args));
		expect((await sessionOwnership([process.env.VOMP_OWNERSHIP_FIXTURE_FILE!])).get(process.env.VOMP_OWNERSHIP_FIXTURE_FILE!)).toBe(process.env.VOMP_OWNERSHIP_FIXTURE_EXPECTED ?? "elsewhere");
	});
});
