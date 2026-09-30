/**
 * Which saved sessions are open in an omp process outside this app, so they open read-only
 * (two writers must never share one session file).
 *
 * omp writes a breadcrumb per terminal under `<agentDir>/terminal-sessions/<terminal-id>`: line 1
 * is the cwd, line 2 the session file (docs/session.md). On macOS/Linux the terminal id is the tty
 * name, so a breadcrumb is live when that tty still runs an `omp` process.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { userEnv } from "../env";
import { listHosts } from "./host";
import { agentDir } from "./paths";

async function ttysRunningOmp(env: NodeJS.ProcessEnv): Promise<Set<string>> {
	const { promise, resolve } = Promise.withResolvers<string>();
	execFile("ps", ["-A", "-o", "tty=,comm="], { env, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (_error, stdout) =>
		resolve(stdout ?? ""),
	);
	const ttys = new Set<string>();
	for (const line of (await promise).split("\n")) {
		const match = /^\s*(\S+)\s+(.+)$/.exec(line);
		if (!match?.[1] || !match[2] || match[1] === "?" || match[1] === "??") continue;
		const command = basename(match[2].trim());
		if (command === "omp" || command === "omp.exe") ttys.add(match[1].replace(/\//g, "-"));
	}
	return ttys;
}

export async function sessionsOpenElsewhere(): Promise<string[]> {
	if (process.platform === "win32") return [];
	const env = await userEnv();
	const dir = join(agentDir(env), "terminal-sessions");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const [live, ours] = [await ttysRunningOmp(env), new Set(listHosts().map(host => host.sessionFile))];
	const files = new Set<string>();
	await Promise.all(
		names.map(async name => {
			// ps prints mac ttys as "s000" for /dev/ttys000 and Linux as "pts/3"; breadcrumbs use the device name.
			const tty = name.replace(/^tty(?=s\d)/, "");
			if (!live.has(name) && !live.has(tty)) return;
			try {
				const [, file] = (await readFile(join(dir, name), "utf8")).split("\n");
				if (file?.endsWith(".jsonl") && !ours.has(file)) files.add(file);
			} catch {}
		}),
	);
	return [...files];
}
