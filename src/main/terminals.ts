import { randomUUID } from "node:crypto";
import { type IPty, spawn } from "node-pty";
import type { TerminalStartOptions } from "@shared/ipc";
import { ptyEnv, userEnv } from "./env";
import { broadcast } from "./ipc";

const terminals = new Map<string, IPty>();

function shellCommand(env: NodeJS.ProcessEnv, command: string | undefined): { file: string; args: string[] } {
	if (process.platform === "win32") {
		return { file: "powershell.exe", args: command ? ["-NoLogo", "-Command", command] : ["-NoLogo"] };
	}
	const file = env.SHELL || "/bin/zsh";
	return { file, args: command ? ["-lc", command] : ["-l"] };
}

/** Start an interactive shell (or a one-off command) in a PTY for the Terminal pane. */
export async function startTerminal(options: TerminalStartOptions): Promise<string> {
	const env = await userEnv();
	const { file, args } = shellCommand(env, options.command);
	const pty = spawn(file, args, {
		name: "xterm-256color",
		cols: options.cols ?? 100,
		rows: options.rows ?? 30,
		cwd: options.cwd,
		env: ptyEnv(env),
	});
	const termId = randomUUID();
	terminals.set(termId, pty);
	pty.onData(data => broadcast("term:data", { termId, data }));
	pty.onExit(({ exitCode }) => {
		terminals.delete(termId);
		broadcast("term:exit", { termId, code: exitCode });
	});
	return termId;
}

export function writeTerminal(termId: string, data: string): void {
	terminals.get(termId)?.write(data);
}

export function resizeTerminal(termId: string, cols: number, rows: number): void {
	if (cols > 0 && rows > 0) terminals.get(termId)?.resize(cols, rows);
}

export function killTerminal(termId: string): void {
	terminals.get(termId)?.kill();
	terminals.delete(termId);
}

export function killAllTerminals(): void {
	for (const pty of terminals.values()) pty.kill();
	terminals.clear();
}
