const PREFIX = Buffer.from("\x1b_tsp;");
const ST = Buffer.from("\x1b\\");
const PARAM = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$/;

export interface TspMessage {
	verb: string;
	params: Record<string, string>;
	body: string;
}

interface ChunkedMessage {
	verb: string;
	params: Record<string, string>;
	bodies: Buffer[];
}

/** Splits bytes before decoding, so a PTY read or protocol chunk can bisect UTF-8. */
export class TspStream {
	readonly #onMessage: (message: TspMessage) => void;
	readonly #onData: (data: Buffer) => void;
	#pending: Buffer = Buffer.alloc(0);
	#inMessage = false;
	#chunks = new Map<string, ChunkedMessage>();

	constructor(options: { onMessage: (message: TspMessage) => void; onData: (data: Buffer) => void }) {
		this.#onMessage = options.onMessage;
		this.#onData = options.onData;
	}

	push(data: Uint8Array): void {
		if (data.length === 0) return;
		const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
		this.#pending = this.#pending.length ? Buffer.concat([this.#pending, bytes]) : bytes;
		while (this.#pending.length) {
			if (this.#inMessage) {
				const end = this.#pending.indexOf(ST, PREFIX.length);
				if (end === -1) return;
				const sequence = this.#pending.subarray(0, end + ST.length);
				this.#pending = this.#pending.subarray(end + ST.length);
				this.#inMessage = false;
				this.#message(sequence);
				continue;
			}
			const start = this.#pending.indexOf(PREFIX);
			if (start !== -1) {
				if (start) this.#onData(this.#pending.subarray(0, start));
				this.#pending = this.#pending.subarray(start);
				this.#inMessage = true;
				continue;
			}
			// Only a suffix that could become the prefix must wait for the next read.
			let keep = Math.min(this.#pending.length, PREFIX.length - 1);
			while (keep && !this.#pending.subarray(this.#pending.length - keep).equals(PREFIX.subarray(0, keep))) keep--;
			const emit = this.#pending.length - keep;
			if (emit) this.#onData(this.#pending.subarray(0, emit));
			this.#pending = this.#pending.subarray(emit);
			return;
		}
	}

	/** An unfinished escape sequence is still ordinary terminal output on process exit. */
	end(): void {
		if (this.#pending.length) this.#onData(this.#pending);
		this.#pending = Buffer.alloc(0);
		this.#inMessage = false;
		this.#chunks.clear();
	}

	#message(sequence: Buffer): void {
		const inner = sequence.subarray(PREFIX.length, -ST.length);
		const semi = inner.indexOf(0x3b);
		if (semi <= 0) {
			this.#onData(sequence);
			return;
		}
		const verb = inner.toString("ascii", 0, semi);
		const params: Record<string, string> = {};
		let pos = semi + 1;
		for (;;) {
			const next = inner.indexOf(0x3b, pos);
			if (next === -1) break;
			const segment = inner.toString("latin1", pos, next);
			if (!PARAM.test(segment)) break;
			const equal = segment.indexOf("=");
			params[segment.slice(0, equal)] = segment.slice(equal + 1);
			pos = next + 1;
		}
		const body = inner.subarray(pos);
		if (params.c === undefined) {
			this.#onMessage({ verb, params, body: body.toString("utf8") });
			return;
		}
		const key = `${verb};${params.c}`;
		let chunk = this.#chunks.get(key);
		if (!chunk) {
			const { c: _chunkId, m: _more, ...original } = params;
			chunk = { verb, params: original, bodies: [] };
		}
		chunk.bodies.push(body);
		if (params.m === "1") {
			this.#chunks.set(key, chunk);
			return;
		}
		this.#chunks.delete(key);
		this.#onMessage({ verb, params: chunk.params, body: Buffer.concat(chunk.bodies).toString("utf8") });
	}
}
