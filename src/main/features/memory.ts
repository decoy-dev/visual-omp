import type { MemoryStatus } from "@shared/contracts/memory";
import { userEnv } from "../env";
import { handle } from "../ipc";
import { runOmpJson } from "../omp/cli";
import { listProjects } from "../omp/sessions";
import { memoriesDir } from "./memory/paths";
import { memoryStatus, parseMemorySettings } from "./memory/settings";
import { deleteEntry, listEntries, listScopes, type MemoryContext, readEntry, scopesForProject } from "./memory/store";

/** Browsing fires several calls in a row (scopes → list → read); reuse one settings read for them. */
const CONTEXT_TTL_MS = 5000;

let cached: { at: number; context: Promise<MemoryContext> } | null = null;

async function loadContext(): Promise<MemoryContext> {
	const [env, config, projects] = await Promise.all([
		userEnv(),
		runOmpJson(["config", "list", "--json"], { timeoutMs: 30_000 }),
		listProjects(),
	]);
	return {
		memoriesDir: await memoriesDir(env),
		settings: parseMemorySettings(config),
		knownCwds: projects.map(project => project.path),
	};
}

function context(): Promise<MemoryContext> {
	if (!cached || Date.now() - cached.at > CONTEXT_TTL_MS) {
		const entry = { at: Date.now(), context: loadContext() };
		// A failed load must not be served from the cache.
		entry.context.catch(() => {
			if (cached === entry) cached = null;
		});
		cached = entry;
	}
	return cached.context;
}

export function register(): void {
	handle("memory:status", async (): Promise<MemoryStatus> => {
		const ctx = await context();
		return memoryStatus(ctx.settings, ctx.memoriesDir);
	});
	handle("memory:scopes", async backend => listScopes(await context(), backend));
	handle("memory:forProject", async cwd => scopesForProject(await context(), cwd));
	handle("memory:list", async (scopeId, options) => listEntries(await context(), scopeId, options));
	handle("memory:read", async entryId => readEntry(await context(), entryId));
	handle("memory:delete", async entryId => deleteEntry(await context(), entryId));
}
