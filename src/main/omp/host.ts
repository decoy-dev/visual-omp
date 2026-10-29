/**
 * SessionHost: one hidden omp TUI per chat.
 *
 * omp runs in a node-pty with a per-session `--config` overlay that makes it host a collab room on
 * a private loopback relay. When the room opens, the control link is resolved through
 * `omp collab list/link --json` and handed to the renderer's guest client, which mirrors the
 * session as native UI. Input is typed into the real TUI; focus/overlay state comes from omp's
 * `OMP_TUI_DEBUG` socket. See docs/ARCHITECTURE.md.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { type IPty, spawn } from "node-pty";
import { stringify } from "yaml";
import { z } from "zod";
import type { HostStartOptions, HostState, TuiFocus } from "@shared/ipc";
import { BrowserWindow, dialog, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";
import hostLabels from "../../shared/i18n/en/host.json";
import { crashedWithoutExit, parseProgramStatus, readSessionRecaps, startupModelWarnings, worktreeConfirmation } from "./host-observations";
import { createNativeBridge, type NativeBridge } from "./native-bridge";
import { ptyEnv, userEnv } from "../env";
import { broadcast } from "../ipc";
import { runOmpJson } from "./cli";
import { ompPath } from "./locate";
import { ompStartError } from "./refused";
import { LoopbackRelay } from "./relay";
import { findRoomHost } from "./room-host";
import { findSessionFile, onSessionsChanged } from "./sessions";
import { TuiDebugClient, type TuiPaint } from "./tui-debug";

const CollabHosts = z.object({
	hosts: z.array(
		z.object({
			instanceId: z.string(),
			generation: z.number(),
			pid: z.number(),
			startedAt: z.number(),
			sessionId: z.string().nullable(),
			cwd: z.string(),
		}),
	),
});
const CollabLink = z.object({ url: z.string(), generation: z.number() });

/** omp publishes its registry entry shortly after the relay connection opens. */
const LINK_RETRY_MS = 250;
const LINK_RETRY_LIMIT = 40;
const FOCUS_POLL_MS = 500;
const STOP_GRACE_MS = 4000;
const STOP_PROGRESS_MS = 15_000;
type ShutdownStage = "requested" | "acknowledged" | "teardown" | "cleanup";
const STARTUP_DIAGNOSTIC_MAX_LINES = 8;
const STARTUP_DIAGNOSTIC_MAX_CHARS = 1200;
const STARTUP_DIAGNOSTIC = /^(?:Error:\s*|Session file not found:\s*|Could not restore model\s+|Model (?:unavailable:\s*|.+ (?:not found|unavailable)\b)|No models available\.)/;

export interface EditorInputTransaction {
	assertOpen(): void;
	/** Uses the held input lock; calling SessionHost.keys() inside a transaction would re-enter it. */
	keys(keys: string): Promise<void>;
}

export class SessionHost {
	readonly id = randomUUID();
	readonly #options: HostStartOptions;
	readonly #relay = new LoopbackRelay();
	readonly #screen: Terminal;
	readonly #serializer = new SerializeAddon();
	#pty: IPty | null = null;
	#debug: TuiDebugClient | null = null;
	#privateDir: string | null = null;
	#roomId: string | null = null;
	#spawnedAt = 0;
	#runStartedAt = 0;
	#focusTimer: NodeJS.Timeout | null = null;
	#exited: Promise<void>;
	#markExited: () => void;
	#lastExitReason: string | null = null;
	#startupComplete = false;
	#startupResumeFileMissing = false;
	#captureStartupNotices = true;
	#recapIdentity: string | null = null;
	#confirmingWorktree = false;
	#worktreeDecision: Promise<void> | null = null;
	#polling = false;
	#stopping: Promise<void> | null = null;
	#closing = false;
	#inputTail: Promise<void> = Promise.resolve();
	#editorTransferBlocked: string | null = null;
	#shutdownStage: ShutdownStage = "requested";
	#shutdownProgressAt = 0;
	#shutdownPrompt = false;
	#nativeBridge: NativeBridge | null = null;
	state: HostState;

