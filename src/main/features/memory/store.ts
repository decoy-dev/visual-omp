import { basename, join } from "node:path";
import type {
	MemoryEntry,
	MemoryListOptions,
	MemoryListResult,
	MemoryScope,
	StoredMemoryBackend,
} from "@shared/contracts/memory";
import { pathExists } from "../../files";
import { paginate } from "./common";
import { deleteLocalEntry, localEntries, localScopes } from "./local";
import {
	deleteMnemopiEntry,
	listMnemopiEntries,
	mnemopiBankPath,
	mnemopiScopes,
	readMnemopiEntry,
} from "./mnemopi";
import {
	entryId,
	type ScopeRef,
	localScopeKey,
	MNEMOPI_SHARED_KEY,
	mnemopiProjectBank,
	parseEntryId,
	parseScopeId,
	projectBankSegment,
	scopeId,
} from "./paths";
import { type MemorySettings, mnemopiDbPath } from "./settings";
import { deleteSharpshooterEntry, sharpshooterEntries, sharpshooterScopes } from "./sharpshooter";

/** Everything the memory browser needs to locate storage. */
export interface MemoryContext {
	memoriesDir: string;
	settings: MemorySettings;
	/** Project directories known from omp sessions, used to label scopes with their project. */
	knownCwds: readonly string[];
}

const STORED_BACKENDS: readonly StoredMemoryBackend[] = ["local", "mnemopi", "sharpshooter"];

const sharpshooterRoot = (ctx: MemoryContext): string => join(ctx.memoriesDir, "sharpshooter");

export async function listScopes(ctx: MemoryContext, backend?: StoredMemoryBackend): Promise<MemoryScope[]> {
	const scopes: MemoryScope[] = [];
	for (const each of backend ? [backend] : STORED_BACKENDS) {
		const active = ctx.settings.backend === each;
		const { knownCwds } = ctx;
		if (each === "local") scopes.push(...(await localScopes(ctx.memoriesDir, knownCwds, active)));
		else if (each === "sharpshooter") scopes.push(...(await sharpshooterScopes(sharpshooterRoot(ctx), knownCwds, active)));
		else {
			const dbPath = mnemopiDbPath(ctx.settings, ctx.memoriesDir);
			scopes.push(...(await mnemopiScopes({ dbPath, bank: ctx.settings.mnemopi.bank, knownCwds, active })));
		}
	}
	return scopes.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Storage path of a scope that may not exist yet. */
function scopePath(ctx: MemoryContext, ref: ScopeRef): string {
	if (ref.backend === "local") return join(ctx.memoriesDir, ref.key);
	if (ref.backend === "sharpshooter") return join(sharpshooterRoot(ctx), ref.key);
	return mnemopiBankPath(mnemopiDbPath(ctx.settings, ctx.memoriesDir), ref.key);
}

/** The scopes the active backend reads for `cwd`, existing or not. */
export async function scopesForProject(ctx: MemoryContext, cwd: string): Promise<MemoryScope[]> {
	const { backend } = ctx.settings;
	if (backend !== "local" && backend !== "mnemopi" && backend !== "sharpshooter") return [];
	const known = await listScopes({ ...ctx, knownCwds: [...new Set([...ctx.knownCwds, cwd])] }, backend);
	const keys: string[] = [];
	if (backend === "local") keys.push(localScopeKey(cwd));
	else if (backend === "sharpshooter") keys.push(projectBankSegment(cwd));
	else {
		const { scoping, bank } = ctx.settings.mnemopi;
		if (scoping !== "global") keys.push(mnemopiProjectBank(bank, cwd));
		if (scoping !== "per-project") keys.push(MNEMOPI_SHARED_KEY);
		// omp also recalls legacy banks whose rows all come from this cwd (except under `global`).
		if (scoping !== "global") {
			for (const scope of known) if (!scope.global && scope.cwd === cwd) keys.push(parseScopeId(scope.id).key);
		}
	}
	const result: MemoryScope[] = [];
	for (const key of new Set(keys)) {
		const ref: ScopeRef = { backend, key };
		const id = scopeId(ref);
		const existing = known.find(scope => scope.id === id);
		if (existing) {
			result.push(existing);
			continue;
		}
		const path = scopePath(ctx, ref);
		const global = key === MNEMOPI_SHARED_KEY;
		result.push({
			id,
			backend,
			active: true,
			name: global ? "Shared bank" : basename(cwd) || cwd,
			cwd: global ? null : cwd,
			global,
			path,
			exists: await pathExists(path),
			entryCount: 0,
			updatedAt: null,
		});
	}
	return result;
}

export async function listEntries(ctx: MemoryContext, id: string, options: MemoryListOptions = {}): Promise<MemoryListResult> {
	const ref = parseScopeId(id);
	const path = scopePath(ctx, ref);
	if (!(await pathExists(path))) return { entries: [], total: 0 };
	if (ref.backend === "local") return paginate(await localEntries(ctx.memoriesDir, ref.key), options);
	if (ref.backend === "sharpshooter") return paginate(await sharpshooterEntries(sharpshooterRoot(ctx), ref.key), options);
	return listMnemopiEntries(path, ref.key, options);
}

export async function readEntry(ctx: MemoryContext, id: string): Promise<MemoryEntry> {
	const ref = parseEntryId(id);
	if (ref.backend === "mnemopi") return readMnemopiEntry(scopePath(ctx, ref), ref);
	const entries =
		ref.backend === "local"
			? await localEntries(ctx.memoriesDir, ref.key)
			: await sharpshooterEntries(sharpshooterRoot(ctx), ref.key);
	const wanted = entryId(ref);
	const entry = entries.find(each => each.id === wanted);
	if (!entry) throw new Error("Memory not found");
	return entry;
}

export async function deleteEntry(ctx: MemoryContext, id: string): Promise<void> {
	const ref = parseEntryId(id);
	if (ref.backend === "local") return deleteLocalEntry(ctx.memoriesDir, ref);
	if (ref.backend === "sharpshooter") return deleteSharpshooterEntry(sharpshooterRoot(ctx), ref);
	const path = scopePath(ctx, ref);
	if (!(await pathExists(path))) throw new Error("Memory bank not found");
	deleteMnemopiEntry(path, ref);
}
