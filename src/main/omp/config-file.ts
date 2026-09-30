/**
 * The one writer of omp's YAML config files (`<agentDir>/config.yml`, `<cwd>/.omp/config.yml`).
 *
 * Edits go through the `yaml` Document API so the user's comments and formatting survive (omp's
 * own `omp config set` rewrites the file without them). After every write the config is re-loaded
 * by omp; when omp rejects it (a setting's own validation, e.g. non-positive request limits), the
 * previous bytes are restored and omp's error is thrown, so the app can never leave omp unable to
 * start. omp does NOT reject a value of the wrong type or outside an enum — it logs a warning and
 * uses the default — so callers check those first (`valueProblem` in `services/omp-config`).
 */
import type { Stats } from "node:fs";
import { chmod, realpath, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Document } from "yaml";
import type { JsonValue } from "@shared/contracts/config";
import { pathExists, readText, writeText } from "../files";
import { deleteDocumentPath, documentJson, ompErrorMessage, parseConfigDocument, setDocumentPath } from "../services/omp-config";
import { runOmp } from "./cli";

export type ConfigScope = "global" | "project";

/** Global config file names in omp's lookup order. */
const GLOBAL_CONFIG_NAMES = ["config.yml", "config.yaml"] as const;

let agentDirPromise: Promise<string> | null = null;

/**
 * Directory for omp runs that must not pick up any project layer (global-only reads/validation).
 * The system temp dir has no `.omp/`.
 */
export const NEUTRAL_CWD = tmpdir();

/** omp's agent dir exactly as omp resolves it (`PI_CODING_AGENT_DIR`, profiles, XDG layout). */
export function ompAgentDir(): Promise<string> {
	agentDirPromise ??= runOmp(["config", "path"], { cwd: NEUTRAL_CWD }).then(result => {
		const dir = result.stdout.trim();
		if (result.code !== 0 || !dir) {
			agentDirPromise = null;
			throw new Error(ompErrorMessage(result.stderr, "omp config path failed"));
		}
		return dir;
	});
	return agentDirPromise;
}

/** Config file of a scope. Global: `config.yml`, or an existing `config.yaml`. Project: `<cwd>/.omp/config.yml` (the only project YAML omp reads). */
export async function configFile(scope: ConfigScope, cwd?: string): Promise<string> {
	if (scope === "project") {
		if (!cwd) throw new Error("A project folder is required for project settings");
		return join(cwd, ".omp", "config.yml");
	}
	const dir = await ompAgentDir();
	for (const name of GLOBAL_CONFIG_NAMES) {
		const file = join(dir, name);
		if (await pathExists(file)) return file;
	}
	return join(dir, GLOBAL_CONFIG_NAMES[0]);
}

async function readIfPresent(file: string): Promise<string | null> {
	try {
		return await readText(file);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

/** Parsed contents of a scope's config file; `{}` when it does not exist. Throws on invalid YAML. */
export async function readConfig(scope: ConfigScope, cwd?: string): Promise<{ file: string; data: { [key: string]: JsonValue } }> {
	const file = await configFile(scope, cwd);
	const text = await readIfPresent(file);
	if (text === null) return { file, data: {} };
	try {
		return { file, data: documentJson(parseConfigDocument(text)) };
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Size+mtime of files this process wrote last, so watchers can skip the app's own writes. */
const ownWrites = new Map<string, { size: number; mtimeMs: number }>();

async function rememberWrite(files: readonly string[]): Promise<void> {
	const stats = await stat(files[0] ?? "").catch(() => null);
	for (const file of files) {
		if (stats) ownWrites.set(file, { size: stats.size, mtimeMs: stats.mtimeMs });
		else ownWrites.delete(file);
	}
}

/** True (once) when `stats` of `file` are exactly what the app itself last wrote. */
export function isOwnWrite(file: string, stats: Stats): boolean {
	const own = ownWrites.get(file);
	if (!own || own.size !== stats.size || own.mtimeMs !== stats.mtimeMs) return false;
	ownWrites.delete(file);
	return true;
}

/** Per-file tail of queued edits: edits to one file never interleave within this process. */
const editQueues = new Map<string, Promise<unknown>>();

/**
 * Apply `edit` to a scope's config file and persist it atomically (following a symlinked config
 * to its target). Refuses unparseable YAML. After writing, omp re-loads the config in `cwd`; if it
 * refuses it, the file is restored and omp's message thrown. A no-op edit writes nothing.
 */
export async function editConfig(scope: ConfigScope, cwd: string | undefined, edit: (doc: Document) => void): Promise<void> {
	const file = await configFile(scope, cwd);
	const target = await realpath(file).catch(() => file);
	const previous = editQueues.get(target) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(() => editLocked(file, target, cwd, edit));
	editQueues.set(target, run);
	try {
		await run;
	} finally {
		if (editQueues.get(target) === run) editQueues.delete(target);
	}
}

async function editLocked(file: string, target: string, cwd: string | undefined, edit: (doc: Document) => void): Promise<void> {
	const original = await readIfPresent(target);
	let doc: Document;
	try {
		doc = parseConfigDocument(original ?? "");
	} catch (error) {
		throw new Error(`Not editing ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	edit(doc);
	const next = doc.toString();
	if (next === (original ?? "")) return;
	const mode = original === null ? 0o600 : (await stat(target)).mode & 0o777;
	await writeText(target, next);
	await chmod(target, mode);
	await rememberWrite([file, target]);

	const check = await runOmp(["config", "path"], { cwd: cwd ?? NEUTRAL_CWD });
	if (check.code === 0) return;
	if (original === null) await unlink(target);
	else {
		await writeText(target, original);
		await chmod(target, mode);
	}
	await rememberWrite([file, target]);
	throw new Error(`omp rejected the change: ${ompErrorMessage(check.stderr, file)}`);
}

/** Set `path` (config keys, e.g. `["tools", "approval", "bash"]`) to `value`. */
export function setConfigPath(scope: ConfigScope, cwd: string | undefined, path: readonly string[], value: JsonValue): Promise<void> {
	return editConfig(scope, cwd, doc => setDocumentPath(doc, path, value));
}

/** Remove `path` (pruning mappings left empty). Resolves whether the key existed. */
export async function deleteConfigPath(scope: ConfigScope, cwd: string | undefined, path: readonly string[]): Promise<boolean> {
	let removed = false;
	await editConfig(scope, cwd, doc => {
		removed = deleteDocumentPath(doc, path);
	});
	return removed;
}
