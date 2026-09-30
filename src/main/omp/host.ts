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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { type IPty, spawn } from "node-pty";
import { stringify } from "yaml";
import { z } from "zod";
import type { HostStartOptions, HostState, TuiFocus } from "@shared/ipc";
import { ptyEnv, userEnv } from "../env";
import { broadcast } from "../ipc";
import { runOmpJson } from "./cli";
import { ompPath } from "./locate";
import { LoopbackRelay } from "./relay";
import { findSessionFile } from "./sessions";
import { TuiDebugClient } from "./tui-debug";

const CollabHosts = z.object({
	hosts: z.array(
		z.object({
			instanceId: z.string(),
			generation: z.number(),
			pid: z.number(),
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
	#focusTimer: NodeJS.Timeout | null = null;
	#exited: Promise<void>;
	#markExited: () => void;
	state: HostState;

	constructor(options: HostStartOptions) {
		this.#options = options;
		const cols = options.cols ?? 120;
		const rows = options.rows ?? 36;
		this.#screen = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
		this.#screen.loadAddon(this.#serializer);
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
			error: null,
			tui: null,
		};
	}

	async start(): Promise<void> {
		try {
			const [bin, env] = await Promise.all([ompPath(), userEnv()]);
			await this.#relay.start();
			this.#relay.events = {
				onHostOpen: roomId => void this.#resolveLink(roomId),
				onHostClose: roomId => this.#onRoomClosed(roomId),
			};
			// Owner-only directory: the debug socket accepts keystrokes, so nobody else may reach it.
			this.#privateDir = await mkdtemp(join(tmpdir(), "vomp-"));
			const overlay = join(this.#privateDir, "overlay.yml");
			await writeFile(overlay, stringify(this.#overlayConfig()), { mode: 0o600 });
			const debugPath =
				process.platform === "win32" ? `\\\\.\\pipe\\visual-omp-${this.id}` : join(this.#privateDir, "tui.sock");
			const args = ["--config", overlay];
			if (this.#options.resumeFile) args.push("--resume", this.#options.resumeFile);
			args.push(...(this.#options.extraArgs ?? []));
			const childEnv: NodeJS.ProcessEnv = { ...env, OMP_SKIP_SETUP: "1", OMP_TUI_DEBUG: debugPath, PI_TUI_NATIVE: "0" };
			delete childEnv.TERM_PROGRAM;
			this.#pty = spawn(bin, args, {
				name: "xterm-256color",
				cols: this.#screen.cols,
				rows: this.#screen.rows,
				cwd: this.#options.cwd,
				env: ptyEnv(childEnv),
			});
			this.#debug = new TuiDebugClient(debugPath);
			this.#pty.onData(data => {
				this.#screen.write(data);
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
		};
	}

	/** Raw bytes to the TUI (terminal sheet keystrokes). */
	write(data: string): void {
		this.#pty?.write(data);
	}

	/**
	 * Type `text` as one bracketed paste and submit it in the same write, so multi-line text never
	 * submits early and a large paste becomes an attachment chip instead of a menu.
	 * `steer` (Enter) interrupts a running turn at the next safe point; `followUp` (Ctrl+Q) waits for the yield.
	 */
	submit(text: string, mode: "steer" | "followUp" = "steer"): void {
		this.#pty?.write(`\x1b[200~${text}\x1b[201~${mode === "followUp" ? "\x11" : "\r"}`);
	}

	async keys(keys: string): Promise<void> {
		if (!this.#debug) throw new Error("omp is not running");
		await this.#debug.keys(keys);
	}

	async screenLines(): Promise<string[]> {
		if (!this.#debug) return [];
		return this.#debug.screen();
	}

	resize(cols: number, rows: number): void {
		if (cols < 20 || rows < 5) return;
		this.#pty?.resize(cols, rows);
		this.#screen.resize(cols, rows);
	}

	serializedScreen(): string {
		return this.#serializer.serialize();
	}

	/** Ask omp to exit cleanly (flushing the session); force-kill after a grace period. */
	async stop(): Promise<void> {
		const pty = this.#pty;
		if (!pty) return;
		if (this.state.tui && this.state.tui.overlays > 0) {
			await this.keys("escape").catch(() => undefined);
			await sleep(150);
		}
		this.submit("/exit");
		const outcome = await Promise.race([this.#exited.then(() => "exited" as const), sleep(STOP_GRACE_MS, "timeout" as const)]);
		if (outcome === "timeout") pty.kill();
		await this.#exited;
	}

	async #resolveLink(roomId: string): Promise<void> {
		this.#roomId = roomId;
		const pid = this.#pty?.pid;
		for (let attempt = 0; attempt < LINK_RETRY_LIMIT && this.#roomId === roomId; attempt++) {
			try {
				const { hosts } = CollabHosts.parse(await runOmpJson(["collab", "list", "--json"]));
				for (const host of hosts.filter(candidate => candidate.pid === pid)) {
					const link = CollabLink.parse(await runOmpJson(["collab", "link", host.instanceId, "--json"]));
					if (!link.url.includes(`/r/${roomId}.`)) continue;
					if (this.#roomId !== roomId) return;
					const sessionFile = host.sessionId ? await findSessionFile(host.sessionId) : null;
					this.#update({
						phase: "live",
						link: link.url,
						generation: this.state.generation + 1,
						sessionId: host.sessionId,
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
		if (this.state.phase !== "exited") this.#update({ phase: "restarting", link: null });
	}

	async #pollFocus(): Promise<void> {
		if (!this.#debug || this.state.phase === "exited") return;
		let tui: TuiFocus | null;
		try {
			tui = await this.#debug.info();
		} catch {
			tui = null;
		}
		if (JSON.stringify(tui) !== JSON.stringify(this.state.tui)) this.#update({ tui });
	}

	async #onExit(exitCode: number): Promise<void> {
		this.#update({ phase: "exited", exitCode, link: null, tui: null });
		this.#markExited();
		await this.#cleanup();
	}

	async #cleanup(): Promise<void> {
		clearInterval(this.#focusTimer ?? undefined);
		this.#focusTimer = null;
		this.#debug?.close();
		this.#relay.stop();
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
