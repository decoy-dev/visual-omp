import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EditorDraftRequest, EditorDraftResult, PredictionCapture, PredictionTakeRequest } from "@shared/contracts/composer";

interface EditorInput {
	keys(keys: string): Promise<void>;
	assertOpen(): void;
}
export interface PredictionHost {
	state: { generation: number; sessionId: string | null; cwd: string; phase: string };
	withEditorInput<T>(operation: (input: EditorInput) => Promise<T>): Promise<T>;
	tuiFocus(): Promise<{ overlays: number } | null>;
	debugValues(): Promise<Record<string, unknown>>;
	screenPaint(): Promise<{ lines: readonly string[]; cursor?: { x: number; y: number; visible?: boolean } }>;
	setEditorTransferBlocked(reason: string | null): void;
}
interface EditorBridge { editorDraft(request: EditorDraftRequest): Promise<EditorDraftResult>; }
interface CaptureRecord { view: PredictionCapture; sessionId: string; nativeDraft: string; exposed: boolean; }
const editorShape = z.object({ textPreview: z.string(), textLength: z.number(), placeholderActive: z.boolean(), cursorLine: z.number(), lineCount: z.number() });

/** Painted text identifies an offer only. Exact draft data always comes from the trusted editor API. */
export async function paintedPrediction(host: PredictionHost): Promise<string | null> {
	if (host.state.phase !== "live") return null;
	const focus = await host.tuiFocus();
	if (!focus || focus.overlays !== 0) return null;
	let editor: { depth: number; empty: boolean; placeholder: boolean } | null = null;
	for (const [key, value] of Object.entries(await host.debugValues())) {
		const parsed = editorShape.safeParse(value);
		if (!parsed.success) continue;
		const depth = (/\[([\d.]*)\]$/.exec(key)?.[1] ?? "").split(".").length;
		if (!editor || depth < editor.depth) editor = { depth, empty: parsed.data.textLength === 0, placeholder: parsed.data.placeholderActive };
	}
	if (!editor?.empty || editor.placeholder) return null;
	const paint = await host.screenPaint();
	if (!paint.cursor?.visible) return null;
	const row = paint.lines[paint.cursor.y];
	if (!row) return null;
	// omp paints a prediction starting at the cursor cell (pi-tui editor: before + cursor marker + hint).
	// Text after a gap is the editor's own chrome, such as the box edge `─╯` or a right-aligned hint.
	const after = row.slice(paint.cursor.x);
	if (!after || /^\s/.test(after)) return null;
	const hint = after.replace(/\s*[\u2500-\u257F]+\s*$/, "").trimEnd();
	return hint || null;
}

/** Exact captures remain recoverable until an explicit renderer acknowledgement. */
export class PredictionTransfers {
	readonly #captures = new Map<string, CaptureRecord>();
	readonly #blocked = new Map<string, string>();
	constructor(
		readonly hostFor: (hostId: string) => PredictionHost,
		readonly bridgeFor: (hostId: string) => EditorBridge,
		readonly changed: (captures: PredictionCapture[]) => void,
	) {}

