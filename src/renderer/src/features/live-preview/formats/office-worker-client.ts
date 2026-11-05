/** One worker belongs to one revision. Disposing it rejects every pending reply. */
export class OfficeWorkerClient {
	private serial = 0;
	private closed = false;
	private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
	constructor(private worker: Worker) {
		worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; reason?: string }>) => {
			const item = this.pending.get(event.data.id);
			if (!item) return;
			clearTimeout(item.timer); this.pending.delete(event.data.id);
			if (event.data.ok) item.resolve(event.data);
			else item.reject(new Error(event.data.reason ?? "unsafe"));
		};
		worker.onerror = () => this.dispose("unsafe");
		worker.onmessageerror = () => this.dispose("unsafe");
	}
	request<T>(message: object, transfer: Transferable[] = []): Promise<T> {
		if (this.closed) return Promise.reject(new Error("revoked"));
		const id = ++this.serial;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = window.setTimeout(() => this.dispose("timeout"), 15_000);
		this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
		try { this.worker.postMessage({ ...message, id }, transfer); }
		catch { this.dispose("unsafe"); }
		return promise;
	}
	dispose(reason = "revoked"): void {
		if (this.closed) return;
		this.closed = true;
		this.worker.terminate();
		for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(reason)); }
		this.pending.clear();
	}
}
