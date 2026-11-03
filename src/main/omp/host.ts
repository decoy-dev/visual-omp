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
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { type IPty, spawn } from "node-pty";
import { stringify } from "yaml";
import { z } from "zod";
import type { HostStartOptions, HostState, HostStopMode, PromptSubmissionFailure, TuiFocus } from "@shared/ipc";
import { TspRendererEvent, TSP_PREVIEW_UNAVAILABLE, type TspEditorRestore, type TspHostSnapshot } from "@shared/tsp-host";
import { composer, openOverlay, screenSurface, walkNodes } from "@shared/tsp/view-state";
import { TSP_ROLES, TSP_STATUS } from "@shared/tsp/roles";
import { hookQuestions, QuestionArbitrator } from "@shared/tsp/question-match";
import { nodeHasLeft, TspHookAnswer } from "@shared/tsp/dialogs";
import { assertTreeEntry, treeSelector } from "@shared/tsp/tree-navigation";
import { TspAdvisorAction } from "@shared/tsp/advisor";
import { composerFacts as readComposerFacts } from "./tsp/composer";
import { BrowserWindow, dialog, nativeTheme, systemPreferences, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";
import hostLabels from "../../shared/i18n/en/host.json";
import { crashedWithoutExit, parseProgramStatus, readSessionRecaps, startupModelWarnings, worktreeConfirmation } from "./host-observations";
import { createNativeBridge, type NativeBridge } from "./native-bridge";
import { ptyEnv, userEnv } from "../env";
import { broadcast } from "../ipc";
import { getPrefs } from "../prefs";
import { runOmpJson } from "./cli";
import { ompPath } from "./locate";
import { ompStartError } from "./refused";
import { LoopbackRelay } from "./relay";
import { findRoomHost } from "./room-host";
import { findSessionFile, onSessionsChanged } from "./sessions";
import { TuiDebugClient, type TuiPaint } from "./tui-debug";
import { attachClassicImages, classicImageFailure } from "./classic-image-paste";
import { TspInputStateError, TspSession, type TspEditorTarget } from "./tsp/session";
import { TspStream } from "./tsp/stream";
import { worktreeExitConfirmation, type WorktreeExitConfirmation } from "./tsp/worktree";
import { StartupDiagnosticCapture, startupDiagnostic, STARTUP_DIAGNOSTIC_MAX_CHARS } from "./startup-diagnostics";
import type { BtwInputScope, BtwState, BtwTopicRef } from "../../shared/contracts/btw";
import { BtwDriver, type BtwOperation } from "./tsp/btw-driver";
import { BtwHistoryState } from "./tsp/btw-state";
import { releaseWindowsConpty } from "./windows-pty-cleanup";
import { classicPromptRejections, semanticPromptRejections, type PromptRejection } from "./prompt-rejection";
import { expandedPromptTextMatches } from "../../shared/prompt-input";

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
const TSP_NEGOTIATION_MS = 10_000;
const STOP_GRACE_MS = 4000;
const STOP_PROGRESS_MS = 15_000;
type ShutdownStage = "requested" | "acknowledged" | "teardown" | "cleanup";

export interface EditorInputTransaction {
	assertOpen(): void;
	/** Uses the held input lock; calling SessionHost.keys() inside a transaction would re-enter it. */
	keys(keys: string, expectedGhost?: string): Promise<void>;
	edit(from: number, to: number, text: string, cursor: number): Promise<void>;
}

interface EditorRestoreCapture { view: TspEditorRestore; generation: number; target: TspEditorTarget }
interface PromptSubmission {
	id: string;
	text: string;
	generation: number;
	sessionId: string;
	epoch?: number;
	target?: TspEditorTarget;
	diagnostics: ReadonlySet<string>;
	revision: number;
	expected: readonly string[];
	images: number;
	written: boolean;
	inputObserved: boolean;
	inputBeforeWrite: boolean;
	emptyResume: boolean;
	failure?: PromptSubmissionFailure;
}

export class SessionHost {
	readonly id = randomUUID();
	readonly #options: HostStartOptions;
	readonly #relay = new LoopbackRelay();
	readonly #screen: Terminal;
	readonly #serializer = new SerializeAddon();
	#pty: IPty | null = null;
	#debug: TuiDebugClient | null = null;
	readonly #screenReadAttempts: { readonly source: string }[] = [];
	#loggedUnreadableStatus = false;
	#loggedSlowWorktreeRead = false;
	#privateDir: string | null = null;
	#roomId: string | null = null;
	#hadCollabRoom = false;
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
	#stopWithoutEditor = false;
	#inputTail: Promise<void> = Promise.resolve();
	#editorTransferBlocked: string | null = null;
	#shutdownStage: ShutdownStage = "requested";
	#shutdownProgressAt = 0;
	#shutdownPrompt = false;
	#nativeBridge: NativeBridge | null = null;
	#tsp: TspSession | null = null;
	#tspStream: TspStream | null = null;
	#tspStartup: StartupDiagnosticCapture | null = null;
	#tspRevision = 0;
	#tspSurfaceGenerations = new Map<string, number>();
	#tspFailure: string | null = null;
	#tspHandshakeTimer: NodeJS.Timeout | null = null;
	#tspExitSurface: string | null = null;
	#tspShutdownScope: { generation: number; epoch: number } | null = null;
	#tspFirstBytes = Buffer.alloc(0);
	#tspQuestions = new QuestionArbitrator();
	#editorRestore: EditorRestoreCapture | null = null;
	#tspPastesPending = 0;
	#btwHistory: BtwHistoryState | null = null;
	#promptSubmissions = new Map<string, PromptSubmission>();
	#promptRevision = 0;
	#promptCheckQueued = false;
	#promptRecheck = false;
	#classicStagedDraft: string | null = null;
	#classicStagedImages = 0;
	#classicImageSymbol: string | undefined;
	#tspAppearanceChanged = (): void => {
		if (!this.#tsp || this.state.phase === "exited") return;
		const { dark, reduceMotion } = this.#tspAppearance();
		void Promise.all([this.#tsp.theme(dark), this.#tsp.motion(reduceMotion)]).catch(error => this.#update({ error: String(error) }));
	};
	#terminalDecoder = new StringDecoder("utf8");
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
			// Read only in main at launch. Existing hosts never change renderer mid-session.
			const useTsp = process.env.VOMP_TSP === "1";
			const [bin, env] = await Promise.all([ompPath(), userEnv()]);
			await this.#relay.start();
			this.#relay.events = {
				onHostOpen: roomId => {
					// A second relay room must never replace the session this host already owns.
					// Legitimate rotations close the previous room before opening its successor.
					if (this.#roomId !== null) return;
					this.#hadCollabRoom = true;
					if (this.#tsp) this.#publishTsp();
					this.#runStartedAt = Date.now();
					this.#finishStartup();
					void this.#resolveLink(roomId);
				},
				onHostClose: roomId => this.#onRoomClosed(roomId),
			};
			// Owner-only directory: the debug socket accepts keystrokes, so nobody else may reach it.
			this.#privateDir = await mkdtemp(join(tmpdir(), "vomp-"));
			this.#nativeBridge = await createNativeBridge(this.id, this.#privateDir);
			this.#nativeBridge.onPromptInput = id => {
				const submission = this.#promptSubmissions.get(id);
				if (!submission) return;
				if (submission.written) submission.inputObserved = true;
				else submission.inputBeforeWrite = true;
				this.#queuePromptRejectionCheck();
			};
			const overlay = join(this.#privateDir, "overlay.yml");
			await writeFile(overlay, stringify(this.#overlayConfig(useTsp)), { mode: 0o600 });
			const debugPath =
				process.platform === "win32" ? `\\\\.\\pipe\\visual-omp-${this.id}` : join(this.#privateDir, "tui.sock");
			const args = ["--config", overlay, "--extension", this.#nativeBridge.extensionPath];
			if (this.#options.resumeFile) args.push(this.#options.restore ? "--restore" : "--resume", this.#options.resumeFile);
			args.push(...(this.#options.extraArgs ?? []));
			const childEnv: NodeJS.ProcessEnv = { ...env, OMP_SKIP_SETUP: "1", OMP_TUI_DEBUG: debugPath };
			childEnv.VOMP_NATIVE_BRIDGE = this.#nativeBridge.url;
			if (useTsp) {
				this.#tspStartup = new StartupDiagnosticCapture();
				childEnv.TERM_PROGRAM = "tern";
				delete childEnv.PI_TUI_NATIVE;
				const appearance = this.#tspAppearance();
				this.#tsp = new TspSession({
					write: data => this.#writeInput(data),
					onUpdate: (reason, surface) => {
						if (reason === "hello") {
							this.#tspSurfaceGenerations.clear();
							this.#tspFailure = null;
							this.#update({ tspFailed: false });
							this.#armTspHandshake(5000, true);
						}
						if (reason === "open") {
							this.#finishStartup();
							clearTimeout(this.#tspHandshakeTimer ?? undefined);
							this.#tspHandshakeTimer = null;
						}
						if (reason === "close" && !this.#closing && !this.#tspFailure && !this.#tsp!.snapshot().surfaces.some(surface => !surface.closed)) this.#armTspHandshake(5000, true);
						if (this.#closing && ((reason === "close" && surface === this.#tspExitSurface) || this.#tspClosingNotice())) this.#shutdownProgress("acknowledged");
						if (reason === "frame" && surface && (this.state.phase === "live" || !this.#hadCollabRoom)) this.#tspSurfaceGenerations.set(surface, this.state.generation);
						this.#publishTsp();
						this.#promptRevision++;
						this.#queuePromptRejectionCheck();
					},
					onError: error => {
						if (this.state.phase === "exited") return;
						this.#tspFailure = `TSP preview: ${error.message}. Relaunch without VOMP_TSP to use the classic controls.`;
						this.#publishTsp();
					},
					cols: this.#screen.cols,
					...appearance,
				});
				this.#tspStream = new TspStream({
					onMessage: message => this.#tsp!.receive(message),
					onData: data => this.#terminalOutput(data),
				});
				// Headless xterm answers ordinary terminal probes only after the hello is queued.
				this.#screen.onData(data => this.#tsp!.terminalReply(data));
				this.#update({ transport: "tsp" });
				nativeTheme.on("updated", this.#tspAppearanceChanged);
			} else {
				childEnv.PI_TUI_NATIVE = "0";
				delete childEnv.TERM_PROGRAM;
			}
			try {
				this.#spawnedAt = Date.now();
				this.#runStartedAt = this.#spawnedAt;
				this.#pty = spawn(bin, args, {
					name: "xterm-256color",
					cols: this.#screen.cols,
					rows: this.#screen.rows,
					cwd: this.#options.cwd,
					env: ptyEnv(childEnv),
					...(useTsp ? { encoding: null } : {}),
					...(useTsp && process.platform === "win32" ? { useConptyDll: true } : {}),
				});
			} catch (error) {
				throw await ompStartError(error, bin);
			}
			this.#debug = new TuiDebugClient(debugPath, operation => this.#assertClassicRead(`debug:${operation}`));
			this.#pty.onData(data => {
				if (this.#tspStream) {
					const bytes = typeof data === "string" ? Buffer.from(data) : data;
					if (this.#tspFirstBytes.length < 2048) this.#tspFirstBytes = Buffer.concat([this.#tspFirstBytes, bytes.subarray(0, 2048 - this.#tspFirstBytes.length)]);
					this.#tspStream.push(bytes);
					if (!this.#tspHandshakeTimer && !this.#tsp!.snapshot().negotiated && !this.#tspFailure) this.#armTspHandshake(Math.max(0, TSP_NEGOTIATION_MS - (Date.now() - this.#spawnedAt)), false);
				} else this.#terminalOutput(data);
			});
			this.#pty.onExit(({ exitCode }) => void this.#onExit(exitCode));
			if (this.#tsp) this.#armTspHandshake(TSP_NEGOTIATION_MS, false);
			this.#update({ phase: "connecting", pid: this.#pty.pid });
			this.#focusTimer = setInterval(() => void this.#pollFocus(), FOCUS_POLL_MS);
		} catch (error) {
			this.#update({ phase: "exited", error: error instanceof Error ? error.message : String(error) });
			await this.#cleanup();
		}
	}

	/** Settings layered over the user's config for this process only. */
	#overlayConfig(useTsp: boolean): Record<string, unknown> {
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
			// Classic screen readers need a stable editor frame as well as stable status segments.
			...(!useTsp ? { composer: { shape: "box" } } : {}),
			statusLine: {
				preset: "default",
				separator: "powerline",
				compactThinkingLevel: false,
				segmentOptions: { model: { showThinkingLevel: true } },
			},
		};
	}

	/** Every PTY input write is atomic, including bracketed paste and its submit key. */
	#writeInput(data: string): void {
		this.#pty?.write(data);
	}

	#terminalOutput(data: string | Uint8Array): void {
		if (this.#tspStartup && !this.#startupComplete) this.#tspStartup.push(typeof data === "string" ? Buffer.from(data) : data);
		this.#screen.write(data, () => {
			// TSP startup failures use raw bytes; post-surface notices use semantic nodes.
			if (!this.#tsp) {
				if (!this.#startupComplete) this.#rememberStartupDiagnostic();
				if (this.#captureStartupNotices) this.#rememberStartupNotices();
				if (this.#closing) this.#rememberShutdownProgress();
				this.#promptRevision++;
				this.#queuePromptRejectionCheck();
			}
		});
		// Decode a copy for legacy observers; xterm receives the original bytes, including split UTF-8.
		broadcast("host:data", { hostId: this.id, data: typeof data === "string" ? data : this.#terminalDecoder.write(Buffer.from(data)) });
	}

	#tspAppearance(): { dark: boolean; reduceMotion: boolean } {
		const prefs = getPrefs();
		return {
			dark: prefs.theme === "system" ? nativeTheme.shouldUseDarkColors : prefs.theme === "dark",
			reduceMotion: prefs.reducedMotion === "system" ? systemPreferences.getAnimationSettings().prefersReducedMotion : prefs.reducedMotion === "on",
		};
	}

	#armTspHandshake(delay: number, waitingForSurface: boolean): void {
		clearTimeout(this.#tspHandshakeTimer ?? undefined);
		this.#tspHandshakeTimer = setTimeout(() => {
			this.#tspHandshakeTimer = null;
			if (this.state.phase === "exited") return;
			if (waitingForSurface ? this.#tsp!.snapshot().surfaces.some(surface => !surface.closed) : this.#tsp!.snapshot().negotiated || this.#tspFirstBytes.length === 0) return;
			this.#tspFailure = "omp did not start its semantic screen";
			console.warn("[visual-omp] omp did not start its semantic screen. First PTY bytes (base64, at most 2048 bytes):", this.#tspFirstBytes.toString("base64"));
			this.#update({ tspFailed: true });
			this.#publishTsp();
		}, delay);
		this.#tspHandshakeTimer.unref();
	}

	#tspClosingNotice(): boolean {
		return this.#tsp?.snapshot().surfaces.some(surface => [...walkNodes(surface.document)].some(node =>
			node.k === "toast" && node.p?.role === TSP_ROLES.toastStatus && typeof node.p.text === "string" && node.p.text.startsWith(TSP_STATUS.closing))) ?? false;
	}

	tspQuestions(input: unknown): void {
		if (!this.#tsp) return;
		const scope = { hostId: this.id, generation: this.state.generation, epoch: this.#tsp.snapshot().epoch };
		if (this.#tspQuestions.update(scope, input)) this.#publishTsp();
	}

	composerFacts() {
		return readComposerFacts(this.#tsp?.snapshot().surfaces.filter(surface => this.#tspSurfaceGenerations.get(surface.open.id) === this.state.generation) ?? []);
	}

	tspSnapshot(): TspHostSnapshot | null {
		if (!this.#tsp) return null;
		const protocol = this.#tsp.snapshot();
		const surfaces = protocol.surfaces.map(surface => ({ ...surface, documentGeneration: this.#tspSurfaceGenerations.get(surface.open.id) ?? null }));
		const current = surfaces.some(surface => !surface.closed && surface.documentGeneration === this.state.generation);
		// Non-hook startup menus can precede the first collab room. Once any room
		// opens, link resolution and later rotations keep the normal authority gate.
		const lifecycle = this.state.phase === "exited" ? "exited" : this.#tspFailure ? "failed" : current && (this.state.phase === "live" || !this.#hadCollabRoom) ? "live" : "transitioning";
		const reason = this.#closing ? "This chat is closing." : this.#tspFailure ?? (lifecycle !== "live" ? "Waiting for omp to open its semantic screen." : this.#editorTransferBlocked);
		const questionMatches = this.#tspQuestions.matches(
			{ hostId: this.id, generation: this.state.generation, epoch: protocol.epoch },
			hookQuestions(surfaces, this.state.generation), hookQuestions(protocol.surfaces, this.state.generation),
		);
		const overlay = openOverlay(surfaces, true);
		const matchedQuestion = overlay && questionMatches.find(match => match.surfaceId === overlay.surface.open.id && match.nodeId === overlay.node.id && match.status === "matched");
		const availability = reason ? { available: false, reason }
			: matchedQuestion && !screenSurface(surfaces) ? { available: false, reason: hostLabels.matchedQuestion, reasonCode: "matched-question" as const, questionReqId: matchedQuestion.reqId }
			: this.#tsp.availability(surface => this.#tspSurfaceGenerations.get(surface) === this.state.generation);
		return { hostId: this.id, generation: this.state.generation, revision: this.#tspRevision, epoch: protocol.epoch, closing: this.#closing, availability, composer: this.composerFacts(), editorRestore: this.#editorRestore?.view ?? null, negotiated: protocol.negotiated, lifecycle, documentGeneration: current ? this.state.generation : null, failure: this.#tspFailure, surfaces, questionMatches };
	}

	async btwList(): Promise<BtwState> {
		const snapshot = this.tspSnapshot();
		if (!snapshot) throw new Error("Side questions use the omp terminal in classic chats.");
		this.#btwHistory ??= new BtwHistoryState(state => broadcast("btw:changed", state));
		this.#btwHistory.update(snapshot, this.state.sessionFile, this.#runStartedAt);
		return this.#btwHistory.refresh();
	}

	btwAction(operation: BtwOperation, text = "", topic?: BtwTopicRef | null, scope?: BtwInputScope): Promise<void> {
		const generation = scope?.generation ?? this.state.generation;
		const epoch = scope?.epoch ?? this.#tsp?.snapshot().epoch;
		return this.#applicationInput(async () => {
			const assertCurrent = () => {
				this.#assertTspInput(generation);
				if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("The semantic screen restarted before the side-question action.");
				if (this.#editorTransferBlocked) throw new Error(this.#editorTransferBlocked);
			};
			assertCurrent();
			await this.btwList();
			const driver = new BtwDriver({
				session: this.#tsp!, assertCurrent,
				snapshot: () => this.tspSnapshot()!,
				state: () => {
					const state = this.#btwHistory?.state;
					if (!state) throw new Error("The side-question history is unavailable.");
					return state;
				},
			});
			await driver.run(operation, text, topic ? this.#btwHistory!.resolveTopicRef(topic) : topic);
		});
	}

	#publishTsp(): void {
		this.#tspRevision++;
		const snapshot = this.tspSnapshot();
		if (snapshot) {
			this.state = { ...this.state, tspFailed: snapshot.lifecycle === "failed", tspAvailability: snapshot.availability, tspComposer: snapshot.composer, tspEpoch: snapshot.epoch, tspEditorRestore: snapshot.editorRestore };
			broadcast("host:state", this.state);
		}
		if (snapshot) broadcast("host:tsp-update", snapshot);
		if (snapshot) {
			this.#btwHistory ??= new BtwHistoryState(state => broadcast("btw:changed", state));
			this.#btwHistory.update(snapshot, this.state.sessionFile, this.#runStartedAt);
		}
	}

	#assertTspInput(generation: number): void {
		this.#assertApplicationInput(true);
		if (!this.#tsp || generation !== this.state.generation || this.tspSnapshot()?.lifecycle !== "live") throw new Error("TSP preview: The session changed or its semantic UI is not ready.");
	}

	/** Restart may dismiss menus, but never confirms their selected item or invents an action. */
	prepareRestart(generation: number, epoch?: number): Promise<boolean> {
		return this.#applicationInput(async () => {
			const assertCurrent = (): void => {
				this.#assertTspInput(generation);
				if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
			};
			this.#assertTspInput(generation);
			if (epoch === undefined) return false;
			assertCurrent();
			return this.#tsp!.prepareRestart(assertCurrent, surface => this.#tspSurfaceGenerations.get(surface) === generation);
		});
	}
	tspEvent(generation: number, input: unknown, epoch = this.#tsp?.snapshot().epoch): Promise<void> {
		const parsed = TspRendererEvent.safeParse(input);
		if (!parsed.success) return Promise.reject(new Error("TSP preview: Invalid or main-owned renderer event."));
		const event = parsed.data;
		const assertCurrent = (): void => {
			this.#assertTspInput(generation);
			if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
			if (["send", "edit", "undo"].includes(event.ev) && this.#editorTransferBlocked) throw new Error(`TSP preview: ${this.#editorTransferBlocked}`);
			if (this.#tspSurfaceGenerations.get(event.sf) !== generation) throw new Error("TSP preview: The target surface belongs to an earlier session.");
			if (event.ev === "action" && this.composerFacts().blockedBy === "approval") throw new Error("TSP preview: Answer the approval before changing omp settings.");
		};
		return this.#applicationInput(async () => {
			assertCurrent();
			await this.#tsp!.send(event, assertCurrent);
		});
	}
	/** Bind advisor file actions to the prepared scope at both serialized input boundaries. */
	tspAdvisor(generation: number, input: unknown, epoch: number): Promise<void> {
		const parsed = TspAdvisorAction.safeParse(input);
		if (!parsed.success) return Promise.reject(new Error("TSP preview: Invalid advisor action."));
		const action = parsed.data;
		const assertCurrent = (): void => {
			this.#assertTspInput(generation);
			if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
			if (this.#tspSurfaceGenerations.get(action.sf) !== generation) throw new Error("TSP preview: The target surface belongs to an earlier session.");
			if (this.#editorTransferBlocked) throw new Error(`TSP preview: ${this.#editorTransferBlocked}`);
			if (this.composerFacts().blockedBy === "approval") throw new Error("Answer the approval before applying advisor configuration.");
		};
		return this.#applicationInput(async () => {
			assertCurrent();
			await this.#tsp!.advisorAction(action, assertCurrent);
		});
	}

	/** Navigation never predicts row positions, and the protocol writer repeats every target check. */
	tspTreeActivate(generation: number, epoch: number, surfaceId: string, selectorId: string, entryId: string): Promise<void> {
		const assertCurrent = (): void => {
			this.#assertTspInput(generation);
			const snapshot = this.tspSnapshot()!;
			if (epoch !== snapshot.epoch) throw new Error("TSP preview: The semantic screen restarted.");
			if (this.#editorTransferBlocked) throw new Error(`TSP preview: ${this.#editorTransferBlocked}`);
			if (this.#tspSurfaceGenerations.get(surfaceId) !== generation) throw new Error("TSP preview: The target surface belongs to an earlier session.");
			const target = treeSelector(snapshot.surfaces);
			if (!target || target.surface.open.id !== surfaceId || target.node.id !== selectorId) throw new Error("TSP preview: The session tree selector changed. Open the tree again.");
			assertTreeEntry(target.node, entryId);
		};
		return this.#applicationInput(async () => {
			assertCurrent();
			await this.#tsp!.send({ ev: "activate", sf: surfaceId, id: selectorId, item: entryId }, assertCurrent);
		});
	}

	/** Local hook answers are arbitrated again inside both serialized input boundaries. */
	tspAnswer(generation: number, input: unknown, epoch: number): Promise<void> {
		const parsed = TspHookAnswer.safeParse(input);
		if (!parsed.success) return Promise.reject(new Error("TSP preview: Invalid question answer."));
		const answer = parsed.data;
		return this.#applicationInput(async () => {
			this.#assertTspInput(generation);
			await this.#tsp!.answerHook(answer, (surfaceId, nodeId) => {
				this.#assertTspInput(generation);
				const snapshot = this.tspSnapshot()!;
				if (epoch !== snapshot.epoch) throw new Error("TSP preview: The semantic screen restarted.");
				if (this.#tspSurfaceGenerations.get(surfaceId) !== generation) throw new Error("TSP preview: The target surface belongs to an earlier session.");
				if (this.#editorTransferBlocked) throw new Error(`TSP preview: ${this.#editorTransferBlocked}`);
				this.#tspQuestions.answer({ hostId: this.id, generation, epoch }, hookQuestions(snapshot.surfaces, generation), surfaceId, nodeId);
			});
			this.#publishTsp();
		});
	}

	/** Raw bytes to the TUI (terminal sheet keystrokes). */
	write(data: string): void | Promise<void> {
		if (this.#tsp) return Promise.reject(new Error(TSP_PREVIEW_UNAVAILABLE));
		this.#captureStartupNotices = false;
		this.#finishStartup();
		this.#writeInput(data);
	}

	/**
	 * Type `text` as one bracketed paste and submit it in the same write, so multi-line text never
	 * submits early and a large paste becomes an attachment chip instead of a menu.
	 * `steer` (Enter) interrupts a running turn at the next safe point; `followUp` (Ctrl+Q) waits for the yield.
	 */
	submit(text: string, mode: "steer" | "followUp" = "steer", imagePaths?: string, submissionId?: string): Promise<void> {
		const generation = this.state.generation;
		const epoch = this.#tsp?.snapshot().epoch;
		if (this.#tsp) {
			let followUpSource: { target: TspEditorTarget; text: string } | null = null;
			if (mode === "followUp" && this.#tspPastesPending === 0) {
				try { followUpSource = { target: this.#tsp.pinEditor(surface => this.#tspSurfaceGenerations.get(surface) === generation), text: this.composerFacts().text }; }
				catch (error) { return Promise.reject(error); }
			}
			return this.#applicationInput(async () => {
				const assertCurrent = (): void => {
					this.#assertTspInput(generation);
					if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
					if (this.#editorTransferBlocked) throw new Error(`TSP preview: ${this.#editorTransferBlocked}`);
					if (followUpSource) {
						followUpSource.target.assertCurrent();
						if (this.composerFacts().text !== followUpSource.text) throw new Error("TSP preview: The editor changed before the follow-up could be written.");
					}
				};
				assertCurrent();
				if (text.startsWith("/") && this.composerFacts().blockedBy === "approval") throw new Error("TSP preview: Answer the approval before sending a command.");
				const allowed = (surface: string) => this.#tspSurfaceGenerations.get(surface) === generation;
				const submission = submissionId ? await this.#beginPromptSubmission(submissionId, text, imagePaths?.match(/(?:\\.|[^\s])+/g)?.length ?? 0) : null;
				try {
					assertCurrent();
					if (submission) submission.written = true;
					if (imagePaths) await this.#tsp!.submitImages(text, imagePaths, assertCurrent, allowed, prepared => {
						if (submission) submission.expected = [text, prepared];
					});
					else if (mode === "followUp") await this.#tsp!.followUp(text, assertCurrent, allowed);
					else await this.#tsp!.submit(text, assertCurrent, allowed);
				} catch (error) {
					if (submission) this.acknowledgeSubmission(submission.id);
					throw error;
				}
				this.#captureStartupNotices = false;
				this.#finishStartup();
			});
		}
		return this.#applicationInput(async () => {
			let submission: PromptSubmission | null = null;
			try {
				await this.#resolveWorktreeQuestion();
				this.#assertApplicationInput(true);
				if (this.#editorTransferBlocked) throw new Error(this.#editorTransferBlocked);
				if (this.state.generation !== generation) throw new Error("The chat changed before its message could be sent.");
				submission = submissionId ? await this.#beginPromptSubmission(submissionId, text, this.#classicStagedImages) : null;
				if (submission) {
					this.#assertPromptScope(submission);
					if (submission.inputBeforeWrite) throw new Error("omp received another input before this message could be written. Send it again.");
					submission.written = true;
				} else if (this.state.sessionId) await this.#assertClassicEditorDraft();
				this.#captureStartupNotices = false;
				this.#finishStartup();
				// An image-only submission is Enter, without the empty paste that reads the clipboard.
				this.#writeInput(`${text ? `\x1b[200~${text}\x1b[201~` : ""}${mode === "followUp" ? "\x11" : "\r"}`);
				this.#classicStagedDraft = null;
				this.#classicStagedImages = 0;
			} catch (error) {
				if (submission) this.acknowledgeSubmission(submission.id);
				if (this.#classicStagedDraft !== null && generation === this.state.generation) {
					this.#editorTransferBlocked = "Restart omp before sending more text after its attached input could not be submitted.";
					this.#stopWithoutEditor = true;
					throw new Error(`Image submission needs recovery. ${error instanceof Error ? error.message : String(error)}`);
				}
				throw error;
			}
		});
	}

	/** Positive collab evidence and retained rejection rows acknowledge only their own submission. */
	acknowledgeSubmission(id: string): void {
		if (!this.#promptSubmissions.delete(id)) return;
		this.#nativeBridge?.forgetPrompt(id);
		this.#publishPromptFailures();
		this.#queuePromptRejectionCheck();
	}

	#publishPromptFailures(): void {
		this.#update({ promptFailures: [...this.#promptSubmissions.values()].flatMap(submission => submission.failure ? [submission.failure] : []) });
	}

	#promptDiagnostics(): PromptRejection[] {
		if (this.#tsp) return semanticPromptRejections(this.#tsp.snapshot().surfaces.filter(surface => this.#tspSurfaceGenerations.get(surface.open.id) === this.state.generation));
		this.#assertClassicRead("prompt:rejection");
		const buffer = this.#screen.buffer.active;
		const lines: string[] = [];
		for (let index = buffer.baseY; index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
		let images = 0;
		for (const submission of this.#promptSubmissions.values()) if (submission.written && submission.inputObserved && !submission.failure) images = Math.max(images, submission.images);
		return classicPromptRejections(lines, images > 0 && this.#classicImageSymbol ? { symbol: this.#classicImageSymbol, count: images } : undefined);
	}

	#assertPromptScope(submission: PromptSubmission): void {
		this.#assertApplicationInput();
		if (this.#promptSubmissions.get(submission.id) !== submission || this.state.generation !== submission.generation || this.state.sessionId !== submission.sessionId) throw new Error("The chat changed before its submitted message could be recovered.");
		if (this.#tsp) {
			if (this.#tsp.snapshot().epoch !== submission.epoch) throw new Error("omp restarted before its submitted message could be recovered.");
			submission.target?.assertCurrent();
		}
	}

	async #beginPromptSubmission(id: string, text: string, images = 0): Promise<PromptSubmission> {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.#promptSubmissions.has(id)) throw new Error("This submission is already pending.");
		if (this.#promptSubmissions.size >= 128) throw new Error("Wait for omp to acknowledge its pending messages.");
		const bridge = this.#nativeBridge;
		const sessionId = this.state.sessionId;
		if (!bridge || !sessionId) throw new Error("Wait for omp to connect before sending a message.");
		const generation = this.state.generation;
		const submission: PromptSubmission = {
			id, text, generation, sessionId, epoch: this.#tsp?.snapshot().epoch,
			target: this.#tsp?.pinEditor(surface => this.#tspSurfaceGenerations.get(surface) === generation),
			diagnostics: new Set(this.#promptDiagnostics().map(diagnostic => diagnostic.key)), revision: this.#promptRevision,
			expected: this.#classicStagedDraft ? [text, this.#classicStagedDraft + text] : [text],
			images,
			written: false, inputObserved: false, inputBeforeWrite: false, emptyResume: false,
		};
		this.#promptSubmissions.set(id, submission);
		try {
			const observed = await bridge.watchPrompt({ id, sessionId, text, ...(images > 0 ? { images } : {}), ...(!this.#tsp ? { classicEditor: { expected: this.#classicStagedDraft ?? "" } } : {}) });
			this.#assertPromptScope(submission);
			if (submission.inputBeforeWrite) throw new Error("omp received another input before this message could be written. Send it again.");
			submission.emptyResume = observed.emptyResume;
			return submission;
		} catch (error) {
			this.acknowledgeSubmission(id);
			throw error;
		}
	}

	async #assertClassicEditorDraft(): Promise<void> {
		const bridge = this.#nativeBridge;
		const sessionId = this.state.sessionId;
		if (!bridge || !sessionId) throw new Error("Wait for omp to connect before sending a message.");
		const generation = this.state.generation;
		const read = await bridge.editorDraft({ operation: "peek", sessionId });
		this.#assertApplicationInput(true);
		if (generation !== this.state.generation || sessionId !== this.state.sessionId) throw new Error("The chat changed before its editor could be checked.");
		if (read.error || read.text === null) throw new Error(read.error ?? "omp's editor could not be checked.");
		if (read.text !== "" && read.text !== this.#classicStagedDraft) throw new Error("omp has unsent text in its editor. Recover it or restart omp before sending another message.");
	}

	#queuePromptRejectionCheck(): void {
		if (this.#closing || this.#promptSubmissions.size === 0) return;
		let pending = false;
		for (const submission of this.#promptSubmissions.values()) if (submission.written && !submission.failure) { pending = true; break; }
		if (!pending) return;
		this.#promptRecheck = true;
		if (this.#promptCheckQueued) return;
		this.#promptCheckQueued = true;
		void this.#applicationInput(async () => {
			while (this.#promptRecheck && !this.#closing) {
				this.#promptRecheck = false;
				await this.#checkPromptRejections();
			}
		}).catch(() => {
			// A room change or close invalidates recovery; neither proves that a prompt was rejected.
		}).finally(() => {
			this.#promptCheckQueued = false;
			if (this.#promptRecheck && !this.#closing) this.#queuePromptRejectionCheck();
		});
	}

	async #checkPromptRejections(): Promise<void> {
		const diagnostics = this.#promptDiagnostics();
		if (!diagnostics.length) return;
		for (const submission of this.#promptSubmissions.values()) {
			if (submission.generation !== this.state.generation || submission.sessionId !== this.state.sessionId
				|| this.#tsp && (submission.epoch !== this.#tsp.snapshot().epoch || submission.target?.ended())) {
				this.acknowledgeSubmission(submission.id);
				continue;
			}
			if (!submission.written || submission.failure || this.#promptRevision <= submission.revision) continue;
			const diagnostic = diagnostics.find(diagnostic => diagnostic.kind === "resume"
				? submission.emptyResume && (submission.text === "." || submission.text === "c")
				: submission.inputObserved && (!this.#tsp || !submission.diagnostics.has(diagnostic.key)));
			if (!diagnostic) continue;
			this.#assertPromptScope(submission);
			let cleared = false;
			let owned = false;
			try {
				const read = await this.#nativeBridge!.editorDraft({ operation: "peek", sessionId: submission.sessionId });
				this.#assertPromptScope(submission);
				if (read.error || read.text === null) throw new Error(read.error ?? "omp's editor could not be read.");
				if (diagnostic.kind === "resume" && read.text !== "") continue;
				const matchesDraft = (candidate: PromptSubmission): boolean => candidate.expected.includes(read.text!)
					|| expandedPromptTextMatches(read.text!, candidate.text, candidate.images);
				let matching: PromptSubmission | undefined, ambiguous = false;
				for (const candidate of this.#promptSubmissions.values()) {
					if (!candidate.written || candidate.failure || !candidate.inputObserved || read.text === ""
						|| candidate.generation !== submission.generation || candidate.sessionId !== submission.sessionId || !matchesDraft(candidate)) continue;
					if (matching) { ambiguous = true; break; }
					matching = candidate;
				}
				if (matching && (ambiguous || matching !== submission)) continue;
				// An old diagnostic beside an empty editor does not prove ordinary input was rejected.
				if (diagnostic.kind === "preflight" && read.text === "") continue;
				if (read.text === "" && !read.imageChips) { owned = true; cleared = true; }
				else {
					if (!matchesDraft(submission)) throw new Error("omp's editor has newer text. It was left unchanged.");
					owned = true;
					if (this.#tsp) {
						const facts = this.composerFacts();
						if (facts.text !== read.text) throw new Error("omp's semantic editor changed before recovery.");
						await this.#tsp.editAndKeys(0, facts.text.length, "", 0, "", () => this.#assertPromptScope(submission), surface => this.#tspSurfaceGenerations.get(surface) === submission.generation);
						await this.#tsp.waitFor(() => this.composerFacts().text === "" && this.#tsp!.imageCount(facts.surfaceId!) === 0, () => this.#assertPromptScope(submission), 8000, "omp did not confirm that its rejected message cleared.");
						cleared = true;
					} else {
						// Public classic text replacement cannot discard pending image payloads.
						if (submission.images > 0 || read.imageChips) throw new Error("omp still holds rejected images. Restart it without submitting the editor.");
						const taken = await this.#nativeBridge!.editorDraft({ operation: "take", sessionId: submission.sessionId, expected: read.text });
						this.#assertPromptScope(submission);
						cleared = taken.cleared && !taken.error;
					}
				}
			} catch {
				// A diagnostic without its exact restored draft cannot establish submission ownership.
				this.#assertPromptScope(submission);
				this.#editorTransferBlocked = "Restart omp to recover its uncertain editor before sending more text.";
				this.#stopWithoutEditor = true;
			}
			if (!owned) continue;
			this.#classicStagedDraft = null;
			this.#classicStagedImages = 0;
			submission.failure = { id: submission.id, generation: submission.generation, diagnostic: diagnostic.text, cleared };
			this.#nativeBridge?.forgetPrompt(submission.id);
			if (!cleared) {
				this.#editorTransferBlocked = "Restart omp to recover its rejected message before sending more text.";
				this.#stopWithoutEditor = true;
			}
			this.#publishPromptFailures();
			return;
		}
	}

	paste(text: string, imagePaths = false): Promise<void> {
		if (this.#tsp) {
			const generation = this.state.generation;
			const epoch = this.#tsp.snapshot().epoch;
			this.#tspPastesPending++;
			return this.#applicationInput(async () => {
				this.#assertTspInput(generation);
				if (epoch !== this.#tsp!.snapshot().epoch || !this.tspSnapshot()?.availability.available) throw new Error("TSP preview: Close the open omp menu before pasting.");
				if (this.#editorTransferBlocked) throw new Error(`TSP preview: ${this.#editorTransferBlocked}`);
				await this.#tsp!.paste(text, () => {
					this.#assertTspInput(generation);
					if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
				}, surface => this.#tspSurfaceGenerations.get(surface) === generation);
			}).catch(error => {
				this.#editorTransferBlocked = "The paste did not finish. Restart omp before sending another message.";
				this.#publishTsp();
				throw error;
			}).finally(() => { this.#tspPastesPending--; });
		}
		return this.#applicationInput(async () => {
			await this.#resolveWorktreeQuestion();
			this.#assertApplicationInput(true);
			if (this.#editorTransferBlocked) throw new Error(this.#editorTransferBlocked);
			this.#captureStartupNotices = false;
			this.#finishStartup();
			if (!imagePaths) {
				this.#writeInput(`\x1b[200~${text}\x1b[201~`);
				return;
			}
			const bridge = this.#nativeBridge;
			const debug = this.#debug;
			const sessionId = this.state.sessionId;
			const generation = this.state.generation;
			if (!bridge || !debug || !sessionId) throw new Error("omp's image attachment controls are unavailable.");
			await this.#assertClassicEditorDraft();
			await attachClassicImages(text, {
				assertCurrent: () => {
					this.#assertApplicationInput(true);
					if (this.state.generation !== generation || this.state.sessionId !== sessionId) throw new Error("The chat changed while attaching its images.");
				},
				readEditor: () => bridge.editorDraft({ operation: "peek", sessionId }),
				restoreEditor: (expected, restoreText) => bridge.editorDraft({ operation: "restore", sessionId, expected, restoreText }),
				failureText: async () => classicImageFailure(await debug.values()),
				paste: path => this.#writeInput(`\x1b[200~${path}\x1b[201~`),
				wait: () => sleep(40),
			}).catch(error => {
				if (error instanceof Error && error.message.startsWith("Image submission needs recovery.")) {
					// Quit and ordinary Close also reach stop() without renderer recovery intent.
					this.#stopWithoutEditor = true;
					this.#editorTransferBlocked = "Restart omp before sending more text after the failed image submission.";
				}
				throw error;
			});
			const staged = await bridge.editorDraft({ operation: "peek", sessionId });
			this.#assertApplicationInput(true);
			if (generation !== this.state.generation || sessionId !== this.state.sessionId || staged.error || staged.text === null || !staged.imageChips) {
				this.#editorTransferBlocked = "Restart omp before sending more text after its image attachment changed.";
				this.#stopWithoutEditor = true;
				throw new Error("Image submission needs recovery. omp's attached editor could not be confirmed.");
			}
			this.#classicStagedDraft = staged.text;
			this.#classicStagedImages = staged.imageChips;
			this.#classicImageSymbol = staged.imageSymbol;
		});
	}

	/** Exact-transfer recovery gates composed input, while manual keys, recovery and Stop remain available. */
	setEditorTransferBlocked(reason: string | null): void {
		this.#editorTransferBlocked = reason;
		if (this.#tsp) this.#publishTsp();
	}

	/** Hold the application input lock across one exact editor transfer and its verification. */
	withEditorInput<T>(operation: (input: EditorInputTransaction) => Promise<T>): Promise<T> {
		return this.#applicationInput(async () => {
			await this.#resolveWorktreeQuestion();
			this.#assertApplicationInput(true);
			if (this.#editorRestore) throw new Error("TSP preview: Recover and acknowledge the restored message before another editor transfer.");
			const generation = this.state.generation;
			const epoch = this.#tsp?.snapshot().epoch;
			let active = true;
			const assertOpen = (): void => {
				if (!active) throw new Error(hostLabels.editorTransactionClosed);
				this.#assertApplicationInput(true);
				if (this.#tsp) {
					this.#assertTspInput(generation);
					if (epoch !== this.#tsp.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
				}
			};
			const input: EditorInputTransaction = {
				assertOpen,
				edit: async (from, to, text, cursor) => {
					assertOpen();
					if (!this.#tsp) throw new Error("Exact semantic edits require a TSP host.");
					await this.#tsp.editAndKeys(from, to, text, cursor, "", assertOpen, surface => this.#tspSurfaceGenerations.get(surface) === generation);
				},
				keys: async (keys, expectedGhost) => {
					assertOpen();
					if (this.#tsp) {
						const before = this.composerFacts();
						if (keys === "tab" && expectedGhost !== undefined && before.ghost !== expectedGhost) throw new Error("TSP preview: The offered suggestion changed before Tab.");
						const target = this.#tsp.pinEditor(surface => this.#tspSurfaceGenerations.get(surface) === generation);
						if (this.#tsp.hasHookDialog() || !before.sendable || before.blockedBy) throw new Error("TSP preview: Close the open omp menu before editing.");
						this.#writeInput(keys === "tab" ? "\t" : keys === "escape" ? "\x1b" : keys);
						if (keys === "tab" && before.ghost) {
							await this.#tsp.waitFor(() => this.composerFacts().text !== before.text, () => { assertOpen(); target.assertCurrent(); }, 8000, "TSP preview: omp did not accept the offered suggestion.");
						}
						return;
					}
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

	/**
	 * Shared by application input and shutdown; terminal-sheet bytes stay a separate explicit path.
	 * Background polling passes `retryUnreadable` so a slow first read is retried by the next poll;
	 * input and shutdown callers still fail when omp's screen cannot be read.
	 */
	async #resolveWorktreeQuestion(retryUnreadable = false): Promise<void> {
		if (this.#tsp) {
			if (!this.#closing || this.#tspShutdownScope?.generation !== this.state.generation || this.#tspShutdownScope.epoch !== this.#tsp.snapshot().epoch) return;
			if (this.#worktreeDecision) return this.#worktreeDecision;
			const confirmation = worktreeExitConfirmation(this.#tsp.snapshot().surfaces);
			if (!confirmation) return;
			if (!this.#tspQuestions.canAnswerShutdown(
				{ hostId: this.id, generation: this.state.generation, epoch: this.#tsp.snapshot().epoch },
				hookQuestions(this.#tsp.snapshot().surfaces, this.state.generation), confirmation.sf, confirmation.id,
			)) return;
			this.#worktreeDecision = this.#confirmTspWorktree(confirmation).finally(() => { this.#worktreeDecision = null; });
			return this.#worktreeDecision;
		}
		if (this.#worktreeDecision) return this.#worktreeDecision;
		if (!this.#debug) throw new Error("omp is not running");
		let screen: string[];
		try {
			screen = await this.#debug.screen();
		} catch (error) {
			if (!retryUnreadable) throw error;
			// Reopening a long session can keep omp from answering within the debug channel's limit.
			// The next poll looks again, so this background read must not become the chat's lasting error.
			if (!this.#loggedSlowWorktreeRead) {
				this.#loggedSlowWorktreeRead = true;
				console.warn("[visual-omp] Could not read omp's screen to check for a worktree question; retrying.", error instanceof Error ? error.message : String(error));
			}
			return;
		}
		const confirmation = worktreeConfirmation(screen);
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

	/** Closing owns only this exact exit confirm; ordinary hook input remains rejected. */
	async #confirmTspWorktree(confirmation: WorktreeExitConfirmation): Promise<void> {
		const session = this.#tsp!;
		const epoch = session.snapshot().epoch;
		const generation = this.state.generation;
		const pty = this.#pty;
		const scope = { hostId: this.id, generation, epoch };
		const current = () => {
			if (!this.#closing || this.#pty !== pty || this.state.phase === "exited" || session.snapshot().epoch !== epoch || this.state.generation !== generation) return null;
			const next = worktreeExitConfirmation(session.snapshot().surfaces);
			return next && JSON.stringify(next) === JSON.stringify(confirmation)
				&& this.#tspQuestions.canAnswerShutdown(scope, hookQuestions(session.snapshot().surfaces, generation), confirmation.sf, confirmation.id) ? next : null;
		};
		this.#confirmingWorktree = true;
		try {
			const result = await this.#messageBox({
				type: "warning", message: confirmation.title, detail: confirmation.detail,
				buttons: [hostLabels.keepWorktree, hostLabels.removeWorktree],
				defaultId: 0, cancelId: 0, noLink: true,
			});
			if (!current()) return;
			const event = result.response === 1 ? confirmation.remove : confirmation.keep;
			if (event.ev !== "activate") return;
			await session.answerHook({ kind: "choose", sf: confirmation.sf, id: confirmation.id, target: event.id, item: event.item }, () => {
				if (!current()) throw new TspInputStateError(hostLabels.worktreeQuestionUnresolved);
				this.#tspQuestions.answer(scope, hookQuestions(session.snapshot().surfaces, generation), confirmation.sf, confirmation.id, "shutdown");
			});
			this.#publishTsp();
			await Promise.race([this.#exited, session.waitFor(() => nodeHasLeft(session.snapshot().surfaces, confirmation.sf, confirmation.id), () => {
				if (session.snapshot().epoch !== epoch || this.state.generation !== generation) throw new TspInputStateError(hostLabels.worktreeQuestionUnresolved);
			}, 8000, hostLabels.worktreeQuestionUnresolved)]);
		} finally {
			this.#shutdownProgressAt = Date.now();
			this.#confirmingWorktree = false;
		}
	}

	/** The same retained transfer used by Escape also owns a tree-restored editor draft. */
	takeEditorRestore(generation: number, epoch: number, surfaceId: string, editorId: string, text: string): Promise<void> {
		return this.#applicationInput(async () => {
			this.#assertTspInput(generation);
			if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
			if (this.#editorRestore || this.#editorTransferBlocked) throw new Error("TSP preview: Recover the previous editor transfer before restoring another message.");
			const facts = this.composerFacts();
			if (!facts.sendable || facts.blockedBy || facts.surfaceId !== surfaceId || facts.editorId !== editorId || facts.text !== text) throw new Error("TSP preview: The restored editor changed before its draft could be saved. It was left unchanged.");
			if (!text) return;
			const target = this.#tsp!.pinEditor(surface => surface === surfaceId && this.#tspSurfaceGenerations.get(surface) === generation);
			await this.#captureEditorRestore(generation, target, text);
		});
	}

	async #captureEditorRestore(generation: number, target: TspEditorTarget, text: string): Promise<void> {
		const capture = { view: { id: randomUUID(), hostId: this.id, text, cleared: false, error: null } as TspEditorRestore, generation, target };
		this.#editorRestore = capture;
		this.#editorTransferBlocked = "Recover the restored message before sending more text to omp.";
		this.#publishTsp();
		await this.#finishEditorRestore(capture);
	}

	ackEditorRestore(id: string): void {
		if (!this.#editorRestore || this.#editorRestore.view.id !== id) return;
		if (!this.#editorRestore.view.cleared) throw new Error("TSP preview: Recover omp's editor before acknowledging the restored message.");
		this.#editorRestore = null;
		this.#editorTransferBlocked = null;
		this.#publishTsp();
	}

	retryEditorRestore(id: string): Promise<void> {
		const capture = this.#editorRestore;
		if (!capture || capture.view.id !== id) return Promise.resolve();
		if (this.state.phase === "exited") {
			capture.view = { ...capture.view, cleared: true, error: "omp stopped. The restored message is saved in the app composer." };
			this.#publishTsp();
			return Promise.resolve();
		}
		return this.#applicationInput(() => this.#finishEditorRestore(capture));
	}

	async #finishEditorRestore(capture: EditorRestoreCapture): Promise<void> {
		try {
			if (capture.view.cleared) return;
			if (capture.target.ended()) {
				capture.view = { ...capture.view, cleared: true, error: "The original editor closed. The restored message is saved in the app composer." };
				return;
			}
			capture.target.assertCurrent();
			const assertCurrent = () => {
				this.#assertTspInput(capture.generation);
				capture.target.assertCurrent();
			};
			const facts = this.composerFacts();
			if (facts.surfaceId !== capture.target.surfaceId || facts.editorId !== capture.target.editorId) throw new Error("The original editor changed.");
			if (facts.text) {
				if (facts.text !== capture.view.text) throw new Error("omp's editor contains newer text. It was left unchanged.");
				await this.#tsp!.editAndKeys(0, facts.text.length, "", 0, "", assertCurrent, surface => surface === capture.target.surfaceId);
			}
			await this.#tsp!.waitFor(() => this.composerFacts().text === "", assertCurrent, 8000, "omp did not confirm that its restored editor cleared.");
			capture.view = { ...capture.view, cleared: true, error: null };
		} catch (error) {
			capture.view = { ...capture.view, error: error instanceof Error ? error.message : String(error) };
			throw new Error(`TSP preview: The restored message is saved. Retry editor recovery. ${capture.view.error}`);
		} finally { this.#publishTsp(); }
	}

	keys(keys: string, generation?: number, epoch?: number): Promise<void> {
		if (this.#tsp) {
			if (keys === "escape" || keys === "\x1b") {
				const snapshot = this.tspSnapshot();
				const dialogs = snapshot ? hookQuestions(snapshot.surfaces, this.state.generation) : [];
				if (dialogs.length) {
					if (generation === undefined || epoch === undefined || dialogs.length !== 1) return Promise.reject(new Error("TSP preview: The current question is ambiguous."));
					const target = dialogs[0]!;
					return this.tspAnswer(generation, { kind: "cancel", sf: target.surfaceId, id: target.nodeId }, epoch);
				}
			}
			return this.#applicationInput(async () => {
				if (generation === undefined || epoch === undefined) throw new Error(TSP_PREVIEW_UNAVAILABLE);
				this.#assertTspInput(generation);
				if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
				if (this.#tsp!.hasHookDialog()) throw new Error("TSP preview: Answer or cancel this question using its controls. Raw keys are unavailable while a question is open.");
				if (this.#editorRestore) {
					await this.#finishEditorRestore(this.#editorRestore);
					return;
				}
				const before = this.composerFacts();
				const target = before.queued.length ? this.#tsp!.pinEditor(surface => this.#tspSurfaceGenerations.get(surface) === generation) : null;
				if (keys === "undo" || keys === "\x1a") {
					if (!before.sendable || !before.surfaceId || !before.editorId || before.blockedBy) throw new Error("TSP preview: Close the open omp menu before undoing an edit.");
					await this.#tsp!.send({ ev: "undo", sf: before.surfaceId, id: before.editorId }, () => {
						this.#assertTspInput(generation);
						if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
					});
					return;
				}
				this.#writeInput(keys === "escape" ? "\x1b" : keys === "tab" ? "\t" : keys);
				if ((keys === "escape" || keys === "\x1b") && before.queued.length > 0) {
					const assertCurrent = () => {
						target!.assertCurrent();
						this.#assertTspInput(generation);
						if (epoch !== this.#tsp!.snapshot().epoch) throw new Error("TSP preview: The semantic screen restarted.");
						const current = this.composerFacts();
						if (current.surfaceId !== target!.surfaceId || current.editorId !== target!.editorId) throw new Error("TSP preview: The original editor changed.");
					};
					await this.#tsp!.waitFor(() => {
						const facts = this.composerFacts();
						return facts.queued.length === 0 && !!facts.text && facts.sendable;
					}, assertCurrent, 8000, "TSP preview: omp did not return the queued text to its editor.");
					const facts = this.composerFacts();
					if (this.#editorTransferBlocked) throw new Error(`TSP preview: ${this.#editorTransferBlocked}`);
					await this.#captureEditorRestore(generation, target!, facts.text);
				}
			});
		}
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

	/** Main-owned audit seam. Attempts are recorded before refusal, including after host exit. */
	screenReadAttempts(): readonly { readonly source: string }[] {
		return this.#screenReadAttempts.slice();
	}

	#assertClassicRead(source: string): void {
		if (!this.#tsp) return;
		this.#screenReadAttempts.push({ source });
		throw new Error(TSP_PREVIEW_UNAVAILABLE);
	}

	async screenLines(): Promise<string[]> {
		this.#assertClassicRead("host:screen");
		if (!this.#debug) return [];
		return this.#debug.screen();
	}

	/** A failed classic readiness read records only its border, once for this host. */
	reportUnreadableStatus(border: string | null): void {
		if (this.#tsp || this.#loggedUnreadableStatus) return;
		this.#loggedUnreadableStatus = true;
		console.warn("[visual-omp] Could not read omp's classic status line:", {
			hostId: this.id,
			cols: this.state.cols,
			rows: this.state.rows,
			border: border?.slice(0, 2048) ?? null,
		});
	}

	async screenPaint(): Promise<TuiPaint> {
		this.#assertClassicRead("screenPaint");
		if (!this.#debug) return { lines: [] };
		return this.#debug.paint();
	}

	/** TUI component debug state (e.g. the editor's current text) for features that read omp's own UI. */
	async debugValues(): Promise<Record<string, unknown>> {
		this.#assertClassicRead("debugValues");
		if (!this.#debug) return {};
		return this.#debug.values();
	}

	/** Read current focus directly; cached HostState.tui is only a periodic UI projection. */
	async tuiFocus(): Promise<TuiFocus | null> {
		this.#assertClassicRead("host:tui-focus");
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
		if (this.#tsp) void this.#tsp.resize(cols).catch(error => this.#update({ error: String(error) }));
		this.#update({ cols, rows });
	}

	tspResize(cols: number): Promise<void> {
		if (!Number.isInteger(cols) || cols < 20 || cols > 1000) return Promise.reject(new Error("Invalid omp screen width."));
		return this.#tsp?.resize(cols) ?? Promise.resolve();
	}

	serializedScreen(): string {
		this.#assertClassicRead("host:buffer");
		return this.#serializer.serialize();
	}

	/** Closing cancels application input immediately. Only an explicit native decision can force-stop omp. */
	stop(mode: HostStopMode = "normal"): Promise<void> {
		this.#closing = true;
		this.#stopWithoutEditor ||= mode === "editor-recovery";
		if (this.#tsp) {
			this.#tspShutdownScope ??= { generation: this.state.generation, epoch: this.#tsp.snapshot().epoch };
			this.#publishTsp();
		}
		this.#stopping ??= this.#stop().finally(() => { this.#stopping = null; });
		return this.#stopping;
	}

	async #stop(): Promise<void> {
		const pty = this.#pty;
		if (!pty || this.state.phase === "exited") return;
		// A submission may be awaiting a native startup decision. It rejects when that decision
		// finishes because closing was set synchronously, before this drain.
		if (!(await this.#drainApplicationInput(pty))) return;
		// Main also guards ordinary close after a failed transfer, even if the renderer lost its recovery state.
		this.#stopWithoutEditor ||= !this.#tsp && this.#editorTransferBlocked !== null;
		if (!this.#tsp && !this.#stopWithoutEditor && this.#nativeBridge && this.state.sessionId) {
			const generation = this.state.generation, sessionId = this.state.sessionId;
			try {
				const read = await this.#nativeBridge.editorDraft({ operation: "peek", sessionId });
				this.#stopWithoutEditor = generation !== this.state.generation || sessionId !== this.state.sessionId || read.text !== "" || !!read.imageChips || !!read.error;
			} catch { this.#stopWithoutEditor = true; }
		}
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
		let exitSent = false;
		let escapedOverlay: string | null = null;
		if (this.#stopWithoutEditor && prepared && this.#shutdownStage === "requested") {
			// SDK shutdown preserves upstream settled-boundary and worktree exit decisions. A kernel
			// signal also avoids Enter, but skips shutdown()'s owned-worktree planning.
			try { this.#nativeBridge?.requestShutdown(); }
			catch (error) { this.#update({ error: error instanceof Error ? error.message : String(error) }); }
			// A missing/unresponsive bridge goes through the existing explicit native stop decision.
		} else if (!this.#tsp && prepared && this.#shutdownStage === "requested") {
			if (this.state.tui && this.state.tui.overlays > 0) {
				await this.#debug?.keys("escape").catch(() => undefined);
				await sleep(150);
			}
			this.#writeInput("\x1b[200~/exit\x1b[201~\r");
		}
		this.#shutdownProgressAt = Date.now();
		while (this.#pty === pty) {
			if (this.#tsp || this.#stopWithoutEditor) {
				try { await this.#resolveWorktreeQuestion(); }
				catch (error) { this.#update({ error: error instanceof Error ? error.message : String(error) }); }
				if (this.#pty !== pty) return;
			}
			if (this.#tsp && !this.#stopWithoutEditor && !exitSent && this.#shutdownStage === "requested") {
				const surfaces = this.#tsp.snapshot().surfaces;
				const overlay = openOverlay(surfaces, true);
				const screen = screenSurface(surfaces);
				// Shutdown must never answer a hook through a second, raw-key route.
				if ((overlay || screen) && !this.#tsp.hasHookDialog()) {
					const identity = overlay ? `${overlay.surface.open.id}:${overlay.node.id}` : screen!.open.id;
					if (escapedOverlay !== identity) { escapedOverlay = identity; this.#writeInput("\x1b"); }
				} else if (!this.#tsp.hasHookDialog() && this.#tsp.availability().available) {
					this.#tspExitSurface = composer(surfaces)?.surface.open.id ?? null;
					try {
						await this.#tsp.submit("/exit");
						exitSent = true;
					} catch (error) {
						if (!(error instanceof TspInputStateError)) throw error;
						this.#tspExitSurface = null;
						// A new overlay or epoch invalidated the queued send. Continue through the
						// existing shutdown deadline and native force-stop decision.
					}
				}
			}
			if (this.#nativeBridge?.snapshot.shutdown === "teardown") this.#shutdownProgress("teardown");
			if (!this.#tsp) this.#rememberShutdownProgress();
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
		this.#assertClassicRead("shutdown:painted-progress");
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
					this.#nativeBridge?.beginGeneration(this.state.generation + 1);
					this.#update({
						phase: "live",
						link,
						generation: this.state.generation + 1,
						processStartedAt: host.startedAt,
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
			if (this.#tsp) this.#tspAppearanceChanged();
			const location = this.#nativeBridge?.snapshot.location;
			if (location) {
				// omp allocates a path before its first durable write. Empty launches must not become
				// restorable tabs merely because the extension knows that future filename.
				const sessionFile = location.sessionFile && await stat(location.sessionFile).then(info => info.isFile(), () => false) ? location.sessionFile : null;
				if (location.cwd !== this.state.cwd || sessionFile !== this.state.sessionFile || location.sessionId !== this.state.sessionId) {
					this.#update({ cwd: location.cwd, sessionFile, sessionId: location.sessionId });
				}
			}
			if (!this.#tsp) {
				const tui = await this.#debug.info().catch(() => null);
				if (tui?.focused || (tui?.overlays ?? 0) > 0) this.#finishStartup();
				if (JSON.stringify(tui) !== JSON.stringify(this.state.tui)) this.#update({ tui });
				if (tui && !this.#confirmingWorktree && !this.#shutdownPrompt) await this.#resolveWorktreeQuestion(true);
			}
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
		const pty = this.#pty;
		clearTimeout(this.#tspHandshakeTimer ?? undefined);
		this.#tspHandshakeTimer = null;
		this.#tspSurfaceGenerations.clear();
		this.#tspStream?.end();
		this.#tspStartup?.end();
		const remainder = this.#terminalDecoder.end();
		if (remainder) broadcast("host:data", { hostId: this.id, data: remainder });
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
		const released = pty && process.platform === "win32" ? releaseWindowsConpty(pty).catch(error => {
			const reason = error instanceof Error ? error.message : String(error);
			this.#update({ error: `Could not release omp's Windows terminal resources: ${reason}` });
			console.error("[visual-omp] Windows terminal resource cleanup failed:", error);
		}) : undefined;
		this.#markExited();
		try { await this.#cleanup(); }
		finally { await released; }
	}

	#finishStartup(): void {
		this.#startupComplete = true;
		this.#lastExitReason = null;
		this.#startupResumeFileMissing = false;
		this.#tspStartup = null;
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
		this.#assertClassicRead("startup:painted-notices");
		const buffer = this.#screen.buffer.active;
		const lines: string[] = [];
		let wrapped: string | null = null;
		for (let index = 0; index < buffer.length; index++) {
			const line = buffer.getLine(index);
			if (!line) continue;
			if (!line.isWrapped && wrapped !== null) { lines.push(wrapped); wrapped = ""; }
			const text = line.translateToString(true);
			if (/^\s*(?:[╭┌┏][─━]|π\s+[▶>\ue0b0]|🗑.*[▶>\ue0b0][─-])/u.test(text)) break;
			wrapped = ((wrapped ?? "") + text).slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS + 1);
		}
		if (wrapped !== null) lines.push(wrapped);
		return lines;
	}

	/** Keep recognized diagnostics above the editor; never copy arbitrary startup output or drafts. */
	#rememberStartupDiagnostic(): void {
		if (this.#tsp) {
			const diagnostic = this.#tspStartup?.diagnostic(this.#options.resumeFile);
			if (diagnostic) {
				this.#lastExitReason = diagnostic.text;
				this.#startupResumeFileMissing = diagnostic.resumeFileMissing;
			}
			return;
		}
		this.#assertClassicRead("startup:painted-diagnostic");
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
			// Box and band composers both separate transcript output from editable content.
			if (/^\s*(?:[╭┌┏][─━]|π\s+[▶>\ue0b0]|🗑.*[▶>\ue0b0][─-])/u.test(text)) break;
			wrapped = (wrapped + text).slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS + 1);
		}
		if (wrapped) lines.push(wrapped);
		const diagnostic = startupDiagnostic(lines, this.#options.resumeFile);
		if (!diagnostic) return;
		this.#startupResumeFileMissing = diagnostic.resumeFileMissing;
		this.#lastExitReason = diagnostic.text;
	}

	async #cleanup(): Promise<void> {
		clearTimeout(this.#tspHandshakeTimer ?? undefined);
		this.#tspHandshakeTimer = null;
		clearInterval(this.#focusTimer ?? undefined);
		this.#focusTimer = null;
		this.#btwHistory?.close();
		if (this.#tsp) nativeTheme.removeListener("updated", this.#tspAppearanceChanged);
		this.#debug?.close();
		this.#relay.stop();
		await this.#nativeBridge?.close();
		this.#nativeBridge = null;
		this.#screen.dispose();
		if (this.#privateDir) await rm(this.#privateDir, { recursive: true, force: true });
		this.#privateDir = null;
	}

	#update(patch: Partial<HostState>): void {
		const previousGeneration = this.state.generation;
		if (patch.phase === "exited" || patch.phase === "restarting" || patch.generation !== undefined && patch.generation !== previousGeneration
			|| patch.sessionId !== undefined && patch.sessionId !== this.state.sessionId) {
			for (const id of this.#promptSubmissions.keys()) this.#nativeBridge?.forgetPrompt(id);
			this.#promptSubmissions.clear();
			this.#classicStagedDraft = null;
			this.#classicStagedImages = 0;
			this.#classicImageSymbol = undefined;
			patch.promptFailures = [];
		}
		if (this.#tsp && patch.phase === "restarting") this.#tspSurfaceGenerations.clear();
		if (this.#tsp && patch.generation !== undefined && patch.generation !== previousGeneration) {
			if (previousGeneration === 0) {
				for (const surface of this.#tsp.snapshot().surfaces) if (surface.sequence > 0) this.#tspSurfaceGenerations.set(surface.open.id, patch.generation);
			} else this.#tspSurfaceGenerations.clear();
		}
		this.state = { ...this.state, ...patch };
		broadcast("host:state", this.state);
		if (this.#tsp && (patch.generation !== undefined || patch.phase !== undefined || patch.sessionFile !== undefined)) this.#publishTsp();
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

export async function stopHost(hostId: string, mode?: HostStopMode): Promise<void> {
	const host = hosts.get(hostId);
	if (!host) return;
	await host.stop(mode);
	hosts.delete(hostId);
}

export async function stopAllHosts(): Promise<void> {
	await Promise.all([...hosts.keys()].map(hostId => stopHost(hostId)));
}
