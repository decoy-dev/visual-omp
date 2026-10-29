/**
 * Whether a saved session is open in an omp process outside this app, so it opens read-only (two
 * writers must never share one session file).
 *
 * omp 18.14 holds an OS lease keyed by the session header id. Read that lease first:
 * a flock sidecar on macOS, an abstract socket on Linux, or a named mutex on Windows.
 * Lease sidecars are persistent, so their existence alone never establishes ownership.
 * If the header or lease cannot be read, use writable descriptors and terminal breadcrumbs
 * as a conservative fallback. An unreadable fallback keeps the answer unknown.
 */
import { execFile } from "node:child_process";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SessionOwnership } from "@shared/ipc";
import { userEnv } from "../env";
import { listHosts } from "./host";
import { agentDir } from "./paths";
import { leaseMemoryName } from "./lease-name";
import { resolveExecutable } from "../services/executable";

interface Run {
	stdout: string;
	stderr: string;
	/** Exit code; null when the process could not start, timed out or overflowed its buffer. */
	code: number | null;
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
	const executable = await resolveExecutable(command, env);
	if (!executable) return { stdout: "", stderr: "", code: null };
	const { promise, resolve } = Promise.withResolvers<Run>();
	execFile(executable, args, { env, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
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

/** Read only omp's bounded header prefix, including its optional title slot. */
async function headerId(file: string): Promise<string | null> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
		for (const line of lines.slice(0, 2)) {
			const entry: unknown = JSON.parse(line ?? "");
			if (!entry || typeof entry !== "object" || !("type" in entry)) return null;
			if (entry.type === "session" && "id" in entry && typeof entry.id === "string") return entry.id;
			if (entry.type !== "title") return null;
		}
		return null;
	} finally {
		await handle.close();
	}
}

/** Machine-global leases ignore PI_CODING_AGENT_DIR and profile selection, as omp does. */
async function ownersDir(env: NodeJS.ProcessEnv): Promise<string | null> {
	if (env.PI_TEST_SESSION_OWNERS_DIR) return resolve(env.PI_TEST_SESSION_OWNERS_DIR);
	if ((process.platform === "linux" || process.platform === "darwin") && env.XDG_STATE_HOME) {
		const root = join(env.XDG_STATE_HOME, "omp");
		try {
			await stat(root);
			return join(root, "run", "session-owners");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) return null;
		}
	}
	return join(homedir(), env.PI_CONFIG_DIR || ".omp", "run", "session-owners");
}

/** null requests the descriptor/breadcrumb fallback, without acquiring or modifying any lease. */
async function leaseOwnership(file: string, dir: string, env: NodeJS.ProcessEnv, ours: ReadonlySet<number>): Promise<SessionOwnership | null> {
	try {
		const id = await headerId(file);
		// omp hashes non-token ids with Bun.wyhash; these unusual headers use the fallback.
		if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
		const sidecar = resolve(dir, `${id}.lock`);
		if (process.platform === "linux") {
			const sockets = await readFile("/proc/net/unix", "utf8");
			if (!/^\s*Num\s+RefCount\s+Protocol\s+Flags\s+Type\s+St\s+Inode\s+Path/.test(sockets)) return null;
			const name = `@${leaseMemoryName(sidecar)}`;
			return sockets.split("\n").some(line => line.trim().split(/\s+/).at(7) === name) ? "elsewhere" : "free";
		}
		if (process.platform === "win32") {
			// omp's mutex is held by object lifetime, without thread-affine mutex ownership.
			// OpenExisting only observes the object and never creates or waits on it.
			const name = `Global\\${leaseMemoryName(sidecar)}`;
			const script = `$ErrorActionPreference='Stop'; try { $m=[System.Threading.Mutex]::OpenExisting('${name}',[System.Security.AccessControl.MutexRights]::Synchronize); $m.Dispose(); 'held' } catch [System.Threading.WaitHandleCannotBeOpenedException] { 'free' }`;
			const reply = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], env);
			if (reply.code !== 0 || reply.stderr.trim()) return null;
			return reply.stdout.trim() === "held" ? "elsewhere" : reply.stdout.trim() === "free" ? "free" : null;
		}
		try {
			const parent = await lstat(dir);
			if (!parent.isDirectory() || (process.getuid && parent.uid !== process.getuid()) || (parent.mode & 0o077) !== 0) return null;
			await stat(sidecar);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return "free";
			return null;
		}
		// Darwin's lsof does not expose flock state. omp retains this descriptor only
		// while holding the lease; failed contenders immediately close theirs.
		const reply = await run("lsof", ["-w", "-F", "p", "--", sidecar], env);
		if ((reply.code !== 0 && reply.code !== 1) || reply.stderr.trim()) return null;
		return reply.stdout.split("\n").some(line => /^p\d+$/.test(line) && !ours.has(Number(line.slice(1)))) ? "elsewhere" : "free";
	} catch {
		return null;
	}
}

/** Prefer the session-id lease, falling back only for files whose lease could not be read. */
export async function sessionOwnership(files: readonly string[]): Promise<Map<string, SessionOwnership>> {
	const result = new Map<string, SessionOwnership>();
	if (!files.length) return result;
	const env = await userEnv();
	const dir = await ownersDir(env);
	const ours = new Set(listHosts().flatMap(host => (host.pid ? [host.pid] : [])));
	ours.add(process.pid);
	const fallback: string[] = [];
	await Promise.all(files.map(async file => {
		const ownership = dir ? await leaseOwnership(file, dir, env, ours) : null;
		if (ownership) result.set(file, ownership);
		else fallback.push(file);
	}));
	if (fallback.length) for (const [file, ownership] of await fallbackOwnership(fallback, env, ours)) result.set(file, ownership);
	return result;
}

/** Legacy observations are best effort; free requires every required observation to succeed. */
async function fallbackOwnership(files: readonly string[], env: NodeJS.ProcessEnv, ours: ReadonlySet<number>): Promise<Map<string, SessionOwnership>> {
	const result = new Map<string, SessionOwnership>();
	const unknownAll = (state: SessionOwnership) => {
		for (const file of files) result.set(file, state);
		return result;
	};
	if (process.platform === "win32") return unknownAll("unknown");
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
