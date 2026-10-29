import { describe, expect, it, vi } from "vitest";
import type { EditorDraftRequest, EditorDraftResult } from "@shared/contracts/composer";
import { exactEditorDraft } from "./native-editor";
import { PredictionTransfers, type PredictionHost } from "./prediction-transfer";

const full = `Please check tests at https://example.test/${"long_token_".repeat(16)}?a=one|two&unicode=日本語🧭 and preserve literal | pipes.`;
const request = { hostId: "host", generation: 1, tabId: "tab", nativeDraft: "Please", expectedGhost: "Please check tests…" };
function harness() {
	let buffer = "", reads = 0, failRead = 0, failClearReply = false;
	let failTab = false, blocked: string | null = null;
	let tail = Promise.resolve();
	let afterRead: ((request: EditorDraftRequest, result: EditorDraftResult) => void) | null = null;
	let waitRead: (() => Promise<void>) | null = null;
	const keys = vi.fn(async (value: string) => { if (value === "tab") { buffer = full; if (failTab) throw new Error("Tab acknowledgement lost"); } });
	const ui = { getEditorText: () => { if (++reads === failRead) throw new Error("read failed"); return buffer; }, setEditorText: vi.fn((value: string) => { buffer = value; }) };
	const host: PredictionHost = {
		state: { generation: 1, sessionId: "session", cwd: "/project", phase: "live" },
		withEditorInput<T>(operation: (input: { keys(value: string): Promise<void>; assertOpen(): void }) => Promise<T>): Promise<T> {
			const work = tail.then(() => operation({ keys, assertOpen: () => {} }));
			tail = work.then(() => undefined, () => undefined);
			return work;
		},
		tuiFocus: vi.fn(async () => ({ overlays: 0 })),
		debugValues: async () => ({ "Editor[1]": { textPreview: buffer.slice(0, 120), textLength: buffer.length, placeholderActive: false, cursorLine: 0, lineCount: 1 } }),
		screenPaint: async () => ({ lines: ["╰─ Please check tests…"], cursor: { x: 3, y: 0, visible: true } }),
		setEditorTransferBlocked: vi.fn((reason: string | null) => { blocked = reason; }),
	};
	const bridge = { editorDraft: vi.fn(async (value: EditorDraftRequest) => {
		if (value.operation === "peek" && buffer && waitRead) await waitRead();
		const result = exactEditorDraft(ui, value, host.state.sessionId!);
		afterRead?.(value, result);
		if (value.operation === "take" && failClearReply) { failClearReply = false; throw new Error("clear reply lost"); }
		return result;
	}) };
	const changed = vi.fn();
	const transfers = new PredictionTransfers(() => host, () => bridge, changed);
	return { host, bridge, transfers, ui, keys, changed,
		get buffer() { return buffer; }, set buffer(value: string) { buffer = value; },
		failReadAt(value: number) { failRead = value; }, loseClearReply() { failClearReply = true; },
		loseTabReply() { failTab = true; },
		submit(value: string) { return host.withEditorInput(async () => { if (blocked) throw new Error(blocked); buffer += value; }); },
		afterRead(value: typeof afterRead) { afterRead = value; }, waitRead(value: () => Promise<void>) { waitRead = value; },
	};
}

