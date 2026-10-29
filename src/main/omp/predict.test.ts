import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePredictions, predictFeedback, predictWord, releasePredictionFolder, retainPredictionFolder } from "./predict";
import { PersistentRpc } from "./rpc";
import { OMP_DISCOVERY_ISOLATION } from "./discovery-isolation";

class FakeOmp extends EventEmitter {
	stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough();
	exitCode: number | null = null; signalCode: string | null = null;
	kill = vi.fn();
	sent: { id: string; type: string; [key: string]: unknown }[] = [];
	constructor() {
		super();
		this.stdin.on("data", chunk => { for (const line of String(chunk).split("\n")) if (line) this.sent.push(JSON.parse(line)); });
	}
	respond(index: number, data?: unknown, error?: string) {
		this.stdout.write(`${JSON.stringify({ type: "response", id: this.sent[index]!.id, success: !error, data, error })}\n`);
	}
}
const fake = vi.hoisted(() => ({ children: [] as FakeOmp[], spawn: vi.fn(), env: {} as NodeJS.ProcessEnv }));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => fake.spawn(...args) }));
vi.mock("../env", () => ({ userEnv: async () => fake.env }));
vi.mock("./locate", () => ({ ompPath: async () => "/tmp/omp" }));
beforeEach(() => {
	fake.children.length = 0;
	fake.spawn.mockReset().mockImplementation(() => { const child = new FakeOmp(); fake.children.push(child); return child; });
	fake.env = { PATH: "/bin", HOME: "/home/user", ANTHROPIC_API_KEY: "kept-secret", NODE_OPTIONS: "--require hostile.cjs", BUN_OPTIONS: "--preload hostile.mjs", PI_CONFIG_FILES: "/hostile/config.yml", VOMP_NATIVE_BRIDGE: "http://host-control", OMP_TUI_DEBUG: "/host-control.sock", DYLD_INSERT_LIBRARIES: "/hostile.dylib", BASH_ENV: "/hostile.sh" };
	retainPredictionFolder("/one", "one");
	retainPredictionFolder("/two", "two");
});
afterEach(() => {
	closePredictions(true);
	for (const child of fake.children) { child.exitCode = 0; child.emit("exit", 0); child.stdout.end(); }
});
describe("folder word prediction", () => {
	it("reuses one no-session child in a folder and correlates out-of-order responses", async () => {
		const first = predictWord("/one", "test", 4);
		const second = predictWord("/one", "tests", 5);
		await vi.waitFor(() => expect(fake.children[0]?.sent).toHaveLength(2));
		expect(fake.spawn).toHaveBeenCalledOnce();
		expect(fake.spawn.mock.calls[0]![1]).toContain("--no-session");
		fake.children[0]!.respond(1, { suffix: "uite" });
		fake.children[0]!.respond(0, { suffix: "ing" });
		await expect(first).resolves.toBe("ing");
		await expect(second).resolves.toBe("uite");
		const feedback = predictFeedback("/one", "test", 4, "ing", true);
		await vi.waitFor(() => expect(fake.children[0]?.sent).toHaveLength(3));
		expect(fake.children[0]!.sent[2]).toMatchObject({ type: "predict_word_feedback", suggestion: "ing", accepted: true });
		fake.children[0]!.respond(2);
		await feedback;
	});
	it("separates project folders and rereads settings after invalidation", async () => {
		const a = predictWord("/one", "test", 4);
		const b = predictWord("/two", "test", 4);
		await vi.waitFor(() => expect(fake.children).toHaveLength(2));
		for (const child of fake.children) child.respond(0, { suffix: null });
		await Promise.all([a, b]);
		closePredictions();
		expect(fake.children.every(child => child.stdin.writableEnded)).toBe(true);
		const c = predictWord("/one", "test", 4);
		await vi.waitFor(() => expect(fake.children).toHaveLength(3));
		fake.children[2]!.respond(0, { suffix: null });
		await expect(c).resolves.toBeNull();
	});
	it("does not leave a failed request pending when omp exits", async () => {
		const request = predictWord("/one", "test", 4);
		const rejection = expect(request).rejects.toThrow("stopped");
		await vi.waitFor(() => expect(fake.children[0]?.sent).toHaveLength(1));
		fake.children[0]!.stdout.end();
		await rejection;
	});
	it("terminates a pending prediction immediately on app quit", async () => {
		const request = predictWord("/one", "test", 4);
		const rejection = expect(request).rejects.toThrow("closed");
		await vi.waitFor(() => expect(fake.children[0]?.sent).toHaveLength(1));
		closePredictions(true);
		expect(fake.children[0]!.kill).toHaveBeenCalledOnce();
		await rejection;
	});
	it("shares a split composer's child until the last owner releases its folder", async () => {
		retainPredictionFolder("/one", "split");
		const request = predictWord("/one", "test", 4);
		await vi.waitFor(() => expect(fake.children[0]?.sent).toHaveLength(1));
		fake.children[0]!.respond(0, { suffix: "ing" });
		await request;
		releasePredictionFolder("/one", "one");
		expect(fake.children[0]!.stdin.writableEnded).toBe(false);
		releasePredictionFolder("/one", "split");
		expect(fake.children[0]!.stdin.writableEnded).toBe(true);
		await expect(predictWord("/one", "test", 4)).resolves.toBeNull();
		expect(fake.children).toHaveLength(1);
	});
	it("closes the previous project when its composer switches folders", async () => {
		const request = predictWord("/one", "test", 4);
		await vi.waitFor(() => expect(fake.children[0]?.sent).toHaveLength(1));
		fake.children[0]!.respond(0, { suffix: null }); await request;
		releasePredictionFolder("/one", "one");
		const next = predictWord("/two", "test", 4);
		await vi.waitFor(() => expect(fake.children[1]?.sent).toHaveLength(1));
		fake.children[1]!.respond(0, { suffix: null }); await next;
		expect(fake.children[0]!.stdin.writableEnded).toBe(true);
		expect(fake.children[1]!.stdin.writableEnded).toBe(false);
	});
	it("forces the MCP isolation overlay last and removes inherited execution controls", async () => {
		const request = predictWord("/one", "test", 4);
		await vi.waitFor(() => expect(fake.children[0]?.sent).toHaveLength(1));
		const args = fake.spawn.mock.calls[0]![1] as string[];
		const options = fake.spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
		const overlay = args.at(-1)!;
		expect(args.at(-2)).toBe("--config");
		expect(JSON.parse(readFileSync(overlay, "utf8"))).toEqual(OMP_DISCOVERY_ISOLATION);
		expect(options.env).toMatchObject({ PATH: "/bin", HOME: "/home/user", ANTHROPIC_API_KEY: "kept-secret" });
		for (const key of ["NODE_OPTIONS", "BUN_OPTIONS", "PI_CONFIG_FILES", "VOMP_NATIVE_BRIDGE", "OMP_TUI_DEBUG", "DYLD_INSERT_LIBRARIES", "BASH_ENV"]) expect(options.env[key]).toBeUndefined();
		fake.children[0]!.respond(0, { suffix: null }); await request;
		releasePredictionFolder("/one", "one");
		expect(existsSync(overlay)).toBe(false);
	});
	it("notifies the capture owner once when a child dies after its start response", async () => {
		const terminated = vi.fn();
		const client = new PersistentRpc("/voice", [], undefined, terminated);
		const started = client.request("dictation_start", { captureId: "capture" });
		await vi.waitFor(() => expect(fake.children[0]?.sent).toHaveLength(1));
		fake.children[0]!.respond(0);
		await started;
		fake.children[0]!.stdout.end();
		await vi.waitFor(() => expect(terminated).toHaveBeenCalledOnce());
		fake.children[0]!.emit("error", new Error("duplicate exit"));
		expect(terminated).toHaveBeenCalledOnce();
		client.close();
	});
});
