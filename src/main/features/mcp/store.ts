/**
 * File-level writes for omp-native MCP configs: serialized read-modify-write per file, omp's serialization and
 * permissions (dir 0700, file 0600), and omp's enable/disable resolution (`setMcpServerEnabled`).
 *
 * omp guards the same files with an OS `flock` (`<file>.lock`), which Node cannot take; writes here are serialized
 * within this process and are atomic (temp file + rename), so omp never reads a torn file.
 */
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpToggleMechanism, McpToggleResult } from "@shared/contracts/mcp";
import { writeText } from "../../files";
import { JsonRecord, normalizeEntry, validateServerConfig } from "./config";
import {
	type McpDocument,
	type OverrideList,
	overrideList,
	parseDocument,
	serializeDocument,
	serverMap,
	setListMember,
	shapeError,
} from "./document";

const queues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier operation on `file` has settled. */
function serialized<T>(file: string, fn: () => Promise<T>): Promise<T> {
	const run = (queues.get(file) ?? Promise.resolve()).then(fn, fn);
	const settled = run.catch(() => undefined);
	queues.set(file, settled);
	void settled.then(() => {
		if (queues.get(file) === settled) queues.delete(file);
	});
	return run;
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** File text, or null when it does not exist. */
export async function readOptional(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

/** omp's `readMCPConfigFile`: a missing file reads as `{ mcpServers: {} }`; broken files throw. */
export async function readDocument(file: string): Promise<McpDocument> {
	const text = await readOptional(file);
	if (text === null) return { mcpServers: {} };
	try {
		return parseDocument(text);
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}. Fix the file before editing it.`);
	}
}

async function writeContent(file: string, content: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	await writeText(file, content);
	await chmod(file, 0o600);
}

/** Read-modify-write one document under the per-file queue. */
export function mutateDocument(file: string, change: (doc: McpDocument) => McpDocument): Promise<void> {
	return serialized(file, async () => {
		const doc = await readDocument(file);
		await writeContent(file, serializeDocument(change(doc)));
	});
}

/** Replace a file with raw editor text after checking it is a well-shaped MCP config. */
export async function writeRawDocument(file: string, content: string): Promise<void> {
	const shape = shapeError(parseDocument(content));
	if (shape) throw new Error(`Invalid MCP config: ${shape}`);
	await serialized(file, () => writeContent(file, content));
}

/** Toggle inputs, as omp's `SetMcpServerEnabledOptions`. */
export interface ToggleOptions {
	userPath: string;
	projectPath: string | null;
	/** Only omp-owned files; the caller filters foreign paths out. */
	sourcePath?: string;
	name: string;
	enabled: boolean;
}

async function hasListMember(file: string, key: OverrideList, name: string): Promise<boolean> {
	return overrideList(await readDocument(file), key).includes(name);
}

/**
 * omp's `setMcpServerEnabled`: write `enabled` on the first omp-owned file defining the server (source, project,
 * user); otherwise fall back to the user `disabledServers` / `enabledServers` lists. Stale opposite overrides are
 * always cleaned up.
 */
export async function setServerEnabled(options: ToggleOptions): Promise<McpToggleResult> {
	const { userPath, projectPath, sourcePath, name, enabled } = options;
	const candidates = [...new Set([sourcePath, projectPath, userPath].filter(path => typeof path === "string"))];
	const changedPaths = new Set<string>();
	let fieldPath: string | null = null;

	for (const file of candidates) {
		const entry = serverMap(await readDocument(file))[name];
		if (entry === undefined) continue;
		await mutateDocument(file, doc => {
			const current = JsonRecord.safeParse(serverMap(doc)[name]);
			const raw = current.success ? current.data : {};
			const errors = validateServerConfig(name, { ...normalizeEntry(raw, "native", []), enabled });
			if (errors.length > 0) throw new Error(`Invalid server config: ${errors.join("; ")}`);
			return { ...doc, mcpServers: { ...serverMap(doc), [name]: { ...raw, enabled } } };
		});
		changedPaths.add(file);
		fieldPath = file;
		break;
	}

	const setList = async (key: OverrideList, present: boolean): Promise<void> => {
		await mutateDocument(userPath, doc => setListMember(doc, key, name, present));
		changedPaths.add(userPath);
	};

	let mechanism: McpToggleMechanism = "field";
	if (enabled) {
		if (await hasListMember(userPath, "disabledServers", name)) await setList("disabledServers", false);
		const isForced = await hasListMember(userPath, "enabledServers", name);
		if (!fieldPath) {
			mechanism = "enabledServers";
			if (!isForced) await setList("enabledServers", true);
		} else if (isForced) {
			await setList("enabledServers", false);
		}
	} else {
		if (await hasListMember(userPath, "enabledServers", name)) await setList("enabledServers", false);
		if (!fieldPath) {
			mechanism = "disabledServers";
			await setList("disabledServers", true);
		}
	}
	return { name, enabled, mechanism, changedPaths: [...changedPaths] };
}