	constructor(options: HostStartOptions) {
		this.#options = options;
		const cols = options.cols ?? 120;
		const rows = options.rows ?? 36;
		this.#screen = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
		this.#screen.loadAddon(this.#serializer);
		this.#screen.parser.registerOscHandler(7501, body => {
			const programStatus = parseProgramStatus(body);
			if (programStatus !== undefined) this.#update({ programStatus });
			if (programStatus === null && this.#closing && this.#shutdownStage === "teardown") this.#shutdownProgress("cleanup");
			return true;
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#exited = promise;
		this.#markExited = resolve;
		this.state = {
			hostId: this.id,
			cwd: options.cwd,
			phase: "starting",
			link: null,
			generation: 0,
			sessionId: null,
			sessionFile: options.resumeFile ?? null,
			pid: null,
			exitCode: null,
			exitReason: null,
			resumeFileMissing: false,
			error: null,
			programStatus: null,
			restoreAvailable: false,
			notices: [],
			tui: null,
			cols,
			rows,
		};
	}

	async start(): Promise<void> {
		try {
			const [bin, env] = await Promise.all([ompPath(), userEnv()]);
			await this.#relay.start();
			this.#relay.events = {
				onHostOpen: roomId => {
					// A second relay room must never replace the session this host already owns.
					// Legitimate rotations close the previous room before opening its successor.
					if (this.#roomId !== null) return;
					this.#runStartedAt = Date.now();
					this.#finishStartup();
					void this.#resolveLink(roomId);
				},
				onHostClose: roomId => this.#onRoomClosed(roomId),
			};
			// Owner-only directory: the debug socket accepts keystrokes, so nobody else may reach it.
			this.#privateDir = await mkdtemp(join(tmpdir(), "vomp-"));
			this.#nativeBridge = await createNativeBridge(this.id, this.#privateDir);
			const overlay = join(this.#privateDir, "overlay.yml");
			await writeFile(overlay, stringify(this.#overlayConfig()), { mode: 0o600 });
			const debugPath =
				process.platform === "win32" ? `\\\\.\\pipe\\visual-omp-${this.id}` : join(this.#privateDir, "tui.sock");
			const args = ["--config", overlay, "--extension", this.#nativeBridge.extensionPath];
			if (this.#options.resumeFile) args.push(this.#options.restore ? "--restore" : "--resume", this.#options.resumeFile);
			args.push(...(this.#options.extraArgs ?? []));
			const childEnv: NodeJS.ProcessEnv = { ...env, OMP_SKIP_SETUP: "1", OMP_TUI_DEBUG: debugPath, PI_TUI_NATIVE: "0" };
			childEnv.VOMP_NATIVE_BRIDGE = this.#nativeBridge.url;
			delete childEnv.TERM_PROGRAM;
			try {
				this.#spawnedAt = Date.now();
				this.#runStartedAt = this.#spawnedAt;
				this.#pty = spawn(bin, args, {
					name: "xterm-256color",
					cols: this.#screen.cols,
					rows: this.#screen.rows,
					cwd: this.#options.cwd,
					env: ptyEnv(childEnv),
				});
			} catch (error) {
				throw await ompStartError(error, bin);
			}
			this.#debug = new TuiDebugClient(debugPath);
			this.#pty.onData(data => {
				this.#screen.write(data, () => {
					// Keep only recognized startup diagnostics, never the live transcript or editor.
					if (!this.#startupComplete) this.#rememberStartupDiagnostic();
					if (this.#captureStartupNotices) this.#rememberStartupNotices();
					if (this.#closing) this.#rememberShutdownProgress();
				});
				broadcast("host:data", { hostId: this.id, data });
			});
			this.#pty.onExit(({ exitCode }) => void this.#onExit(exitCode));
			this.#update({ phase: "connecting", pid: this.#pty.pid });
			this.#focusTimer = setInterval(() => void this.#pollFocus(), FOCUS_POLL_MS);
		} catch (error) {
			this.#update({ phase: "exited", error: error instanceof Error ? error.message : String(error) });
			await this.#cleanup();
		}
	}

	/** Settings layered over the user's config for this process only. */
	#overlayConfig(): Record<string, unknown> {
		return {
			collab: { autoStart: "control", relayUrl: this.#relay.url, displayName: "visual-omp" },
			startup: { setupWizard: false, checkUpdate: false, changelogMode: "hidden", quiet: true },
			// A marker-sized paste followed by Enter becomes an attachment chip; never open the local paste menu.
			paste: { largeMenuThreshold: 0 },
			marketplace: { autoUpdate: "off" },
			tui: {
				// Tables chart with omp's local rules only. `auto` and `smart` add model judge calls whose
				// chart plans collab does not carry; the app draws the same local chart natively.
				autoGraph: "always",
			},
			worktree: {
				// omp 18.14 does not expose when startup input is accepted, so a startup worktree question
				// could meet an early keystroke. Remove once omp reports input readiness.
				onStart: "off",
			},
			// The app reads this TUI's status line from the editor border (renderer session-tools/screen.ts),
			// so it pins the format that parser reads over the user's status line settings. A theme's
			// symbol overrides still apply after the preset and can change those glyphs.
			symbolPreset: "unicode",
			statusLine: {
				preset: "default",
				separator: "powerline",
				compactThinkingLevel: false,
				segmentOptions: { model: { showThinkingLevel: true } },
			},
		};
	}

	/** Raw bytes to the TUI (terminal sheet keystrokes). */
	write(data: string): void {
		this.#captureStartupNotices = false;
		this.#finishStartup();
		this.#pty?.write(data);
	}

	/**
	 * Type `text` as one bracketed paste and submit it in the same write, so multi-line text never
	 * submits early and a large paste becomes an attachment chip instead of a menu.
	 * `steer` (Enter) interrupts a running turn at the next safe point; `followUp` (Ctrl+Q) waits for the yield.
	 */
	submit(text: string, mode: "steer" | "followUp" = "steer"): Promise<void> {
		return this.#applicationInput(async () => {
			await this.#resolveWorktreeQuestion();
			this.#assertApplicationInput(true);
			if (this.#editorTransferBlocked) throw new Error(this.#editorTransferBlocked);
			this.#captureStartupNotices = false;
			this.#finishStartup();
			// An image-only submission is Enter, without the empty paste that reads the clipboard.
			this.#pty!.write(`${text ? `\x1b[200~${text}\x1b[201~` : ""}${mode === "followUp" ? "\x11" : "\r"}`);
		});
	}

	paste(text: string): Promise<void> {
		return this.#applicationInput(async () => {
			await this.#resolveWorktreeQuestion();
			this.#assertApplicationInput(true);
			if (this.#editorTransferBlocked) throw new Error(this.#editorTransferBlocked);
			this.#captureStartupNotices = false;
			this.#finishStartup();
			this.#pty!.write(`\x1b[200~${text}\x1b[201~`);
		});
	}

	/** Exact-transfer recovery gates composed input, while manual keys, recovery and Stop remain available. */
	setEditorTransferBlocked(reason: string | null): void {
		this.#editorTransferBlocked = reason;
	}

	/** Hold the application input lock across one exact editor transfer and its verification. */
	withEditorInput<T>(operation: (input: EditorInputTransaction) => Promise<T>): Promise<T> {
		return this.#applicationInput(async () => {
			await this.#resolveWorktreeQuestion();
			this.#assertApplicationInput(true);
			let active = true;
			const assertOpen = (): void => {
				if (!active) throw new Error(hostLabels.editorTransactionClosed);
				this.#assertApplicationInput(true);
			};
			const input: EditorInputTransaction = {
				assertOpen,
				keys: async keys => {
					assertOpen();
					if (!this.#debug) throw new Error("omp is not running");
					await this.#debug.keys(keys);
					assertOpen();
				},
			};
			try {
				const result = await operation(input);
				assertOpen();
				return result;
			}
			finally { active = false; }
		});
	}

	#assertApplicationInput(afterPreflight = false): void {
		if (this.#closing) throw new Error(hostLabels.closingInput);
		if (!this.#pty) throw new Error("omp is not running");
		if (afterPreflight && this.#worktreeDecision) throw new Error(hostLabels.worktreeQuestionUnresolved);
	}

	#applicationInput<T>(work: () => Promise<T>): Promise<T> {
		try { this.#assertApplicationInput(); } catch (error) { return Promise.reject(error); }
		const pending = this.#inputTail.then(async () => {
			this.#assertApplicationInput();
			return work();
		});
		this.#inputTail = pending.then(() => undefined, () => undefined);
		return pending;
	}

	/** Shared by application input and shutdown; terminal-sheet bytes stay a separate explicit path. */
	async #resolveWorktreeQuestion(): Promise<void> {
		if (this.#worktreeDecision) return this.#worktreeDecision;
		if (!this.#debug) throw new Error("omp is not running");
		const confirmation = worktreeConfirmation(await this.#debug.screen());
		// A poll may have opened the native dialog during the screen request.
		if (this.#worktreeDecision) return this.#worktreeDecision;
		if (!confirmation) return;
		this.#worktreeDecision = this.#confirmWorktree(confirmation).finally(() => { this.#worktreeDecision = null; });
		return this.#worktreeDecision;
	}

	async #confirmWorktree(confirmation: { title: string; detail: string; selectedYes: boolean }): Promise<void> {
		this.#confirmingWorktree = true;
		try {
			const remove = confirmation.title === "Remove worktree?";
			const result = await this.#messageBox({
				type: remove ? "warning" : "question",
				message: confirmation.title,
				detail: confirmation.detail,
				buttons: remove ? [hostLabels.keepWorktree, hostLabels.removeWorktree] : [hostLabels.keepFolder, hostLabels.createWorktree],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			});
			if (!this.#debug || this.state.phase === "exited") return;
			const current = worktreeConfirmation(await this.#debug.screen());
			if (!current || current.title !== confirmation.title || current.detail !== confirmation.detail) return;
			// Closing supersedes an outstanding startup request to create a new worktree.
			const yes = result.response === 1 && (remove || !this.#closing);
			await this.#debug.keys(yes === current.selectedYes ? "enter" : `${yes ? "up" : "down"} enter`);
			// The debug acknowledgement precedes the next paint. Wait for that paint before
			// returning a queued message to the editor, without answering the same dialog twice.
			for (let attempt = 0; attempt < 60; attempt++) {
				await sleep(50);
				if (this.#pty === null) return;
				const next = worktreeConfirmation(await this.#debug.screen());
				if (!next || next.title !== current.title || next.detail !== current.detail) return;
			}
			throw new Error(hostLabels.worktreeQuestionUnresolved);
		} finally { this.#confirmingWorktree = false; }
	}

	keys(keys: string): Promise<void> {
		return this.#applicationInput(async () => {
			if (!this.#debug) throw new Error("omp is not running");
			const lines = await this.#debug.screen();
			if (this.#worktreeDecision || worktreeConfirmation(lines)) throw new Error(hostLabels.worktreeQuestionUnresolved);
			this.#assertApplicationInput(true);
			this.#captureStartupNotices = false;
			this.#finishStartup();
			await this.#debug.keys(keys);
		});
	}

	async screenLines(): Promise<string[]> {
		if (!this.#debug) return [];
		return this.#debug.screen();
	}

	async screenPaint(): Promise<TuiPaint> {
		if (!this.#debug) return { lines: [] };
		return this.#debug.paint();
	}

	/** TUI component debug state (e.g. the editor's current text) for features that read omp's own UI. */
	async debugValues(): Promise<Record<string, unknown>> {
		if (!this.#debug) return {};
		return this.#debug.values();
	}

	/** Read current focus directly; cached HostState.tui is only a periodic UI projection. */
	async tuiFocus(): Promise<TuiFocus | null> {
		if (!this.#debug || this.#pty === null) return null;
		return this.#debug.info().catch(() => null);
	}

	/** Learn the session file once omp creates it (new chats) so reattaching renderers can match it. */
	async refreshSessionFile(): Promise<void> {
		const initial = this.state;
		if (initial.sessionFile || !initial.sessionId || initial.phase === "exited") return;
		const file = await findSessionFile(initial.sessionId);
		if (this.state !== initial || !file) return;
		this.#update({ sessionFile: file });
	}

	resize(cols: number, rows: number): void {
		if (cols < 20 || rows < 5) return;
		this.#pty?.resize(cols, rows);
		this.#screen.resize(cols, rows);
		this.#update({ cols, rows });
	}

	serializedScreen(): string {
		return this.#serializer.serialize();
	}

	/** Closing cancels application input immediately. Only an explicit native decision can force-stop omp. */
	stop(): Promise<void> {
		this.#closing = true;
		this.#stopping ??= this.#stop().finally(() => { this.#stopping = null; });
		return this.#stopping;
	}

	async #stop(): Promise<void> {
		const pty = this.#pty;
		if (!pty || this.state.phase === "exited") return;
		// A submission may be awaiting a native startup decision. It rejects when that decision
		// finishes because closing was set synchronously, before this drain.
		if (!(await this.#drainApplicationInput(pty))) return;
		if (this.#nativeBridge?.snapshot.shutdown === "teardown") this.#shutdownProgress("teardown");
		let prepared = true;
		if (this.#shutdownStage === "requested" || this.#shutdownStage === "acknowledged") {
			try { await this.#resolveWorktreeQuestion(); }
			catch (error) {
				prepared = false;
				this.#update({ error: error instanceof Error ? error.message : String(error) });
			}
		}
		if (this.#pty !== pty) return;
		if (prepared && this.#shutdownStage === "requested") {
			if (this.state.tui && this.state.tui.overlays > 0) {
				await this.#debug?.keys("escape").catch(() => undefined);
				await sleep(150);
			}
			pty.write("\x1b[200~/exit\x1b[201~\r");
		}
		this.#shutdownProgressAt = Date.now();
		while (this.#pty === pty) {
			if (this.#nativeBridge?.snapshot.shutdown === "teardown") this.#shutdownProgress("teardown");
			this.#rememberShutdownProgress();
			if (this.#confirmingWorktree) this.#shutdownProgressAt = Date.now();
			const deadline = this.#shutdownStage === "requested" ? STOP_GRACE_MS : STOP_PROGRESS_MS;
			if (!this.#confirmingWorktree && Date.now() - this.#shutdownProgressAt >= deadline) {
				// Neither room closure nor a timeout proves worktree removal is finished. There
				// is deliberately no automatic kill, including after the terminal UI stops.
				if (await this.#offerShutdownEscape(pty)) return;
				this.#shutdownProgressAt = Date.now();
			}
			await Promise.race([this.#exited, sleep(100)]);
		}
	}

	async #drainApplicationInput(pty: IPty): Promise<boolean> {
		const tail = this.#inputTail;
		let drained = false;
		void tail.then(() => { drained = true; });
		await Promise.resolve();
		let progressAt = Date.now();
		while (!drained && this.#pty === pty) {
			if (this.#confirmingWorktree) progressAt = Date.now();
			if (!this.#confirmingWorktree && Date.now() - progressAt >= STOP_GRACE_MS) {
				if (await this.#offerShutdownEscape(pty)) return false;
				progressAt = Date.now();
			}
			await Promise.race([tail, this.#exited, sleep(100)]);
		}
		return drained && this.#pty === pty;
	}

	/** Returns true only after natural exit or the user's explicit, confirmed force-stop. */
	async #offerShutdownEscape(pty: IPty): Promise<boolean> {
		this.#shutdownPrompt = true;
		let response: number;
		try {
			({ response } = await this.#messageBox({
				type: "warning",
				message: hostLabels.shutdownTitle,
				detail: `${this.state.cwd}\n\n${hostLabels.shutdownStages[this.#shutdownStage]}`,
				buttons: [hostLabels.keepWaiting, hostLabels.stopNow],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			}));
		} finally { this.#shutdownPrompt = false; }
		if (this.#pty !== pty) return true;
		if (response !== 1) return false;
		pty.kill();
		const exited = await Promise.race([this.#exited.then(() => true), sleep(STOP_GRACE_MS, false)]);
		if (!exited) throw new Error(hostLabels.stopUnconfirmed);
		return true;
	}

	async #messageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
		const abort = new AbortController();
		let settled = false;
		const exited = this.#exited.then(() => {
			if (!settled) abort.abort();
			return { response: options.cancelId ?? 0, checkboxChecked: false };
		});
		// A parent keeps macOS message boxes asynchronous and allows exit to dismiss them.
		const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
		try {
			const pending = parent
				? dialog.showMessageBox(parent, { ...options, signal: abort.signal })
				: dialog.showMessageBox({ ...options, signal: abort.signal });
			return await Promise.race([pending, exited]);
		} finally {
			settled = true;
			abort.abort();
		}
	}

	#shutdownProgress(stage: ShutdownStage): void {
		const order: ShutdownStage[] = ["requested", "acknowledged", "teardown", "cleanup"];
		if (order.indexOf(stage) <= order.indexOf(this.#shutdownStage)) return;
		this.#shutdownStage = stage;
		this.#shutdownProgressAt = Date.now();
	}

	#rememberShutdownProgress(): void {
		if (this.#shutdownStage !== "requested") return;
		const buffer = this.#screen.buffer.active;
		for (let index = buffer.baseY; index < buffer.length; index++) {
			if (/^\s*(?:Still closing|Closing session)…/.test(buffer.getLine(index)?.translateToString(true) ?? "")) {
				this.#shutdownProgress("acknowledged");
				return;
			}
		}
	}

	async #resolveLink(roomId: string): Promise<void> {
		this.#roomId = roomId;
		const search = {
			pid: this.#pty?.pid,
			spawnedAt: this.#spawnedAt,
			relayUrl: this.#relay.url,
			roomId,
			ruledOut: new Set<string>(),
			linkFor: async (instanceId: string) => CollabLink.parse(await runOmpJson(["collab", "link", instanceId, "--json"])).url,
		};
		for (let attempt = 0; attempt < LINK_RETRY_LIMIT && this.#roomId === roomId; attempt++) {
			try {
				const { hosts } = CollabHosts.parse(await runOmpJson(["collab", "list", "--json"]));
				const found = await findRoomHost(hosts, search);
				if (found) {
					const { host, link } = found;
					if (this.#roomId !== roomId) return;
					const sessionFile = host.sessionId ? await findSessionFile(host.sessionId) : null;
					if (this.#roomId !== roomId) return;
					this.#update({
						phase: "live",
						link,
						generation: this.state.generation + 1,
						sessionId: host.sessionId,
						cwd: host.cwd,
						sessionFile: sessionFile ?? this.state.sessionFile,
						error: null,
					});
					return;
				}
			} catch {}
			await sleep(LINK_RETRY_MS);
		}
		if (this.#roomId === roomId) this.#update({ error: "Could not connect to omp's live session." });
	}

	#onRoomClosed(roomId: string): void {
		if (this.#roomId !== roomId) return;
		this.#roomId = null;
		this.#captureStartupNotices = true;
		if (this.state.phase !== "exited") this.#update({ phase: "restarting", link: null });
	}

	async #pollFocus(): Promise<void> {
		if (!this.#debug || this.state.phase === "exited" || this.#polling) return;
		this.#polling = true;
		try {
			const location = this.#nativeBridge?.snapshot.location;
			if (location) {
				// omp allocates a path before its first durable write. Empty launches must not become
				// restorable tabs merely because the extension knows that future filename.
				const sessionFile = location.sessionFile && await stat(location.sessionFile).then(info => info.isFile(), () => false) ? location.sessionFile : null;
				if (location.cwd !== this.state.cwd || sessionFile !== this.state.sessionFile || location.sessionId !== this.state.sessionId) {
					this.#update({ cwd: location.cwd, sessionFile, sessionId: location.sessionId });
				}
			}
			const tui = await this.#debug.info().catch(() => null);
			if (tui?.focused || (tui?.overlays ?? 0) > 0) this.#finishStartup();
			if (JSON.stringify(tui) !== JSON.stringify(this.state.tui)) this.#update({ tui });
			if (tui && !this.#confirmingWorktree && !this.#shutdownPrompt) await this.#resolveWorktreeQuestion();
			const historyFile = this.#nativeBridge?.snapshot.historyDbPath;
			if (this.state.sessionId && historyFile) {
				const identity = `${historyFile}\0${this.state.sessionId}`;
				const startup = (this.state.notices ?? []).filter(notice => notice.kind === "startup");
				if (this.#recapIdentity !== identity) {
					this.#recapIdentity = identity;
					this.#update({ notices: startup });
				}
				const recaps = readSessionRecaps(historyFile, this.state.sessionId);
				// A locked or temporarily unreadable store leaves the last successful journal visible.
				if (recaps !== null) {
					const notices = [...startup, ...recaps];
					if (JSON.stringify(notices) !== JSON.stringify(this.state.notices)) this.#update({ notices });
				}
			}
		} catch (error) {
			this.#update({ error: error instanceof Error ? error.message : String(error) });
		} finally { this.#polling = false; }
	}

	async #onExit(exitCode: number): Promise<void> {
		// xterm parses writes asynchronously; flush the final error before disposing the screen.
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#screen.write("", resolve);
		await promise;
		this.#roomId = null;
		if (!this.#startupComplete) this.#rememberStartupDiagnostic();
		const exitReason = exitCode !== 0 && !this.#startupComplete ? this.#lastExitReason : null;
		const resumeFileMissing = exitReason !== null && this.#startupResumeFileMissing;
		const restoreAvailable = exitCode !== 0 && !resumeFileMissing && await crashedWithoutExit(this.state.sessionFile, this.#runStartedAt);
		this.#pty = null;
		this.#update({ phase: "exited", exitCode, exitReason, resumeFileMissing, restoreAvailable, programStatus: null, link: null, tui: null });
		this.#markExited();
		await this.#cleanup();
	}

	#finishStartup(): void {
		this.#startupComplete = true;
		this.#lastExitReason = null;
		this.#startupResumeFileMissing = false;
	}

	#rememberStartupNotices(): void {
		const notices = [...(this.state.notices ?? [])];
		let changed = false;
		for (const text of startupModelWarnings(this.#transcriptLines())) {
			const existing = notices.findIndex(notice => notice.kind === "startup" && (notice.text.startsWith(text) || text.startsWith(notice.text)));
			if (existing < 0) {
				notices.push({ id: `startup:${this.id}:${notices.length}`, kind: "startup", text, timestamp: Date.now() });
				changed = true;
			} else if (text.length > notices[existing]!.text.length) {
				notices[existing] = { ...notices[existing]!, text };
				changed = true;
			}
		}
		if (changed) this.#update({ notices });
	}

	#transcriptLines(): string[] {
		const buffer = this.#screen.buffer.active;
		const lines: string[] = [];
		let wrapped: string | null = null;
		for (let index = 0; index < buffer.length; index++) {
			const line = buffer.getLine(index);
			if (!line) continue;
			if (!line.isWrapped && wrapped !== null) { lines.push(wrapped); wrapped = ""; }
			const text = line.translateToString(true);
			if (/^\s*[╭┌┏][─━]/.test(text)) break;
			wrapped = ((wrapped ?? "") + text).slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS + 1);
		}
		if (wrapped !== null) lines.push(wrapped);
		return lines;
	}

	/** Keep recognized diagnostics above the editor; never copy arbitrary startup output or drafts. */
	#rememberStartupDiagnostic(): void {
		const buffer = this.#screen.buffer.active;
		const lines: string[] = [];
		let wrapped = "";
		for (let index = 0; index < buffer.length; index++) {
			const line = buffer.getLine(index);
			if (!line) continue;
			if (!line.isWrapped && wrapped) {
				lines.push(wrapped);
				wrapped = "";
			}
			const text = line.translateToString(true);
			// The pinned classic TUI editor begins here; everything below is editable or chrome.
			if (/^\s*[╭┌┏][─━]/.test(text)) break;
			wrapped = (wrapped + text).slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS + 1);
		}
		if (wrapped) lines.push(wrapped);
		const diagnostics = lines.map(line => line.trim()).filter(line => STARTUP_DIAGNOSTIC.test(line));
		if (!diagnostics.length) return;
		this.#startupResumeFileMissing = diagnostics.some(line => {
			const file = /^(?:Error:\s*)?Session file not found:\s*(.+)$/.exec(line)?.[1];
			return file !== undefined && file === this.#options.resumeFile;
		});
		const text = diagnostics.slice(-STARTUP_DIAGNOSTIC_MAX_LINES).join("\n");
		this.#lastExitReason =
			text.length > STARTUP_DIAGNOSTIC_MAX_CHARS ? `${text.slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS - 1)}…` : text;
	}

	async #cleanup(): Promise<void> {
		clearInterval(this.#focusTimer ?? undefined);
		this.#focusTimer = null;
		this.#debug?.close();
		this.#relay.stop();
		await this.#nativeBridge?.close();
		this.#nativeBridge = null;
		this.#screen.dispose();
		if (this.#privateDir) await rm(this.#privateDir, { recursive: true, force: true });
		this.#privateDir = null;
	}

	#update(patch: Partial<HostState>): void {
		this.state = { ...this.state, ...patch };
		broadcast("host:state", this.state);
	}
}

const hosts = new Map<string, SessionHost>();

// A new chat's session file appears after omp writes its first entry; keep host state current.
onSessionsChanged(() => {
	for (const host of hosts.values()) void host.refreshSessionFile();
});

export async function startHost(options: HostStartOptions): Promise<HostState> {
	const host = new SessionHost(options);
	hosts.set(host.id, host);
	await host.start();
	return host.state;
}

export function getHost(hostId: string): SessionHost {
	const host = hosts.get(hostId);
	if (!host) throw new Error(`no omp session ${hostId}`);
	return host;
}

export function listHosts(): HostState[] {
	return [...hosts.values()].map(host => host.state);
}

export async function stopHost(hostId: string): Promise<void> {
	const host = hosts.get(hostId);
	if (!host) return;
	await host.stop();
	hosts.delete(hostId);
}

export async function stopAllHosts(): Promise<void> {
	await Promise.all([...hosts.keys()].map(stopHost));
}
