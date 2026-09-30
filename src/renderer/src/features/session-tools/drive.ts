/**
 * Driving omp's hidden TUI for session tools: run a slash command and read back what omp printed,
 * press keys and wait for the painted screen to confirm the result. omp only reports most of these
 * outcomes in its own status area (not over collab), so every action verifies itself on screen.
 */
import { toast } from "@/ui";
import { i18n } from "../../i18n";
import type { SessionController } from "../../state/session";
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
 * Wait until omp's prompt editor is on screen (it is hidden while a dialog, picker or full-screen
 * menu is open). Starts omp first when the chat is not live yet.
 */
export async function readyEditor(session: SessionController): Promise<string[]> {
	await session.ensureLive();
	const lines = await waitForScreen(session, screen => parseStatusLine(screen) !== null, 8000);
	if (!lines || (session.getSnapshot().host?.tui?.overlays ?? 0) > 0) throw new OmpBusyError();
	return lines;
}

export interface CommandResult {
	/** Lines omp printed in response (status/warning lines), oldest first. */
	output: string[];
	/** Screen after the command. */
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
	const tone = /^(error|failed)/i.test(message) ? "err" : /^warning/i.test(message) ? "warn" : "info";
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
