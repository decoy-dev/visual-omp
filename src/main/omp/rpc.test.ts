import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type RpcRequestOptions, rpcRequest } from "./rpc";

/** A stand-in for the spawned omp: tests write its stdout and see what was sent on stdin. */
class FakeOmp extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = new PassThrough();
	exitCode: number | null = null;
	signalCode: string | null = null;
	sent: unknown[] = [];
	kill = vi.fn();

	constructor() {
		super();
		this.stdin.on("data", chunk => {
			for (const line of String(chunk).split("\n")) if (line) this.sent.push(JSON.parse(line));
		});
	}

	print(message: unknown): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}
}

const omp = vi.hoisted(() => ({ current: null as FakeOmp | null }));

vi.mock("node:child_process", () => ({ spawn: () => omp.current }));
vi.mock("../env", () => ({ userEnv: async () => ({}) }));
vi.mock("./locate", () => ({ ompPath: async () => "/usr/local/bin/omp" }));
vi.mock("./refused", () => ({ ompStartError: async (error: unknown) => error }));

const messages = { timeout: "too slow", exited: "omp stopped", failed: "omp failed" };
const options = (patch: Partial<RpcRequestOptions> = {}): RpcRequestOptions => ({ flags: ["--no-session"], timeoutMs: 2000, messages, ...patch });
/** Waits until rpcRequest has spawned omp and written its request. */
const sentRequest = async (fake: FakeOmp) => {
	await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
	return fake.sent[0] as { id: string; type: string; message?: string };
};

let fake: FakeOmp;
beforeEach(() => {
	fake = new FakeOmp();
	omp.current = fake;
});

describe("rpcRequest", () => {
	it("passes events printed before the response to onMessage and resolves with the response data", async () => {
		const seen: unknown[] = [];
		const request = rpcRequest("/tmp", "prompt", options({ onMessage: message => seen.push(message) }), { message: "/usage reset" });
		const sent = await sentRequest(fake);
		expect(sent).toMatchObject({ type: "prompt", message: "/usage reset" });
		fake.print({ type: "command_output", text: "Saved rate-limit resets:" });
		fake.print({ type: "response", id: sent.id, success: true, data: { agentInvoked: false } });
		await expect(request).resolves.toEqual({ agentInvoked: false });
		expect(seen).toEqual([{ type: "command_output", text: "Saved rate-limit resets:" }]);
	});

	it("rejects with omp's error on a failed response", async () => {
		const request = rpcRequest("/tmp", "prompt", options());
		const sent = await sentRequest(fake);
		fake.print({ type: "response", id: sent.id, success: false, error: "Unknown command" });
		await expect(request).rejects.toThrow("Unknown command");
	});

	it("rejects on timeout and closes omp's input", async () => {
		const request = rpcRequest("/tmp", "prompt", options({ timeoutMs: 30 }));
		await expect(request).rejects.toThrow("too slow");
		expect(fake.stdin.writableEnded).toBe(true);
	});

	it("delivers the lines omp printed before it exited, then rejects", async () => {
		const seen: unknown[] = [];
		const request = rpcRequest("/tmp", "prompt", options({ onMessage: message => seen.push(message) }));
		await sentRequest(fake);
		fake.print({ type: "command_output", text: "Reset applied." });
		fake.exitCode = 1;
		fake.emit("exit", 1, null);
		fake.stdout.end();
		await expect(request).rejects.toThrow("omp stopped");
		expect(seen).toEqual([{ type: "command_output", text: "Reset applied." }]);
	});
});
