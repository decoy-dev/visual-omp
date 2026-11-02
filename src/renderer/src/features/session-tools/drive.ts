/**
 * Driving omp for session tools. Classic hosts use the painted status area to confirm commands.
 * TSP hosts use main's send availability and document ownership; semantic notices report feedback.
 */
import { TspDocumentStore } from "@shared/tsp/document";
import { openOverlay, screenSurface } from "@shared/tsp/view-state";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { toast } from "@/ui";
import { i18n } from "../../i18n";
import type { SessionController } from "../../state/session";
import { outputTone } from "./results";
import { newOutput, parseStatusLine } from "./screen";

const POLL_MS = 120;

export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

export async function readScreen(session: SessionController): Promise<string[]> {
	const hostId = session.hostId;
	if (!hostId) return [];
	return window.vomp.invoke("host:screen", hostId);
}

/** Poll the painted screen until `test` passes; resolves the matching lines, or null on timeout. */
export async function waitForScreen(
	session: SessionController,
	test: (lines: string[]) => boolean,
	timeoutMs = 4000,
): Promise<string[] | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const lines = await readScreen(session);
		if (test(lines)) return lines;
		if (Date.now() >= deadline) return null;
		await sleep(POLL_MS);
	}
}

/** Thrown when omp shows a menu or question of its own, so typing a command would land in it. */
export class OmpBusyError extends Error {
	constructor() {
		super(i18n.t("session:errors.busy"));
	}
}

/**
 * A document subscription scoped to one command's host, room generation and protocol epoch.
 * Subscribe before reading or submitting so an overlay opened during the write cannot be missed.
 */
