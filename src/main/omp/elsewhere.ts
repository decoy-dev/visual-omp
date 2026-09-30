/**
 * Whether a saved session is open in an omp process outside this app, so it opens read-only (two
 * writers must never share one session file).
 *
 * omp has no session ownership lock to ask. Its cross-process publish lock
 * (`.<file>.lock` beside the session) is held only for the duration of one append or rewrite,
 * and omp's docs say it "cannot protect against non-cooperating external writers". So ownership
 * is inferred from two observations, and anything the app cannot read makes the answer `unknown`:
 *
 * - An open writable file descriptor on the session file (`lsof`). omp keeps its writer open from
 *   its first append until it closes or switches sessions.
 * - A terminal breadcrumb naming the file whose terminal still runs omp. omp writes one per
 *   terminal under `<agentDir>/terminal-sessions/<terminal-id>` (line 1 the cwd, line 2 the session
 *   file; docs/session.md). On macOS/Linux the id is the tty name; other ids cannot be checked.
 *
 * Remaining gap: an omp that resumed the file but has not appended yet holds no descriptor, and
 * `ps` does not always report the tty it runs on. Such a process looks absent until it writes.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionOwnership } from "@shared/ipc";
import { userEnv } from "../env";
import { listHosts } from "./host";
import { agentDir } from "./paths";

interface Run {
	stdout: string;
	stderr: string;
	/** Exit code; null when the process could not start, timed out or overflowed its buffer. */
	code: number | null;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
	const { promise, resolve } = Promise.withResolvers<Run>();
	execFile(command, args, { env, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
		const code = error === null ? 0 : typeof error.code === "number" && !error.killed ? error.code : null;
		resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
	});
	return promise;
}

/** Terminals (breadcrumb-style names) running an omp this app did not start; null when `ps` failed. */
async function ompTerminals(env: NodeJS.ProcessEnv, ours: ReadonlySet<number>): Promise<Set<string> | null> {
	const { stdout, code } = await run("ps", ["-A", "-o", "pid=,tty=,comm=,args="], env);
	if (code !== 0) return null;
	const terminals = new Set<string>();
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line);
		if (!match?.[1] || !match[2] || !match[3] || !match[4] || ours.has(Number(match[1]))) continue;
		// Installed omp is a compiled binary named `cli.js`; argv[0] is still `omp` when launched by name.
		const names = [basename(match[3]), basename(match[4])];
		if (!names.some(name => name === "omp" || name === "omp.exe")) continue;
		// ps prints mac ttys as "s000" for /dev/ttys000 and Linux as "pts/3"; breadcrumbs use the device name.
		const tty = match[2].replace(/\//g, "-");
		terminals.add(tty);
		terminals.add(`tty${tty}`);
	}
	return terminals;
}

/** Files some process other than this app holds open for writing; null when `lsof` failed. */
async function writtenFiles(files: readonly string[], env: NodeJS.ProcessEnv, ours: ReadonlySet<number>): Promise<Set<string> | null> {
	const written = new Set<string>();
	if (files.length === 0) return written;
	const { stdout, stderr, code } = await run("lsof", ["-w", "-F", "pan", "--", ...files], env);
	// lsof exits 1 when some named file has no holder; anything on stderr is a real error.
	if ((code !== 0 && code !== 1) || stderr.trim()) return null;
	let pid = 0;
	let writable = false;
	for (const line of stdout.split("\n")) {
		const value = line.slice(1);
		if (line.startsWith("p")) pid = Number(value);
		else if (line.startsWith("a")) writable = value === "w" || value === "u";
		else if (line.startsWith("n") && writable && !ours.has(pid)) written.add(value);
	}
	return written;
}

/**
 * Ownership of each of `files` (absolute `.jsonl` paths). A step that fails makes every file whose
 * answer depended on it `unknown`; `free` needs every observation to have succeeded.
 */
export async function sessionOwnership(files: readonly string[]): Promise<Map<string, SessionOwnership>> {
	const result = new Map<string, SessionOwnership>();
	const unknownAll = (state: SessionOwnership) => {
		for (const file of files) result.set(file, state);
		return result;
	};
	if (files.length === 0) return result;
	if (process.platform === "win32") return unknownAll("unsupported");
	const env = await userEnv();
	const dir = join(agentDir(env), "terminal-sessions");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return unknownAll("unknown");
		names = [];
	}
	/** Breadcrumb terminal ids naming each file. */
	const crumbs = new Map<string, string[]>();
	try {
		await Promise.all(
			names.map(async name => {
				const [, file] = (await readFile(join(dir, name), "utf8")).split("\n");
				if (file) crumbs.set(file, [...(crumbs.get(file) ?? []), name]);
			}),
		);
	} catch {
		// A breadcrumb that vanished or cannot be read might have named any of the files.
		return unknownAll("unknown");
	}
	const ours = new Set(listHosts().flatMap(host => (host.pid ? [host.pid] : [])));
	ours.add(process.pid);
	const existing = (await Promise.all(files.map(async file => ((await stat(file).then(() => true, () => false)) ? file : null)))).filter(
		(file): file is string => file !== null,
	);
	const [terminals, written] = await Promise.all([ompTerminals(env, ours), writtenFiles(existing, env, ours)]);
	for (const file of files) {
		if (written?.has(file)) {
			result.set(file, "elsewhere");
			continue;
		}
		const ids = crumbs.get(file) ?? [];
		if (terminals && ids.some(id => terminals.has(id))) {
			result.set(file, "elsewhere");
			continue;
		}
		const unverifiable = ids.some(id => !/^(tty|pts-)/.test(id));
		result.set(file, !terminals || !written || !existing.includes(file) || unverifiable ? "unknown" : "free");
	}
	return result;
}