	list(): PredictionCapture[] { return [...this.#captures.values()].filter(record => record.exposed).map(record => ({ ...record.view })); }
	async offer(hostId: string): Promise<string | null> {
		if (this.#blocked.has(hostId)) return null;
		return paintedPrediction(this.hostFor(hostId));
	}

	async take(request: PredictionTakeRequest): Promise<PredictionCapture | null> {
		const host = this.hostFor(request.hostId);
		if (this.#blocked.has(request.hostId)) throw new Error("Resolve the saved suggestion before sending more text to omp.");
		let record: CaptureRecord | null = null;
		try {
			return await host.withEditorInput(async input => {
				if (host.state.generation !== request.generation || !host.state.sessionId) return null;
				const sessionId = host.state.sessionId;
				const before = await this.bridgeFor(request.hostId).editorDraft({ operation: "peek", sessionId });
				if (before.error) throw new Error(before.error);
				if (before.text !== "" || host.state.generation !== request.generation) return null;
				if (await paintedPrediction(host) !== request.expectedGhost) return null;
				// Check fresh overlays at the point of risk, under the same lock as paste and submit.
				const focus = await host.tuiFocus();
				if (!focus || focus.overlays !== 0 || host.state.generation !== request.generation) return null;
				input.assertOpen();
				record = {
					view: { id: randomUUID(), hostId: request.hostId, generation: request.generation, tabId: request.tabId, folder: host.state.cwd, text: null, blocked: true, error: null },
					sessionId, nativeDraft: request.nativeDraft, exposed: false,
				};
				this.#captures.set(record.view.id, record);
				await input.keys("tab");
				await this.#complete(record, host, input);
				if (record.view.text === "" && !record.view.blocked) { this.#captures.delete(record.view.id); return null; }
				return this.#expose(record);
			});
		} catch (error) {
			if (!record) throw error;
			this.#fail(record, host, error);
			return this.#expose(record);
		}
	}

	async retry(id: string): Promise<PredictionCapture | null> {
		const record = this.#captures.get(id);
		if (!record) return null;
		if (!record.view.blocked) return { ...record.view };
		let host: PredictionHost;
		try { host = this.hostFor(record.view.hostId); }
		catch {
			record.view.blocked = false;
			record.view.error = record.view.text === null ? "omp stopped before its accepted suggestion could be read." : "omp stopped. The exact captured text is saved below.";
			this.#blocked.delete(record.view.hostId);
			return this.#expose(record);
		}
		try {
			await host.withEditorInput(async input => {
				if (record.view.blocked) await this.#complete(record, host, input);
			});
		} catch (error) { this.#fail(record, host, error); }
		return this.#expose(record);
	}

	acknowledge(id: string): void {
		const record = this.#captures.get(id);
		if (!record) return;
		if (record.view.blocked) throw new Error("Clear or recover omp's editor before dismissing this suggestion.");
		this.#captures.delete(id);
		this.changed(this.list());
	}

	async #complete(record: CaptureRecord, host: PredictionHost, input: EditorInput): Promise<void> {
		if (host.state.generation !== record.view.generation || host.state.sessionId !== record.sessionId) {
			await this.#roomChanged(record, host, input);
			return;
		}
		input.assertOpen();
		const bridge = this.bridgeFor(record.view.hostId);
		const read = await bridge.editorDraft({ operation: "peek", sessionId: record.sessionId });
		if (read.error || read.text === null) throw new Error(read.error ?? "omp did not return its exact editor text.");
		if (record.view.text === null) record.view.text = read.text;
		// Retain the exact text in main BEFORE any clear request is sent, including a request whose reply may be lost.
		if (host.state.generation !== record.view.generation || host.state.sessionId !== record.sessionId) {
			await this.#roomChanged(record, host, input);
			return;
		}
		if (read.text === "") { this.#ready(record, host); return; }
		if (read.text !== record.view.text) throw new Error("omp's editor has newer text. Clear it in the terminal before retrying; the original suggestion is saved below.");
		input.assertOpen();
		const taken = await bridge.editorDraft({ operation: "take", sessionId: record.sessionId, expected: record.view.text });
		if (!taken.cleared || taken.error) throw new Error(taken.error ?? "omp's editor did not clear.");
		if (host.state.generation !== record.view.generation || host.state.sessionId !== record.sessionId) {
			await this.#roomChanged(record, host, input);
			return;
		}
		const diverged = !record.view.text.startsWith(record.nativeDraft);
		this.#ready(record, host, diverged ? "The offered suggestion changed. Its exact text was saved for review." : null);
	}

	async #roomChanged(record: CaptureRecord, host: PredictionHost, input: EditorInput): Promise<void> {
		if (host.state.phase === "exited" || !host.state.sessionId) {
			this.#ready(record, host, "The chat stopped. The captured suggestion was saved for recovery.");
			return;
		}
		input.assertOpen();
		const current = await this.bridgeFor(record.view.hostId).editorDraft({ operation: "peek", sessionId: host.state.sessionId });
		if (current.error || current.text !== "") throw new Error("The chat changed and its editor could not be confirmed empty. Its newer text was left unchanged; retry after clearing it in the terminal.");
		this.#ready(record, host, "The chat changed. The captured suggestion was saved for recovery.");
	}

	#ready(record: CaptureRecord, host: PredictionHost, error: string | null = null): void {
		record.view.blocked = false;
		record.view.error = error;
		if (this.#blocked.get(record.view.hostId) === record.view.id) {
			host.setEditorTransferBlocked(null);
			this.#blocked.delete(record.view.hostId);
		}
	}
	#fail(record: CaptureRecord, host: PredictionHost, error: unknown): void {
		if (host.state.phase === "exited") {
			this.#ready(record, host, String(error));
			return;
		}
		record.view.blocked = true;
		record.view.error = error instanceof Error ? error.message : String(error);
		this.#blocked.set(record.view.hostId, record.view.id);
		host.setEditorTransferBlocked("Recover the accepted suggestion or clear omp's editor in the terminal before sending another message.");
	}
	#expose(record: CaptureRecord): PredictionCapture {
		record.exposed = true;
		this.changed(this.list());
		return { ...record.view };
	}
}
