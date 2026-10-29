import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type RpcRequestOptions, rpcRequest, rpcRequests } from "./rpc";

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

	it("preserves omp's initialization error when no RPC response could be produced", async () => {
		const request = rpcRequest("/tmp", "set_session_name", options(), { name: "Saved chat" });
		await sentRequest(fake);
		fake.stderr.write("No default model selected. Use /login or select a local model.\n");
		fake.stdout.end();
		await expect(request).rejects.toThrow("No default model selected. Use /login or select a local model.");
	});
});

describe("rpcRequests", () => {
	it("waits for each result before asking the same process for its changed state", async () => {
		const request = rpcRequests("/tmp", [{ type: "fork", params: { entryId: "message-1" } }, { type: "get_state" }], options());
		const first = await sentRequest(fake);
		expect(first).toMatchObject({ type: "fork", entryId: "message-1" });
		fake.print({ type: "response", id: first.id, success: true, data: { cancelled: false } });
		await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
		const second = fake.sent[1] as { id: string; type: string };
		expect(second.type).toBe("get_state");
		expect(second.id).not.toBe(first.id);
		expect(fake.stdin.writableEnded).toBe(false);
		fake.print({ type: "response", id: first.id, success: true, data: { stale: true } });
		fake.print({ type: "response", id: second.id, success: true, data: { sessionFile: "/copy.jsonl", sessionId: "copy" } });
		await expect(request).resolves.toEqual([{ cancelled: false }, { sessionFile: "/copy.jsonl", sessionId: "copy" }]);
		expect(fake.stdin.writableEnded).toBe(true);
	});

	it("does not execute later commands after a failed request", async () => {
		const request = rpcRequests("/tmp", [{ type: "fork" }, { type: "get_state" }], options());
		const first = await sentRequest(fake);
		fake.print({ type: "response", id: first.id, success: false, error: "Invalid entry ID" });
		await expect(request).rejects.toThrow("Invalid entry ID");
		expect(fake.sent).toHaveLength(1);
		expect(fake.stdin.writableEnded).toBe(true);
	});

	it("retains a copied session until its creator has exited and released its lease", async () => {
		let returned = false;
		const request = rpcRequests("/tmp", [{ type: "get_state" }], options({ waitForExit: true }));
		void request.then(() => { returned = true; });
		const sent = await sentRequest(fake);
		fake.print({ type: "response", id: sent.id, success: true, data: { sessionFile: "/copy.jsonl", sessionId: "copy" } });
		await vi.waitFor(() => expect(fake.stdin.writableEnded).toBe(true));
		expect(returned).toBe(false);
		await Promise.resolve();
		expect(returned).toBe(false);
		fake.exitCode = 0;
		fake.emit("exit", 0, null);
		await expect(request).resolves.toEqual([{ sessionFile: "/copy.jsonl", sessionId: "copy" }]);
		expect(returned).toBe(true);
	});

	it("bounds shutdown and refuses the handoff if termination cannot be confirmed", async () => {
		const request = rpcRequests("/tmp", [{ type: "get_state" }], options({ waitForExit: true }));
		const sent = await sentRequest(fake);
		vi.useFakeTimers();
		try {
			fake.print({ type: "response", id: sent.id, success: true, data: { sessionFile: "/copy.jsonl", sessionId: "copy" } });
			const rejected = expect(request).rejects.toThrow("session lease may still be held");
			await vi.advanceTimersByTimeAsync(5000);
			await rejected;
			expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
		} finally { vi.useRealTimers(); }
	});
	it("does not send a mutation after the initial identity validator rejects", async () => {
		const request = rpcRequests("/tmp", [
			{ type: "get_state", validate: data => { if (!data || typeof data !== "object" || !("sessionId" in data) || data.sessionId !== "intended") throw new Error("Wrong session identity"); } },
			{ type: "set_session_name", params: { name: "Saved name" } },
		], options());
		const sent = await sentRequest(fake);
		fake.print({ type: "response", id: sent.id, success: true, data: { sessionId: "other" } });
		await expect(request).rejects.toThrow("Wrong session identity");
		expect(fake.sent).toHaveLength(1);
	});
});
