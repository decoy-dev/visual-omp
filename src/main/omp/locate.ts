import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { OmpStatus } from "@shared/ipc";
import { userEnv } from "../env";
import { getPrefs } from "../prefs";

/** Oldest omp with loopback collab relays and `omp collab list/link --json`. */
export const MIN_OMP_VERSION = "18.4.0";

const INSTALL_COMMAND =
	process.platform === "win32" ? "irm https://omp.sh/install.ps1 | iex" : "curl -fsSL https://omp.sh/install | sh";

function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

async function findOnPath(env: NodeJS.ProcessEnv): Promise<string | null> {
	const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
	const names = process.platform === "win32" ? ["omp.exe", "omp.cmd", "omp"] : ["omp"];
	for (const dir of (env[pathKey] ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
				return candidate;
			} catch {}
		}
	}
	return null;
}

function readVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(bin, ["--version"], { env, timeout: 15000 }, (error, stdout) => {
		resolve(error ? null : (/(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null));
	});
	return promise;
}

let cached: OmpStatus | null = null;

export async function ompStatus(refresh = false): Promise<OmpStatus> {
	if (cached && !refresh) return cached;
	const env = await userEnv();
	const override = getPrefs().ompPath;
	const path = override ?? (await findOnPath(env));
	const base = { minVersion: MIN_OMP_VERSION, installCommand: INSTALL_COMMAND };
	if (!path) {
		cached = { ...base, found: false, path: null, version: null, supported: false, problem: "omp is not installed yet." };
		return cached;
	}
	const version = await readVersion(path, env);
	if (!version) {
		cached = { ...base, found: false, path, version: null, supported: false, problem: `omp at ${path} did not start.` };
		return cached;
	}
	const supported = compareVersions(version, MIN_OMP_VERSION) >= 0;
	cached = {
		...base,
		found: true,
		path,
		version,
		supported,
		problem: supported ? null : `omp ${version} is too old. visual-omp needs ${MIN_OMP_VERSION} or newer.`,
	};
	return cached;
}

/** Resolved omp executable path; throws when omp is unavailable. */
export async function ompPath(): Promise<string> {
	const status = await ompStatus();
	if (!status.found || !status.path) throw new Error(status.problem ?? "omp is not installed.");
	return status.path;
}
