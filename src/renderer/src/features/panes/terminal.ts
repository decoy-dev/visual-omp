/**
 * Plain project shells for the Terminal pane (not the omp TUI — that is the terminal sheet).
 *
 * Output is buffered here from the moment a shell starts, so an xterm view that mounts later (tab
 * switch, dock reopened) replays everything, and other features can start a command in a new tab
 * with {@link runInTerminal}.
 */
import { create } from "zustand";
import { useApp } from "../../state/app";

export interface TerminalTab {
	termId: string;
	cwd: string;
	/** Command line for one-off runs; null for an interactive shell. */
	command: string | null;
	/** 1-based shell number for the label ("Shell 2"). */
	seq: number;
	/** Exit code once the process ended. */
	exitCode: number | null;
}

interface TerminalState {
	tabs: TerminalTab[];
	active: string | null;
	activate(termId: string): void;
	close(termId: string): void;
}

/** Replay cap per terminal (older output is dropped from the replay buffer). */
const BUFFER_LIMIT = 2 * 1024 * 1024;

const buffers = new Map<string, { chunks: string[]; size: number }>();
const dataListeners = new Map<string, Set<(data: string) => void>>();
let seq = 0;

export const useTerminals = create<TerminalState>((set, get) => ({
	tabs: [],
	active: null,
	activate(termId) {
		set({ active: termId });
	},
	close(termId) {
		const { tabs, active } = get();
		const index = tabs.findIndex(tab => tab.termId === termId);
		if (index < 0) return;
		const tab = tabs[index];
		if (tab.exitCode === null) void window.vomp.invoke("term:kill", termId);
		buffers.delete(termId);
		dataListeners.delete(termId);
		const next = tabs.filter(entry => entry.termId !== termId);
		set({ tabs: next, active: active === termId ? (next[index] ?? next[index - 1] ?? null)?.termId ?? null : active });
	},
}));

function append(termId: string, data: string): void {
	const buffer = buffers.get(termId);
	if (!buffer) return;
	buffer.chunks.push(data);
	buffer.size += data.length;
	while (buffer.size > BUFFER_LIMIT && buffer.chunks.length > 1) buffer.size -= buffer.chunks.shift()?.length ?? 0;
	for (const listener of dataListeners.get(termId) ?? []) listener(data);
}

let wired = false;
function wire(): void {
	if (wired) return;
	wired = true;
	window.vomp.on("term:data", ({ termId, data }) => append(termId, data));
	window.vomp.on("term:exit", ({ termId, code }) => {
		if (!buffers.has(termId)) return;
		useTerminals.setState(state => ({ tabs: state.tabs.map(tab => (tab.termId === termId ? { ...tab, exitCode: code } : tab)) }));
	});
}

async function start(cwd: string, command: string | null): Promise<string> {
	wire();
	const termId = await window.vomp.invoke("term:start", { cwd, ...(command ? { command } : {}) });
	// Main replies to `term:start` before the PTY emits anything and IPC keeps message order, so the
	// buffer exists before the first `term:data` for this id arrives.
	buffers.set(termId, { chunks: [], size: 0 });
	const tab: TerminalTab = { termId, cwd, command, seq: ++seq, exitCode: null };
	useTerminals.setState(state => ({ tabs: [...state.tabs, tab], active: termId }));
	return termId;
}

/** Open a new interactive shell tab in `cwd` and show the Terminal pane. */
export async function newShell(cwd: string): Promise<string> {
	const termId = await start(cwd, null);
	useApp.getState().showPane("terminal");
	return termId;
}

/**
 * Run `command` in a new Terminal tab (login shell, so the user's PATH applies), show the pane, and
 * resolve the terminal id. The tab stays open after the command exits so its output can be read.
 */
export async function runInTerminal(cwd: string, command: string): Promise<string> {
	const termId = await start(cwd, command);
	useApp.getState().showPane("terminal");
	return termId;
}

/** Everything the terminal printed so far (capped), for replay into a new xterm view. */
export function terminalBuffer(termId: string): string {
	return buffers.get(termId)?.chunks.join("") ?? "";
}

/** Live output after the replay point. */
export function onTerminalData(termId: string, listener: (data: string) => void): () => void {
	let set = dataListeners.get(termId);
	if (!set) {
		set = new Set();
		dataListeners.set(termId, set);
	}
	set.add(listener);
	return () => set.delete(listener);
}
