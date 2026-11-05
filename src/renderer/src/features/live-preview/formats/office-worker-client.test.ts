// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeWorkerClient } from "./office-worker-client";

function worker() {
	return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null,
		onerror: null as (() => void) | null, onmessageerror: null as (() => void) | null };
}
afterEach(() => vi.useRealTimers());

describe("revision-owned Office workers", () => {
	it("transfers input and resolves only its matching request", async () => {
		const fake = worker(), client = new OfficeWorkerClient(fake as unknown as Worker), bytes = new Uint8Array([1]);
		const request = client.request({ bytes }, [bytes.buffer]);
		expect(fake.postMessage).toHaveBeenCalledWith({ id: 1, bytes }, [bytes.buffer]);
		fake.onmessage?.({ data: { id: 8, ok: true } } as MessageEvent);
		fake.onmessage?.({ data: { id: 1, ok: true, cells: [["value"]] } } as MessageEvent);
		expect(await request).toEqual({ id: 1, ok: true, cells: [["value"]] });
		client.dispose(); expect(fake.terminate).toHaveBeenCalledOnce();
	});
	it("terminates at 15 seconds and rejects all pending work", async () => {
		vi.useFakeTimers();
		const fake = worker(), client = new OfficeWorkerClient(fake as unknown as Worker);
		const first = client.request({ bytes: [] }), second = client.request({ window: {} });
		const rejected = [expect(first).rejects.toThrow("timeout"), expect(second).rejects.toThrow("timeout")];
		await vi.advanceTimersByTimeAsync(15_000); await Promise.all(rejected);
		expect(fake.terminate).toHaveBeenCalledOnce();
	});
	it("drops stale replies and terminates on replacement or close", async () => {
		const fake = worker(), client = new OfficeWorkerClient(fake as unknown as Worker);
		const pending = client.request({ bytes: [] }), rejected = expect(pending).rejects.toThrow("revoked");
		client.dispose(); await rejected;
		fake.onmessage?.({ data: { id: 1, ok: true } } as MessageEvent);
		await expect(client.request({ bytes: [] })).rejects.toThrow("revoked");
		expect(fake.terminate).toHaveBeenCalledOnce();
	});
	it("rejects a failed inflate and stops a crashed worker", async () => {
		const fake = worker(), client = new OfficeWorkerClient(fake as unknown as Worker);
		const pending = client.request({ bytes: [] });
		fake.onmessage?.({ data: { id: 1, ok: false, reason: "unsafe" } } as MessageEvent);
		await expect(pending).rejects.toThrow("unsafe");
		fake.onerror?.(); expect(fake.terminate).toHaveBeenCalledOnce();
	});
});
