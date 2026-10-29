import { access, constants, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

/** Windows root-relative and drive-relative paths still depend on the working directory. */
function fullyAbsolute(path: string, windows: boolean): boolean {
	return windows ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(path) : posix.isAbsolute(path);
}

function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
	const key = windows ? Object.keys(env).sort().find(key => key.toUpperCase() === name) : name;
	return key === undefined ? undefined : env[key];
}

/**
 * Select a regular executable without consulting either the app's or a child's working directory.
 * Explicit paths must be fully absolute. Symlinks to regular executables remain supported.
 * Windows searches native .exe/.com suffixes, then an exact extensionless file, without a shell.
 */
export async function resolveExecutable(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
	if (!command || command.includes("\0")) return null;
	const windows = platform === "win32";
	const paths = windows ? win32 : posix;
	const absolute = fullyAbsolute(command, windows);
	if (!absolute && (command.includes("/") || (windows && /[\\:]/.test(command)))) return null;
	const suffixes = windows && !paths.extname(command)
		? [...new Set([
			...(envValue(env, "PATHEXT", true) ?? ".COM;.EXE").split(";").filter(suffix => /^\.(?:exe|com)$/i.test(suffix)).map(suffix => suffix.toLowerCase()),
			".exe", ".com", "",
		])]
		: [""];
	const dirs = absolute ? [paths.dirname(command)] : (envValue(env, "PATH", windows) ?? "").split(paths.delimiter);
	const name = absolute ? paths.basename(command) : command;
	for (let dir of dirs) {
		// Windows commonly quotes PATH entries containing spaces.
		if (windows && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1);
		if (!fullyAbsolute(dir, windows)) continue;
		for (const suffix of suffixes) {
			const candidate = paths.resolve(dir, `${name}${suffix}`);
			try {
				if (!(await stat(candidate)).isFile()) continue;
				await access(candidate, windows ? constants.F_OK : constants.X_OK);
				return candidate;
			} catch {}
		}
	}
	return null;
}

/** Fail before spawning rather than falling back to the operating system's cwd-sensitive search. */
export async function requireExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const executable = await resolveExecutable(command, env);
	if (!executable) throw Object.assign(new Error(`Executable not found: ${command}`), { code: "ENOENT" });
	return executable;
}
