/**
 * Driving omp for session tools. Classic hosts use the painted status area to confirm commands.
 * TSP hosts use main's send availability and document ownership; semantic notices report feedback.
 */
import { openOverlay, screenSurface, walkNodes } from "@shared/tsp/view-state";
import { TSP_CLASSIC_ACTION_UNAVAILABLE, type TspHostSnapshot } from "@shared/tsp-host";
import { commandOutcome, commandOutcomeSpec, type CommandOutcome, type CommandOutcomeSpec } from "@shared/tsp/command-result";
import { TSP_ROLES } from "@shared/tsp/roles";
import { toast } from "@/ui";
import { isResumeDeclined } from "../../registry/guards";
import { i18n } from "../../i18n";
import type { TspCommandNoticeReservation } from "../../state/tsp/notices";
import { tspHost, type TspHostSource } from "../../state/tsp/hosts";
import { screenActivity } from "../../state/tsp/screen-activity";
import { useApp } from "../../state/app";
import { currentPresentationConsumers, currentTabPresentationVisible, subscribePresentationConsumers } from "../../state/tsp/presentation-claims";
import { screenCandidateKey } from "../palette/auto-screen";
import type { SessionController } from "../../state/session";
import { outputTone, roomKey } from "./results";
import { displayedEntries } from "../../chat/branch";
import { startCommandPanels } from "./command-panels";
import { newOutput, parseStatusLine, statusBorderLine } from "./screen";

const POLL_MS = 120;

export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