describe("next-message capture coordinator", () => {
	it("retains the exact long capture before clearing and until explicit acknowledgement", async () => {
		const test = harness();
		const capture = await test.transfers.take(request);
		expect(capture).toMatchObject({ text: full, generation: 1, blocked: false, error: null });
		expect(test.buffer).toBe("");
		expect(test.keys.mock.calls).toEqual([["tab"]]);
		expect(test.transfers.list()[0]?.text).toBe(full);
		test.transfers.acknowledge(capture!.id);
		expect(test.transfers.list()).toEqual([]);
	});
	it("leaves an unreadable accepted draft in the TUI, blocks application writes and recovers it on retry", async () => {
		const test = harness(); test.failReadAt(2);
		const capture = await test.transfers.take(request);
		expect(capture).toMatchObject({ text: null, blocked: true });
		expect(test.buffer).toBe(full);
		expect(test.ui.setEditorText).not.toHaveBeenCalled();
		expect(test.host.setEditorTransferBlocked).toHaveBeenCalledWith(expect.any(String));
		expect(() => test.transfers.acknowledge(capture!.id)).toThrow("recover");
		const recovered = await test.transfers.retry(capture!.id);
		expect(recovered).toMatchObject({ text: full, blocked: false });
		expect(test.buffer).toBe("");
		expect(test.host.setEditorTransferBlocked).toHaveBeenLastCalledWith(null);
	});
	it("recovers an ambiguously accepted Tab without resending it or appending the next message", async () => {
		const test = harness(); test.loseTabReply();
		const capture = await test.transfers.take(request);
		expect(capture).toMatchObject({ text: null, blocked: true, error: "Tab acknowledgement lost" });
		expect(test.buffer).toBe(full);
		await expect(test.submit("New composed input")).rejects.toThrow("Recover the accepted suggestion");
		expect(test.buffer).toBe(full);
		await expect(test.transfers.retry(capture!.id)).resolves.toMatchObject({ text: full, blocked: false });
		expect(test.keys.mock.calls).toEqual([["tab"]]);
		await test.submit("New composed input");
		expect(test.buffer).toBe("New composed input");
		test.transfers.acknowledge(capture!.id);
		expect(test.transfers.list()).toEqual([]);
	});
	it("keeps the exact main-process copy when a successful clear loses its reply", async () => {
		const test = harness(); test.loseClearReply();
		const capture = await test.transfers.take(request);
		expect(capture).toMatchObject({ text: full, blocked: true, error: "clear reply lost" });
		expect(test.buffer).toBe("");
		expect(test.transfers.list()[0]?.text).toBe(full);
		await expect(test.transfers.retry(capture!.id)).resolves.toMatchObject({ text: full, blocked: false });
	});
	it("preserves the capture and never overwrites a newer room's editor", async () => {
		const test = harness();
		test.afterRead((value, result) => {
			if (value.operation === "peek" && result.text === full && test.host.state.generation === 1) {
				test.host.state.generation = 2; test.host.state.sessionId = "new-room"; test.buffer = "Newer room draft";
			}
		});
		const capture = await test.transfers.take(request);
		expect(capture).toMatchObject({ text: full, generation: 1, blocked: true });
		expect(test.buffer).toBe("Newer room draft");
		expect(test.ui.setEditorText).not.toHaveBeenCalled();
		test.buffer = "";
		await expect(test.transfers.retry(capture!.id)).resolves.toMatchObject({ text: full, generation: 1, blocked: false });
		expect(test.transfers.list()[0]?.text).toBe(full);
	});
	it("serializes the whole transfer before another application editor write", async () => {
		const test = harness();
		const reading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
		test.waitRead(async () => { reading.resolve(); await release.promise; });
		const capturing = test.transfers.take(request);
		await reading.promise;
		let written = false;
		const writing = test.host.withEditorInput(async () => { test.buffer += "Native message"; written = true; });
		expect(written).toBe(false);
		release.resolve();
		const capture = await capturing;
		await writing;
		expect(capture?.text).toBe(full);
		expect(test.buffer).toBe("Native message");
	});
	it("refuses stale generations, overlays and nonempty hidden drafts before Tab", async () => {
		const test = harness();
		await expect(test.transfers.take({ ...request, generation: 0 })).resolves.toBeNull();
		vi.mocked(test.host.tuiFocus).mockResolvedValue({ overlays: 1 });
		await expect(test.transfers.take(request)).resolves.toBeNull();
		vi.mocked(test.host.tuiFocus).mockResolvedValue({ overlays: 0 }); test.buffer = "Unsent TUI text";
		await expect(test.transfers.take(request)).resolves.toBeNull();
		expect(test.keys).not.toHaveBeenCalled();
		expect(test.buffer).toBe("Unsent TUI text");
	});
});
