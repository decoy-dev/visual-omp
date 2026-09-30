import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { z } from "zod";
import type {
	McpDiscoverySettings,
	McpFileInfo,
	McpListResult,
	McpServerConfig,
	McpTarget,
	McpToggleOptions,
	McpToggleResult,
} from "@shared/contracts/mcp";
import { userEnv } from "../env";
import { broadcast, handle } from "../ipc";
import { runOmpJson } from "../omp/cli";
import { agentDir } from "../omp/paths";
import { testServer } from "./mcp/client";
import { discoverServers, ompOwnedPaths, resolveEntries } from "./mcp/discovery";
import { addServer, overrideList, parseDocument, removeServer, shapeError, updateServer } from "./mcp/document";
import { MCP_PRESETS, buildPresetConfig } from "./mcp/presets";
import { mutateDocument, readDocument, readOptional, setServerEnabled, writeRawDocument } from "./mcp/store";

const DEFAULT_TEST_TIMEOUT_MS = 20_000;

const ConfigList = z.record(z.string(), z.looseObject({ value: z.unknown() }));
const Flag = (fallback: boolean) => z.boolean().catch(fallback);
const Names = z.array(z.string()).catch([]);

/** The omp settings that shape MCP discovery (`omp config list --json`, which merges project overrides for `cwd`). */
async function discoverySettings(cwd: string | null): Promise<{ settings: McpDiscoverySettings; warning: string | null }> {
	const defaults: McpDiscoverySettings = {
		enableProjectConfig: true,
		browserEnabled: true,
		enabledProviders: [],
		disabledProviders: [],
		disabledExtensions: [],
	};
	try {
		const list = ConfigList.parse(await runOmpJson(["config", "list", "--json"], { cwd: cwd ?? undefined, timeoutMs: 20_000 }));
		return {
			settings: {
				enableProjectConfig: Flag(true).parse(list["mcp.enableProjectConfig"]?.value),
				browserEnabled: Flag(true).parse(list["browser.enabled"]?.value),
				enabledProviders: Names.parse(list.enabledProviders?.value),
				disabledProviders: Names.parse(list.disabledProviders?.value),
				disabledExtensions: Names.parse(list.disabledExtensions?.value),
			},
			warning: null,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { settings: defaults, warning: `Could not read omp settings (${reason}); assuming defaults` };
	}
}

async function paths(): Promise<{ env: NodeJS.ProcessEnv; agentDir: string; userPath: string }> {
	const env = await userEnv();
	const dir = agentDir(env);
	return { env, agentDir: dir, userPath: join(dir, "mcp.json") };
}

async function targetPath(target: McpTarget): Promise<string> {
	return target.scope === "user" ? (await paths()).userPath : join(target.cwd, ".omp", "mcp.json");
}

async function listServers(cwd: string | null): Promise<McpListResult> {
	const [{ env, agentDir: dir, userPath }, { settings, warning }] = await Promise.all([paths(), discoverySettings(cwd)]);
	const projectPath = cwd ? join(cwd, ".omp", "mcp.json") : null;
	const warnings = warning ? [warning] : [];
	const { rows, sources } = await discoverServers({ cwd, home: homedir(), agentDir: dir, env, settings, readFile: readOptional });
	let userDoc: Record<string, unknown> = {};
	try {
		userDoc = await readDocument(userPath);
	} catch (error) {
		warnings.push(`User MCP config ignored for disabledServers/enabledServers: ${error instanceof Error ? error.message : String(error)}`);
	}
	const disabledServers = overrideList(userDoc, "disabledServers");
	const enabledServers = overrideList(userDoc, "enabledServers");
	const servers = resolveEntries(rows, {
		settings,
		disabledServers,
		enabledServers,
		editablePaths: projectPath ? [userPath, projectPath] : [userPath],
	});
	return { cwd, userPath, projectPath, servers, sources, disabledServers, enabledServers, settings, warnings };
}

async function readFileInfo(target: McpTarget): Promise<McpFileInfo> {
	const path = await targetPath(target);
	const content = await readOptional(path);
	let error: string | null = null;
	if (content !== null) {
		try {
			error = shapeError(parseDocument(content));
		} catch (parseError) {
			error = parseError instanceof Error ? parseError.message : String(parseError);
		}
	}
	return { scope: target.scope, path, exists: content !== null, content, error };
}

async function edit(target: McpTarget, change: (doc: Record<string, unknown>, file: string) => Record<string, unknown>) {
	const path = await targetPath(target);
	await mutateDocument(path, doc => change(doc, path));
	broadcast("mcp:changed", { paths: [path] });
}

async function toggle(name: string, enabled: boolean, options: McpToggleOptions = {}): Promise<McpToggleResult> {
	const { agentDir: dir, userPath } = await paths();
	const cwd = options.cwd ?? null;
	const owned = ompOwnedPaths(cwd, dir);
	const result = await setServerEnabled({
		userPath,
		projectPath: cwd ? join(cwd, ".omp", "mcp.json") : null,
		sourcePath: options.sourcePath && owned.includes(options.sourcePath) ? options.sourcePath : undefined,
		name,
		enabled,
	});
	if (result.changedPaths.length > 0) broadcast("mcp:changed", { paths: result.changedPaths });
	return result;
}

export function register(): void {
	handle("mcp:list", cwd => listServers(cwd));
	handle("mcp:file:read", target => readFileInfo(target));
	handle("mcp:file:write", async (target, content) => {
		const path = await targetPath(target);
		await writeRawDocument(path, content);
		broadcast("mcp:changed", { paths: [path] });
		return readFileInfo(target);
	});
	handle("mcp:add", (target, name, config) => edit(target, (doc, file) => addServer(doc, name, config, file)));
	handle("mcp:update", (target, name, config, newName) =>
		edit(target, (doc, file) => updateServer(doc, name, config, file, newName)),
	);
	handle("mcp:remove", (target, name) => edit(target, (doc, file) => removeServer(doc, name, file)));
	handle("mcp:enable", (name, options) => toggle(name, true, options));
	handle("mcp:disable", (name, options) => toggle(name, false, options));
	handle("mcp:test", async (config: McpServerConfig, options = {}) =>
		testServer({
			config,
			cwd: options.cwd,
			timeoutMs: options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
			env: await userEnv(),
			clientInfo: { name: "visual-omp", version: app.getVersion() },
		}),
	);
	handle("mcp:presets", () => MCP_PRESETS);
	handle("mcp:preset:build", (presetId, values) => {
		const preset = MCP_PRESETS.find(item => item.id === presetId);
		if (!preset) throw new Error(`Unknown MCP preset: ${presetId}`);
		return buildPresetConfig(preset, values);
	});
}
