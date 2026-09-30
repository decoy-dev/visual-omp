/**
 * One visible command run in a PTY (`term:start` with `command`). Output is buffered from the very
 * first byte so a terminal view can attach (or re-attach, e.g. under React StrictMode) at any time
 * and replay everything the process printed.
 */
export interface CommandRunListener {
	data(chunk: string): void;
	exit(code: number): void;
}

export class CommandRun {
	readonly termId: string;
	#chunks: string[] = [];
	#exitCode: number | null = null;
	#listeners = new Set<CommandRunListener>();
	#unsubscribe: () => void;

	private constructor(termId: string, early: { chunks: string[]; exit: number | null }, unsubscribe: () => void) {
		this.termId = termId;
		this.#chunks = early.chunks;
		this.#exitCode = early.exit;
		this.#unsubscribe = unsubscribe;
	}

	static async start(options: { command: string; cwd: string; cols: number; rows: number }): Promise<CommandRun> {
		// Subscribe before starting: output can arrive before `term:start` resolves with the id.
		const pending: { termId: string; data?: string; exit?: number }[] = [];
		let run: CommandRun | null = null;
		const offData = window.vomp.on("term:data", ({ termId, data }) => {
			if (run) {
				if (termId === run.termId) run.#onData(data);
			} else pending.push({ termId, data });
		});
		const offExit = window.vomp.on("term:exit", ({ termId, code }) => {
			if (run) {
				if (termId === run.termId) run.#onExit(code);
			} else pending.push({ termId, exit: code });
		});
		const unsubscribe = () => {
			offData();
			offExit();
		};
		try {
			const termId = await window.vomp.invoke("term:start", options);
			const early = { chunks: [] as string[], exit: null as number | null };
			for (const event of pending) {
				if (event.termId !== termId) continue;
				if (event.data !== undefined) early.chunks.push(event.data);
				if (event.exit !== undefined) early.exit = event.exit;
			}
			run = new CommandRun(termId, early, unsubscribe);
			if (early.exit !== null) unsubscribe();
			return run;
		} catch (error) {
			unsubscribe();
			throw error;
		}
	}

	get exitCode(): number | null {
		return this.#exitCode;
	}

	/** Replays buffered output (and the exit, if it already happened), then streams live. */
	attach(listener: CommandRunListener): () => void {
		for (const chunk of this.#chunks) listener.data(chunk);
		if (this.#exitCode !== null) listener.exit(this.#exitCode);
		if (this.#exitCode !== null) return () => {};
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	write(data: string): void {
		if (this.#exitCode === null) void window.vomp.invoke("term:write", this.termId, data);
	}

	resize(cols: number, rows: number): void {
		if (this.#exitCode === null) void window.vomp.invoke("term:resize", this.termId, cols, rows);
	}

	kill(): void {
		if (this.#exitCode === null) void window.vomp.invoke("term:kill", this.termId);
	}

	#onData(data: string): void {
		this.#chunks.push(data);
		for (const listener of this.#listeners) listener.data(data);
	}

	#onExit(code: number): void {
		this.#exitCode = code;
		this.#unsubscribe();
		for (const listener of this.#listeners) listener.exit(code);
	}
}