export async function readScreen(session: SessionController): Promise<string[]> {
	if (session.getSnapshot().host?.transport === "tsp") throw new Error(TSP_CLASSIC_ACTION_UNAVAILABLE);
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

/** Readiness failed without evidence that an omp menu is open. */
export async function statusReadError(session: SessionController, lines: readonly string[]): Promise<Error> {
	if (session.getSnapshot().host?.transport === "tsp") return new Error(TSP_CLASSIC_ACTION_UNAVAILABLE);
	if (session.hostId) {
		await window.vomp.invoke("host:statusUnreadable", session.hostId, statusBorderLine(lines)).catch(() => undefined);
	}
	return new Error(i18n.t("session:errors.statusUnreadable"));
}

/**
 * A document subscription scoped to one command's host, room generation and protocol epoch.
 * Subscribe before reading or submitting so an overlay opened during the write cannot be missed.
 */
export class TspEditorWatch {
	readonly #source: TspHostSource;
	readonly #listeners = new Set<() => void>();
	readonly #off: (() => void)[];
	readonly #host;
	readonly #guest;
	readonly #working;
	readonly #stream;
	readonly #tools;
	#epoch: number | null = null;
	#disposed = false;
	constructor(readonly session: SessionController) {
		const view = session.getSnapshot();
		this.#host = view.host;
		this.#guest = session.guestClient();
		this.#working = view.working;
		this.#stream = view.guest?.stream;
		this.#tools = view.guest?.activeTools;
		this.#source = tspHost(this.#host!.hostId);
		const changed = () => {
			if (this.#disposed) return;
			const snapshot = this.#source.getSnapshot();
			if (snapshot && snapshot.generation === this.#host?.generation) this.#epoch ??= snapshot.epoch;
			this.#notify();
		};
		this.#off = [this.#source.subscribe(changed), session.subscribe(() => this.#notify())];
		changed();
	}
	#notify(): void { for (const listener of this.#listeners) listener(); }
	get snapshot(): TspHostSnapshot | null {
		const snapshot = this.#source.getSnapshot();
		return snapshot?.generation === this.#host?.generation ? snapshot : null;
	}
	get ended(): boolean {
		const view = this.session.getSnapshot();
		const snapshot = this.#source.getSnapshot();
		return this.#disposed || view.mode !== "live" || view.host?.hostId !== this.#host?.hostId ||
			view.host?.generation !== this.#host?.generation || view.host?.sessionId !== this.#host?.sessionId ||
			this.session.guestClient() !== this.#guest ||
			!!snapshot && (snapshot.generation !== this.#host?.generation ||
				(this.#epoch !== null && snapshot.epoch !== this.#epoch) || snapshot.lifecycle !== "live");
	}
	get blocked(): boolean {
		const surfaces = this.snapshot?.surfaces.filter(surface => surface.documentGeneration === this.snapshot?.generation) ?? [];
		return !!(openOverlay(surfaces, true) || screenSurface(surfaces));
	}
	get available(): boolean {
		return !this.ended && this.snapshot?.availability.available === true && !this.blocked;
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	async ready(): Promise<void> {
		await this.#wait(() => {
			if (this.blocked) throw new OmpBusyError();
			if (this.available) return true;
			if (this.ended) throw new Error(this.snapshot?.availability.reason ?? "omp is not running");
			if (this.#source.failed() && !this.snapshot) throw new Error("omp's semantic screen is unavailable.");
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
	/** Watch only new command feedback. Quiet commands have an explicit per-command settle interval. */
	outcome(before: TspHostSnapshot, spec: CommandOutcomeSpec, startedAt: number, timeoutMs = 10 * 60_000): Promise<CommandOutcome | null> {
		const { promise, resolve } = Promise.withResolvers<CommandOutcome | null>();
		let finished = false;
		let quiet: ReturnType<typeof setTimeout> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let firstOutput: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: CommandOutcome | null) => {
			if (finished) return;
			finished = true; clearTimeout(quiet); clearTimeout(timeout); clearTimeout(firstOutput); this.#listeners.delete(check); resolve(result);
		};
		const check = () => {
			if (this.ended) { finish(null); return; }
			const after = this.snapshot;
			if (!after) return;
			const result = commandOutcome(before, after, { ...spec, elapsedMs: Date.now() - startedAt });
			if (result) finish(result);
			else if (this.blocked) finish(null);
			else if (Date.now() - startedAt >= 5000 && !after.surfaces.some(surface => !surface.closed && [...walkNodes(surface.document)].some(node => node.p?.role === TSP_ROLES.working || node.p?.role === TSP_ROLES.loader))) finish(null);
		};
		this.#listeners.add(check);
		timeout = setTimeout(() => finish(null), timeoutMs);
		if (spec.quietMs !== undefined) quiet = setTimeout(check, Math.max(0, spec.quietMs - (Date.now() - startedAt)));
		firstOutput = setTimeout(check, Math.max(0, 5000 - (Date.now() - startedAt)));
		check();
		return promise;
	}
	/** A queued command found omp's own UI open. Wait for document readiness or scope invalidation. */
	back(): Promise<void> {
		return this.#wait(() => this.ended || this.available || (this.#source.failed() && !this.snapshot));
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
	let lastScreen: string[] = [];
	const lines = await waitForScreen(session, screen => {
		lastScreen = screen;
		return parseStatusLine(screen) !== null;
	}, 8000);
	if (session.getSnapshot().host?.transport === "tsp") throw new Error("The chat changed while waiting for omp's classic editor.");
	// Read after the screen wait: HostState.tui may predate an overlay change.
	const hostId = session.hostId;
	const focus = hostId ? await window.vomp.invoke("host:tui-focus", hostId) : null;
	if (!focus) throw new Error(i18n.t("session:errors.focusUnavailable"));
	if (focus.overlays > 0) throw new OmpBusyError();
	if (!lines) throw await statusReadError(session, lastScreen);
	return lines;
}

export interface CommandResult {
	/** Feedback lines from the selected presentation. */
	output: string[];
	/** Classic screen after the command; empty for TSP. */
	screen: string[];
	/** Semantic command status; classic callers keep their existing text-derived behavior. */
	status?: CommandOutcome["status"];
}

export interface CommandOptions {
	/** Resolve once the screen passes this test (default: any new output line or a status-line change). */
	until?: (lines: string[], output: string[]) => boolean;
	timeoutMs?: number;
	/** Deliberately show omp's live board or other unpresented native UI immediately. */
	screenIntent?: "request";
	/** Return true only after displaying this output. Undelivered TSP feedback returns to notices. */
	present?: (result: CommandResult) => boolean;
}

/** Queue an exact native handoff for the watcher to decide after the current layout commits. */
export function openRequestedScreen(session: SessionController, snapshot: TspHostSnapshot): void {
	const source = tspHost(snapshot.hostId);
	const sessionId = session.getSnapshot().host?.sessionId;
	const currentCandidate = (): { snapshot: TspHostSnapshot; key: string } | null => {
		const view = session.getSnapshot();
		const latest = source.getSnapshot();
		if ((view.mode !== "live" && view.mode !== "starting") || view.readOnly || view.host?.transport !== "tsp"
			|| view.host.hostId !== snapshot.hostId || view.host.generation !== snapshot.generation || view.host.sessionId !== sessionId
			|| !latest || latest.hostId !== snapshot.hostId || latest.generation !== snapshot.generation || latest.epoch !== snapshot.epoch
			|| latest.revision < snapshot.revision || !latest.negotiated || latest.lifecycle !== "live" || latest.closing) return null;
		const app = useApp.getState();
		if (app.view !== "chat" || (app.activeTabId !== session.tabId && app.splitTabId !== session.tabId) || app.terminalTabId || app.sheet || !currentTabPresentationVisible(session.tabId)) return null;
		const key = screenCandidateKey(latest, currentPresentationConsumers(latest.hostId, latest.epoch));
		return key === null ? null : { snapshot: latest, key };
	};
	const candidate = currentCandidate();
	if (!candidate) return;
	const request = screenActivity.requestOnce(candidate.snapshot, candidate.snapshot.revision, candidate.key);
	const check = () => { if (currentCandidate()?.key !== candidate.key) request.cancel(); };
	const off = [source.subscribe(check), session.subscribe(check), subscribePresentationConsumers(check), useApp.subscribe(check)];
	void request.done.then(() => { for (const stop of off) stop(); });
	check();
}

/** Type a slash command into omp and collect the feedback it prints. */
export async function runCommand(session: SessionController, line: string, options: CommandOptions = {}): Promise<CommandResult> {
	const before = await readyEditor(session);
	if (session.getSnapshot().host?.transport === "tsp") {
		const watch = new TspEditorWatch(session);
		let reservation: TspCommandNoticeReservation | undefined;
		let stopPanels: (() => void) | undefined;
		let releaseIntent = () => {};
		const offIntent = watch.subscribe(() => { if (watch.ended) releaseIntent(); });
		try {
			await watch.ready();
			const baseline = watch.snapshot!;
			const spec = commandOutcomeSpec(line);
			const pinned = spec?.panel ? null : spec;
			if (pinned) reservation = session.tspNotices.beginCommand(baseline, pinned);
			const startedAt = Date.now();
			const watching = pinned ? watch.outcome(baseline, pinned, startedAt, options.timeoutMs).then(outcome => {
				if (!outcome) reservation?.cancel();
				return outcome;
			}) : watch.watch().then(() => null);
			try {
				await session.command(line, () => {
					const current = watch.snapshot;
					if (!current || watch.ended) return;
					releaseIntent = screenActivity.hold(current, options.screenIntent ?? "drive");
					const view = session.getSnapshot();
					stopPanels = startCommandPanels(session, line, current, displayedEntries(view).at(-1)?.id ?? null, roomKey(view));
				});
			} finally { if (!options.screenIntent) releaseIntent(); }
			if (options.screenIntent && !watch.ended && watch.snapshot) openRequestedScreen(session, watch.snapshot);
			session.holdQueue(watching.then(() => undefined));
			const outcome = await watching;
			const result: CommandResult = { output: outcome?.lines ?? [], screen: [], ...(outcome ? { status: outcome.status } : {}) };
			if (options.present?.(result) && outcome) reservation?.commit(outcome);
			return result;
		} catch (error) {
			stopPanels?.();
			throw error;
		} finally { releaseIntent(); offIntent(); reservation?.cancel(); watch.dispose(); }
	}
	const beforeStatus = JSON.stringify(parseStatusLine(before));
	let releaseIntent = () => {};
	try {
		await session.command(line, () => {
			const host = session.getSnapshot().host;
			if (!host) return;
			const release = screenActivity.hold({ hostId: host.hostId, generation: host.generation, epoch: null }, options.screenIntent ?? "drive");
			const off = session.subscribe(() => {
				const current = session.getSnapshot();
				if (current.mode !== "live" || current.host?.hostId !== host.hostId || current.host.generation !== host.generation) releaseIntent();
			});
			releaseIntent = () => { release(); off(); };
		});
	} finally { releaseIntent(); }
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
	const result = { output, screen };
	options.present?.(result);
	return result;
}

/** Show omp's feedback for a command as a toast (warnings and errors as warn/err). */
export function reportOutput(output: readonly string[], fallback?: string, status?: CommandOutcome["status"]): boolean {
	const message = status ? output.join("\n") || fallback : output.at(-1) ?? fallback;
	if (!message) return false;
	const tone = status === "error" ? "err" : status === "cancelled" ? "info" : outputTone(message);
	toast({ tone, message: message.replace(/^(warning|error):\s*/i, "") });
	return true;
}

/** Run a command and toast what omp said; busy/offline failures become an error toast too. */
export async function runAndReport(session: SessionController, line: string, options?: CommandOptions): Promise<CommandResult | null> {
	try {
		return await runCommand(session, line, {
			...options,
			present: result => options?.present?.(result) || reportOutput(result.output, undefined, result.status),
		});
	} catch (error) {
		reportFailure(error);
		return null;
	}
}

/** Toast a failed session action. A declined large-chat warning is the user's choice, so it reports nothing. */
export function reportFailure(error: unknown): void {
	if (isResumeDeclined(error)) return;
	toast({ tone: "err", message: error instanceof Error ? error.message : String(error) });
}

/** Press keys (tmux-style tokens) and give omp a moment to repaint. */
export async function press(session: SessionController, keys: string): Promise<void> {
	await session.keys(keys);
	await sleep(60);
}
