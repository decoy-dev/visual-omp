import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollabSocket } from "./socket";

const encryption = vi.hoisted(() => ({ seal: vi.fn(async () => new Uint8Array([1, 2, 3])) }));
vi.mock("./codec", () => ({ seal: encryption.seal, open: vi.fn() }));
class TestWebSocket {
	static readonly OPEN = 1;
	static instances: TestWebSocket[] = [];
	readyState = 0;
	binaryType = "";
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	sent: unknown[] = [];
	constructor(readonly url: string) { TestWebSocket.instances.push(this); }
	open(): void { this.readyState = 1; this.onopen?.(); }
	send(bytes: unknown): void { this.sent.push(bytes); }
	close(): void { this.readyState = 3; }
	drop(): void { this.readyState = 3; this.onclose?.({ code: 1006, reason: "lost" } as CloseEvent); }
}
let socket: CollabSocket;
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
beforeEach(() => {
	vi.useFakeTimers(); vi.stubGlobal("WebSocket", TestWebSocket); TestWebSocket.instances = [];
	encryption.seal.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
	socket = new CollabSocket({ wsUrl: "ws://localhost/r/smoke", role: "guest", key: {} as CryptoKey });
	socket.connect(); TestWebSocket.instances[0]!.open();
});
afterEach(() => { socket.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("rejects a prompt disconnected during encryption without replaying it after reconnect", async () => {
	const gate = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
	encryption.seal.mockReturnValueOnce(gate.promise);
	const sending = socket.sendConnected({ t: "prompt", text: "ask steer" }, () => {});
	const rejected = expect(sending).rejects.toThrow("disconnected");
	await flush(); TestWebSocket.instances[0]!.drop();
	await vi.advanceTimersByTimeAsync(2000); TestWebSocket.instances[1]!.open();
	gate.resolve(new Uint8Array([1])); await rejected; await flush();
	expect(TestWebSocket.instances.every(ws => ws.sent.length === 0)).toBe(true);
});
it("rejects a prompt disposed during encryption before sending bytes", async () => {
	const gate = Promise.withResolvers<Uint8Array<ArrayBuffer>>(); encryption.seal.mockReturnValueOnce(gate.promise);
	const sending = socket.sendConnected({ t: "prompt", text: "ask steer" }, () => {});
	const rejected = expect(sending).rejects.toThrow("disconnected");
	await flush(); socket.close(); gate.resolve(new Uint8Array([1])); await rejected;
	expect(TestWebSocket.instances[0]!.sent).toEqual([]);
});
it("runs the caller's authority check after encryption and propagates refusal", async () => {
	const gate = Promise.withResolvers<Uint8Array<ArrayBuffer>>(); encryption.seal.mockReturnValueOnce(gate.promise);
	let allowed = true;
	const sending = socket.sendConnected({ t: "prompt", text: "ask steer" }, () => { if (!allowed) throw new Error("Question replaced"); });
	const rejected = expect(sending).rejects.toThrow("Question replaced");
	await flush(); allowed = false; gate.resolve(new Uint8Array([1])); await rejected;
	expect(TestWebSocket.instances[0]!.sent).toEqual([]);
});
it("propagates encryption failure and leaves later ordinary frames deliverable", async () => {
	encryption.seal.mockRejectedValueOnce(new Error("Seal failed"));
	await expect(socket.sendConnected({ t: "prompt", text: "ask steer" }, () => {})).rejects.toThrow("Seal failed");
	expect(TestWebSocket.instances[0]!.sent).toEqual([]);
	socket.send({ t: "abort" }); await flush();
	expect(TestWebSocket.instances[0]!.sent).toHaveLength(1);
});
it("does not replay a prompt whose bytes were already sent before disconnect", async () => {
	await socket.sendConnected({ t: "prompt", text: "ask steer" }, () => {});
	expect(TestWebSocket.instances[0]!.sent).toHaveLength(1);
	TestWebSocket.instances[0]!.drop(); await vi.advanceTimersByTimeAsync(2000); TestWebSocket.instances[1]!.open();
	expect(TestWebSocket.instances[1]!.sent).toEqual([]);
});
