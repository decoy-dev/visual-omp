import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiagnosticEvent } from "./log";

type HangEvent = Extract<DiagnosticEvent, { event: "window-responsive" }>;
/** Store only a confirmed ten-second hang, so downtime cannot turn a short stall into a report. */
export class PendingHang {
	#pending = Promise.resolve();
	constructor(readonly file: string) {}
	save(windowId: number, durationMs: number): void {
		this.#pending = this.#pending.catch(() => {}).then(async () => {
			await mkdir(dirname(this.file), { recursive: true });
			await writeFile(`${this.file}.tmp`, JSON.stringify({ windowId, durationMs }), { mode: 0o600 });
			await rename(`${this.file}.tmp`, this.file);
		}).catch(() => {});
	}
	clear(): void {
		this.#pending = this.#pending.then(() => rm(this.file, { force: true })).catch(() => {});
	}
	async recover(): Promise<HangEvent | null> {
		await this.#pending;
		try {
			const value = JSON.parse(await readFile(this.file, "utf8")) as { windowId?: unknown; durationMs?: unknown };
			if (!Number.isSafeInteger(value.windowId) || (value.windowId as number) < 0 || !Number.isSafeInteger(value.durationMs) || (value.durationMs as number) < 10_000) return null;
			return { event: "window-responsive", windowId: value.windowId as number, durationMs: value.durationMs as number, recovered: true };
		} catch { return null; }
		finally { await rm(this.file, { force: true }).catch(() => {}); }
	}
	async flush(): Promise<void> { await this.#pending; }
}
