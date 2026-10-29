/** omp's draft-only RPC dictation exposes recording readiness without scraping microphone glyphs. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { DictationUpdate } from "@shared/contracts/composer";
import { PersistentRpc } from "./rpc";

const frameSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("dictation_state"), captureId: z.string(), state: z.enum(["starting", "recording", "transcribing"]) }),
	z.object({ type: z.literal("dictation_transcript"), captureId: z.string(), text: z.string() }),
	z.object({ type: z.literal("dictation_end"), captureId: z.string(), text: z.string(), error: z.string().optional() }),
]);

interface Capture {
	id: string;
	rpc: Promise<PersistentRpc>;
	state: DictationUpdate;
	close(force?: boolean): void;
}
let active: Capture | null = null;

export function startDictation(folder: string, id: string, publish: (update: DictationUpdate) => void): void {
	if (active) throw new Error("Another dictation capture is still active.");
	if (!id.trim() || id.length > 128) throw new Error("Invalid dictation capture identifier.");
	const state: DictationUpdate = { captureId: id, state: "starting", text: "" };
	const ready = Promise.withResolvers<PersistentRpc>();
	const capture: Capture = { id, rpc: ready.promise, state, close: force => finish(undefined, force) };
	active = capture;
	publish(state);
	let directory: string | null = null;
	let client: PersistentRpc | null = null;
	let ended = false;
	const finish = (error?: string, force = false) => {
		if (ended) return;
		ended = true;
		if (active === capture) active = null;
		capture.state = { ...capture.state, state: "ended", ...(error ? { error } : {}) };
		publish(capture.state);
		client?.close(force);
		if (directory) void rm(directory, { recursive: true, force: true });
	};
	void (async () => {
		directory = await mkdtemp(join(tmpdir(), "vomp-dictation-"));
		const config = join(directory, "config.yml");
		await writeFile(config, "stt:\n  enabled: true\n", { mode: 0o600 });
		if (ended) {
			await rm(directory, { recursive: true, force: true });
			throw new Error("Dictation was cancelled.");
		}
		client = new PersistentRpc(folder, ["--config", config], message => {
			const parsed = frameSchema.safeParse(message);
			if (!parsed.success || parsed.data.captureId !== id || active !== capture) return;
			const frame = parsed.data;
			if (frame.type === "dictation_end") {
				capture.state = { ...capture.state, text: frame.text };
				finish(frame.error);
			} else {
				capture.state = { ...capture.state, ...(frame.type === "dictation_state" ? { state: frame.state } : { text: frame.text }) };
				publish(capture.state);
			}
		}, error => finish(error.message));
		// Deliberately do not await recording: dictation_stop must cancel a start still loading.
		void client.request("dictation_start", { captureId: id }, 10 * 60_000).catch(error => finish(String(error)));
		return client;
	})().then(ready.resolve, error => { finish(String(error)); ready.reject(error); });
	void ready.promise.catch(() => {});
}

export async function stopDictation(id: string): Promise<void> {
	const capture = active;
	if (!capture || capture.id !== id) return;
	const client = await capture.rpc;
	// The terminal frame is authoritative and closes the process after its final text arrives.
	await client.request("dictation_stop", {}, 120_000).catch(error => {
		if (active === capture) throw error;
	});
}

export function closeDictation(force = false): void {
	active?.close(force);
}
