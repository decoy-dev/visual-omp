import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, () => Promise<string>>(),
	quit: () => {},
	spawn: vi.fn(),
	env: vi.fn(),
	open: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => fake.spawn(...args) }));
vi.mock("electron", () => ({
	app: { on: (_event: string, listener: () => void) => { fake.quit = listener; } },
	BrowserWindow: {}, dialog: {}, shell: { openExternal: (...args: unknown[]) => fake.open(...args) },
}));
vi.mock("../env", () => ({ userEnv: () => fake.env() }));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: () => Promise<string>) => fake.handlers.set(channel, handler) }));
vi.mock("../omp/locate", () => ({ ompPath: async () => "/fixture/omp" }));
vi.mock("../omp/paths", () => ({ sessionsDir: () => "/fixture/sessions" }));
vi.mock("../omp/refused", () => ({ ompStartError: async (error: Error) => error }));

class StatsChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: string | null = null;
	killed = false;
	kill = vi.fn(() => { this.killed = true; return true; });

	exit(code = 0) {
		this.exitCode = code;
		this.emit("exit", code);
	}
}

function nextSpawn() {
	const child = new StatsChild();
	const started = Promise.withResolvers<void>();
	fake.spawn.mockImplementationOnce(() => {
		started.resolve();
		return child as unknown as ChildProcess;
	});
	return { child, started: started.promise };
}

