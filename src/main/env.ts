import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const MARKER = "__VISUAL_OMP_ENV__";

/**
 * GUI apps on macOS/Linux inherit a minimal PATH, not the user's shell profile. Resolve the login
 * shell environment once so omp, git, gh, bun, etc. are found exactly as in a terminal.
 */
async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
	const base = { ...process.env };
	if (process.platform === "win32") return base;
	const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
	const { promise: output, resolve } = Promise.withResolvers<string>();
	execFile(
		shell,
		["-ilc", `printf '${MARKER}'; env; printf '${MARKER}'`],
		{ timeout: 8000, env: { ...base, DISABLE_AUTO_UPDATE: "true" }, maxBuffer: 4 * 1024 * 1024 },
		(_error, stdout) => resolve(stdout ?? ""),
	);
	const body = (await output).split(MARKER)[1];
	if (!body) return base;
	const env: NodeJS.ProcessEnv = { ...base };
	for (const line of body.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return env;
}

/** Well-known install locations appended to PATH so a fresh omp install is found without a shell restart. */
function extraBinDirs(): string[] {
	const home = homedir();
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
		return [join(local, "omp"), join(home, ".bun", "bin"), join(home, ".local", "bin")];
	}
	return [
		join(home, ".local", "bin"),
		join(home, ".bun", "bin"),
		join(home, ".omp", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(home, "homebrew", "bin"),
	];
}

let envPromise: Promise<NodeJS.ProcessEnv> | null = null;

/** The environment every child process (omp, shells, git) is spawned with. */
export function userEnv(): Promise<NodeJS.ProcessEnv> {
	envPromise ??= loadShellEnv().then(env => {
		const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
		const parts = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
		for (const dir of extraBinDirs()) if (!parts.includes(dir)) parts.push(dir);
		env[pathKey] = parts.join(delimiter);
		env.TERM = "xterm-256color";
		env.COLORTERM = "truecolor";
		return env;
	});
	return envPromise;
}

/** node-pty wants `Record<string, string>`; drop unset variables instead of casting them away. */
export function ptyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
	return out;
}