export class TspEditorWatch {
	readonly #store = new TspDocumentStore();
	readonly #listeners = new Set<() => void>();
	readonly #off: (() => void)[];
	readonly #host;
	readonly #guest;
	readonly #working;
	readonly #stream;
	readonly #tools;
	#epoch: number | null = null;
	#disposed = false;
	#readError: unknown = null;
	constructor(readonly session: SessionController) {
		const view = session.getSnapshot();
		this.#host = view.host;
		this.#guest = session.guestClient();
		this.#working = view.working;
		this.#stream = view.guest?.stream;
		this.#tools = view.guest?.activeTools;
		const accept = (snapshot: TspHostSnapshot | null) => {
			if (this.#disposed || !snapshot || snapshot.hostId !== this.#host?.hostId) return;
			if (!this.#store.accept(snapshot)) return;
			if (snapshot.generation === this.#host?.generation) this.#epoch ??= snapshot.epoch;
			this.#notify();
		};
		this.#off = [
			window.vomp.on("host:tsp-update", accept),
			session.subscribe(() => this.#notify()),
		];
		void window.vomp.invoke("host:tsp-snapshot", this.#host!.hostId).then(snapshot => {
			if (snapshot) accept(snapshot);
			else { this.#readError = new Error("omp's semantic screen is unavailable."); this.#notify(); }
		}).catch(error => {
			this.#readError = error;
			this.#notify();
		});
	}
	#notify(): void { for (const listener of this.#listeners) listener(); }
	get snapshot(): TspHostSnapshot | null {
		const snapshot = this.#store.getSnapshot();
		return snapshot?.generation === this.#host?.generation ? snapshot : null;
	}
	get ended(): boolean {
		const view = this.session.getSnapshot();
		const snapshot = this.#store.getSnapshot();
		return this.#disposed || view.mode !== "live" || view.host?.hostId !== this.#host?.hostId ||
			view.host?.generation !== this.#host?.generation || view.host?.sessionId !== this.#host?.sessionId ||
			this.session.guestClient() !== this.#guest ||
			!!snapshot && (snapshot.generation !== this.#host?.generation ||
				(this.#epoch !== null && snapshot.epoch !== this.#epoch) || snapshot.lifecycle !== "live");
	}
	get blocked(): boolean {
		const surfaces = this.snapshot?.surfaces.filter(surface => surface.documentGeneration === this.snapshot?.generation) ?? [];
		return !!(openOverlay(surfaces) || screenSurface(surfaces));
	}
	get available(): boolean {
		return !this.ended && this.snapshot?.availability.available === true && !this.blocked;
	}
	async ready(): Promise<void> {
		await this.#wait(() => {
			if (this.blocked) throw new OmpBusyError();
			if (this.available) return true;
			if (this.ended) throw new Error(this.snapshot?.availability.reason ?? "omp is not running");
			if (this.#readError && !this.snapshot) throw this.#readError;
			return false;
		}, 8000).catch(error => {
			// An unavailable capability/editor times out without installing an overlay retry hold.
			if (error instanceof OmpBusyError && !this.blocked) {
				throw new Error(this.snapshot?.availability.reason ?? error.message);
			}
			throw error;
		});
	}
	/** UI-only feedback is projected as notices; this watch only protects input ownership. */
	watch(): Promise<void> {
		const progressed = () => {
			const current = this.session.getSnapshot();
			return this.#working ? !current.working || current.guest?.stream !== this.#stream || current.guest?.activeTools !== this.#tools : current.working;
		};
		// Allow omp's command handler to publish an overlay before treating an unchanged editor as free.
		return this.#wait(() => this.ended || (!this.blocked && progressed()), undefined, () => this.available);
	}
	/** A queued command found omp's own UI open. Wait for document readiness or scope invalidation. */
	back(): Promise<void> {
		return this.#wait(() => this.ended || this.available || (this.#readError !== null && !this.snapshot));
	}
	#wait(done: () => boolean, timeoutMs?: number, settled?: () => boolean): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settle: ReturnType<typeof setTimeout> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: unknown) => {
			clearTimeout(settle); clearTimeout(timeout); this.#listeners.delete(check);
			if (error) reject(error); else resolve();
		};
		const check = () => {
			// Unrelated transcript or document updates do not restart editor settling.
			try {
				if (done()) { finish(); return; }
				if (settled?.()) settle ??= setTimeout(() => finish(), 600);
				else { clearTimeout(settle); settle = undefined; }
			} catch (error) { finish(error); }
		};
		this.#listeners.add(check);
		if (timeoutMs !== undefined) timeout = setTimeout(() => finish(new OmpBusyError()), timeoutMs);
		check();
		return promise;
	}
	dispose(): void {
		this.#disposed = true;
		this.#notify();
		for (const off of this.#off) off();
		this.#listeners.clear();
	}
}
/**
 * Wait until omp's prompt editor is on screen (it is hidden while a dialog, picker or full-screen
 * menu is open). Starts omp first when the chat is not live yet and waits for it to connect, because
 * a saved chat's omp has no screen to read until its TUI is up.
 */
export async function readyEditor(session: SessionController): Promise<string[]> {
	await session.whenLive();
	if (session.getSnapshot().host?.transport === "tsp") {
		const watch = new TspEditorWatch(session);
		try { await watch.ready(); return []; }
		finally { watch.dispose(); }
	}
	const lines = await waitForScreen(session, screen => parseStatusLine(screen) !== null, 8000);
	if (!lines || (session.getSnapshot().host?.tui?.overlays ?? 0) > 0) throw new OmpBusyError();
	return lines;
}

export interface CommandResult {
	/** Classic feedback lines, oldest first. Empty for TSP, whose notices are projected separately. */
	output: string[];
	/** Classic screen after the command; empty for TSP. */
	screen: string[];
}

export interface CommandOptions {
	/** Resolve once the screen passes this test (default: any new output line or a status-line change). */
	until?: (lines: string[], output: string[]) => boolean;
	timeoutMs?: number;
}

/** Type a slash command into omp and collect the feedback it prints. */
export async function runCommand(session: SessionController, line: string, options: CommandOptions = {}): Promise<CommandResult> {
	const before = await readyEditor(session);
	if (session.getSnapshot().host?.transport === "tsp") {
		const watch = new TspEditorWatch(session);
		try {
			await watch.ready();
			await session.command(line);
			const watching = watch.watch();
			session.holdQueue(watching);
			await watching;
			// Semantic notices already report the command's feedback in the transcript.
			return { output: [], screen: [] };
		} finally { watch.dispose(); }
	}
	const beforeStatus = JSON.stringify(parseStatusLine(before));
	await session.command(line);
	let output: string[] = [];
	const screen =
		(await waitForScreen(
			session,
			lines => {
				output = newOutput(before, lines).filter(text => text !== line);
				if (options.until) return options.until(lines, output);
				return output.length > 0 || JSON.stringify(parseStatusLine(lines)) !== beforeStatus;
			},
			options.timeoutMs ?? 4000,
		)) ?? (await readScreen(session));
	return { output, screen };
}

/** Show omp's feedback for a command as a toast (warnings and errors as warn/err). */
export function reportOutput(output: readonly string[], fallback?: string): void {
	const message = output.at(-1) ?? fallback;
	if (!message) return;
	const tone = outputTone(message);
	toast({ tone, message: message.replace(/^(warning|error):\s*/i, "") });
}

/** Run a command and toast what omp said; busy/offline failures become an error toast too. */
export async function runAndReport(session: SessionController, line: string, options?: CommandOptions): Promise<CommandResult | null> {
	try {
		const result = await runCommand(session, line, options);
		reportOutput(result.output);
		return result;
	} catch (error) {
		reportFailure(error);
		return null;
	}
}

export function reportFailure(error: unknown): void {
	toast({ tone: "err", message: error instanceof Error ? error.message : String(error) });
}

/** Press keys (tmux-style tokens) and give omp a moment to repaint. */
export async function press(session: SessionController, keys: string): Promise<void> {
	await session.keys(keys);
	await sleep(60);
}
