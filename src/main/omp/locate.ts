import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { OmpStatus } from "@shared/ipc";
import { userEnv } from "../env";
import { getPrefs } from "../prefs";
import { compareSemver } from "@shared/semver";
import { OmpRefusedError, ompStartError } from "./refused";
import { resolveExecutable } from "../services/executable";

/** Oldest omp supported by visual-omp's native interface and collab handling. */
export const MIN_OMP_VERSION = "18.14.0";

const INSTALL_COMMAND =
	process.platform === "win32" ? "irm https://omp.sh/install.ps1 | iex" : "curl -fsSL https://omp.sh/install | sh";

/** omp's version, or null when it ran and failed or printed none; rejects when it could not start. */
function readVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
	const { promise, resolve, reject } = Promise.withResolvers<string | null>();
	try {
		execFile(bin, ["--version"], { env, timeout: 15000 }, (error, stdout) => {
			resolve(error ? null : (/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(stdout)?.[1] ?? null));
		});
	} catch (error) {
		reject(error);
	}
	return promise;
}

let cached: OmpStatus | null = null;

export async function ompStatus(refresh = false): Promise<OmpStatus> {
	if (cached && !refresh) return cached;
	const env = await userEnv();
	const override = getPrefs().ompPath;
	const path = override == null ? await resolveExecutable("omp", env) : resolve(override);
	const base = { minVersion: MIN_OMP_VERSION, installCommand: INSTALL_COMMAND, refused: false };
	if (!path) {
		cached = { ...base, found: false, path: null, version: null, supported: false, problem: "omp is not installed yet." };
		return cached;
	}
	let version: string | null = null;
	try {
		version = await readVersion(path, env);
	} catch (error) {
		const reason = await ompStartError(error, path);
		if (reason instanceof OmpRefusedError) {
			cached = { ...base, found: false, path, version: null, supported: false, refused: true, problem: reason.message };
			return cached;
		}
	}
	if (!version) {
		cached = { ...base, found: false, path, version: null, supported: false, problem: `omp at ${path} did not start.` };
		return cached;
	}
	const supported = compareSemver(version, MIN_OMP_VERSION) >= 0;
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

/** Resolved omp executable path; only the updater may run an unsupported version. */
export async function ompPath(options: { allowUnsupported?: boolean } = {}): Promise<string> {
	const status = await ompStatus();
	if (!status.found || !status.path || (!status.supported && !options.allowUnsupported)) {
		throw new Error(status.problem ?? "omp is not installed.");
	}
	return status.path;
}