const open = () => fake.handlers.get("extensions:statsDashboard")!();

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	fake.spawn.mockReset();
	fake.env.mockReset().mockResolvedValue({ HOME: "/fixture", PATH: "/fixture/bin" });
	fake.handlers.clear();
	vi.stubGlobal("fetch", fake.fetch);
	// Reload the module so each test owns fresh child, startup and shutdown state.
	const { register } = await import("./extensions");
	register();
});
afterEach(() => {
	fake.quit();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("owned stats dashboard", () => {
	it("spawns plain omp stats and waits for the complete printed URL without probing a fixed address", async () => {
		const { child, started } = nextSpawn();
		const result = open();
		await started;
		expect(fake.spawn).toHaveBeenCalledWith("/fixture/omp", ["stats"], expect.objectContaining({ env: expect.objectContaining({ NO_COLOR: "1" }) }));
		let settled = false;
		void result.then(() => { settled = true; });
		child.stdout.write("Syncing sessions...\nDashboard available at: http://localhost:52");
		await Promise.resolve();
		expect(settled).toBe(false);
		child.stdout.write("819/\nPress Ctrl+C to stop\n");
		await expect(result).resolves.toBe("http://localhost:52819/");
		expect(fake.fetch).not.toHaveBeenCalled();
		expect(fake.open).not.toHaveBeenCalled();
	});

	it("joins concurrent starts, including environment lookup, and reopens only its own running child", async () => {
		const environment = Promise.withResolvers<NodeJS.ProcessEnv>();
		fake.env.mockReturnValueOnce(environment.promise);
		const { child, started } = nextSpawn();
		const first = open();
		const second = open();
		expect(fake.env).toHaveBeenCalledTimes(1);
		environment.resolve({ HOME: "/fixture" });
		await started;
		child.stderr.write("Dashboard available at: http://[::1]:49152\n");
		await expect(first).resolves.toBe("http://[::1]:49152");
		await expect(second).resolves.toBe("http://[::1]:49152");
		await expect(open()).resolves.toBe("http://[::1]:49152");
		expect(fake.spawn).toHaveBeenCalledTimes(1);
		expect(fake.open).toHaveBeenCalledExactlyOnceWith("http://[::1]:49152");
		expect(child.kill).not.toHaveBeenCalled();
	});

	it.each([
		"",
		"not-a-url",
		"http://[::1",
		"http://localhost:70000",
		"https://localhost:50001",
		"file:///tmp/dashboard.html",
		"javascript:alert(1)",
		"vscode://localhost/dashboard",
		"http://example.com:50001",
		"http://192.168.1.1:50001",
		"http://localhost.example.com:50001",
		"http://127.0.0.1.example.com:50001",
		"http://localhost:50001@example.com",
		"http://example.com@localhost:50001",
		"http://user:secret@localhost:50001",
		"http://:secret@127.0.0.1:50001",
		"http://user@[::1]:50001",
		"http://@localhost:50001",
		"http://localhost\\@example.com:50001",
		"http:localhost:50001",
		"http:///localhost:50001",
		"http://127.1:50001",
		"http://2130706433:50001",
		"http://%6cocalhost:50001",
		"http://localhost:50001/ path",
	])("rejects invalid dashboard URL %j, kills its child and permits a safe retry", async printedUrl => {
		const first = nextSpawn();
		const pending = open();
		const joined = open();
		const rejected = expect(pending).rejects.toThrow("invalid stats dashboard URL");
		const joinedRejected = expect(joined).rejects.toThrow("invalid stats dashboard URL");
		await first.started;
		first.child.stdout.write(`Dashboard available at: ${printedUrl}\n`);
		await Promise.all([rejected, joinedRejected]);
		expect(first.child.kill).toHaveBeenCalledTimes(1);
		expect(fake.open).not.toHaveBeenCalled();
		expect(first.child.stdout.listenerCount("data")).toBe(0);
		expect(first.child.stderr.listenerCount("data")).toBe(0);

		const second = nextSpawn();
		const retry = open();
		await second.started;
		// Late output and exit from the rejected child must not replace or clear the new URL.
		first.child.stdout.write("Dashboard available at: http://localhost:59999\n");
		second.child.stderr.write("Dashboard available at: http://127.0.0.1:54001/dashboard?view=usage#today\r\n");
		const safeUrl = "http://127.0.0.1:54001/dashboard?view=usage#today";
		await expect(retry).resolves.toBe(safeUrl);
		first.child.exit(1);
		expect(fake.open).not.toHaveBeenCalled();
		await expect(open()).resolves.toBe(safeUrl);
		expect(fake.open).toHaveBeenCalledExactlyOnceWith(safeUrl);
		expect(fake.spawn).toHaveBeenCalledTimes(2);
		expect(second.child.kill).not.toHaveBeenCalled();
		expect(fake.fetch).not.toHaveBeenCalled();
	});

	it("forgets the URL on exit and starts a new child", async () => {
		const first = nextSpawn();
		const pending = open();
		await first.started;
		first.child.stdout.write("Dashboard available at: http://localhost:50001\n");
		await pending;
		first.child.exit();
		const second = nextSpawn();
		const restarted = open();
		await second.started;
		second.child.stdout.write("Dashboard available at: http://localhost:50002\n");
		await expect(restarted).resolves.toBe("http://localhost:50002");
		expect(fake.spawn).toHaveBeenCalledTimes(2);
		expect(fake.open).not.toHaveBeenCalled();
		fake.quit();
		expect(second.child.kill).toHaveBeenCalledTimes(1);
	});

	it("reports early exit output and permits a fresh start", async () => {
		const first = nextSpawn();
		const result = open();
		const rejected = expect(result).rejects.toThrow("Failed to bind dashboard");
		await first.started;
		first.child.stderr.write("Failed to bind dashboard\n");
		first.child.exit(1);
		await rejected;
		const second = nextSpawn();
		const retry = open();
		await second.started;
		second.child.stdout.write("Dashboard available at: http://localhost:51000\n");
		await expect(retry).resolves.toBe("http://localhost:51000");
	});

	it("kills a timed-out start and ignores that child's later exit after its replacement starts", async () => {
		vi.useFakeTimers();
		const first = nextSpawn();
		const pending = open();
		const rejected = expect(pending).rejects.toThrow("took too long");
		await first.started;
		await vi.advanceTimersByTimeAsync(60_000);
		await rejected;
		expect(first.child.kill).toHaveBeenCalledTimes(1);
		const second = nextSpawn();
		const retry = open();
		await second.started;
		second.child.stdout.write("Dashboard available at: http://localhost:52000\n");
		await retry;
		first.child.exit(1);
		await expect(open()).resolves.toBe("http://localhost:52000");
		expect(fake.open).toHaveBeenCalledWith("http://localhost:52000");
		expect(fake.spawn).toHaveBeenCalledTimes(2);
	});

	it("clears failed spawn ownership and allows retry", async () => {
		const first = nextSpawn();
		const pending = open();
		const rejected = expect(pending).rejects.toThrow("spawn failed");
		await first.started;
		first.child.emit("error", new Error("spawn failed"));
		await rejected;
		expect(first.child.kill).toHaveBeenCalledTimes(1);
		const second = nextSpawn();
		const retry = open();
		await second.started;
		second.child.stdout.write("Dashboard available at: http://localhost:53000\n");
		await expect(retry).resolves.toBe("http://localhost:53000");
	});

	it("does not spawn after quit during environment lookup", async () => {
		const environment = Promise.withResolvers<NodeJS.ProcessEnv>();
		fake.env.mockReturnValueOnce(environment.promise);
		const pending = open();
		const rejected = expect(pending).rejects.toThrow("closing");
		fake.quit();
		environment.resolve({});
		await rejected;
		expect(fake.spawn).not.toHaveBeenCalled();
	});
});
