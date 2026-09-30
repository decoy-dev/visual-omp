/**
 * Multi-source MCP discovery with omp's exact precedence and filtering:
 * provider order (capability/index.ts priorities), per-provider file order, user-source opt-in
 * (`isUserSourceEnabled`), then `loadAllMCPConfigs` (mcp/config.ts): extension disables, project exclusion,
 * `disabledServers` / `enabled: false` suppression with key claiming, name/equivalence dedupe, capability
 * validation, Exa and browser filters.
 */
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import type {
	McpDiscoverySettings,
	McpProviderId,
	McpScope,
	McpServerEntry,
	McpServerStatus,
	McpSourceFile,
} from "@shared/contracts/mcp";
import {
	type FileParse,
	buildOpenCodeServer,
	mergeRecords,
	parseCodexToml,
	parseMcpServersJson,
	parseOpenCodeLayer,
	parseVscodeJson,
	substituteOpenCodeVars,
} from "./sources";
import { JsonRecord, type ParsedServer, capabilityError, transportOf } from "./config";

export interface DiscoveryContext {
	/** Project directory; null = user scope only. */
	cwd: string | null;
	home: string;
	agentDir: string;
	env: NodeJS.ProcessEnv;
	settings: McpDiscoverySettings;
	/** File text, or null when the file does not exist. Throws for other read errors. */
	readFile: (path: string) => Promise<string | null>;
}

/** One discovered entry before status resolution, in precedence order. */
export interface DiscoveredRow {
	server: ParsedServer;
	provider: McpProviderId;
	providerName: string;
	path: string;
	level: McpScope;
}

export interface DiscoveryResult {
	rows: DiscoveredRow[];
	sources: McpSourceFile[];
}

const PROVIDER_NAMES: Record<McpProviderId, string> = {
	native: "OMP",
	claude: "Claude Code",
	codex: "OpenAI Codex",
	gemini: "Gemini CLI",
	opencode: "OpenCode",
	cursor: "Cursor",
	windsurf: "Windsurf",
	vscode: "VS Code",
	"mcp-json": "MCP Config",
};

/** Foreign tools whose `~/` configs omp only reads when opted in via `enabledProviders`. */
const FOREIGN_USER_PROVIDERS: Record<string, true> = {
	claude: true,
	codex: true,
	gemini: true,
	opencode: true,
	cursor: true,
	windsurf: true,
};

/** Files omp owns (and writes `enabled` into): native files plus the root fallbacks. */
export function ompOwnedPaths(cwd: string | null, agentDir: string): string[] {
	const paths = [join(agentDir, "mcp.json"), join(agentDir, ".mcp.json")];
	if (cwd) {
		paths.unshift(join(cwd, ".omp", "mcp.json"), join(cwd, ".omp", ".mcp.json"));
		paths.push(join(cwd, "mcp.json"), join(cwd, ".mcp.json"));
	}
	return paths;
}

interface PlannedFile {
	path: string;
	level: McpScope;
	parse: (text: string) => FileParse | Promise<FileParse>;
}

/** Runs the file plan for one provider and records every file as a source. */
class ProviderLoader {
	readonly rows: DiscoveredRow[] = [];
	readonly sources: McpSourceFile[] = [];

	constructor(
		private readonly ctx: DiscoveryContext,
		private readonly provider: McpProviderId,
	) {}

	get disabled(): boolean {
		return this.ctx.settings.disabledProviders.includes(this.provider);
	}

	/** omp's `isUserSourceEnabled`. */
	userEnabled(): boolean {
		if (this.disabled) return false;
		if (!FOREIGN_USER_PROVIDERS[this.provider]) return true;
		const enabled = this.ctx.settings.enabledProviders;
		if (enabled.includes(this.provider) || enabled.includes("*") || enabled.includes("all")) return true;
		return this.provider === "claude" && Boolean(this.ctx.env.CLAUDE_CONFIG_DIR?.trim());
	}

	skipReason(file: { level: McpScope }): string | null {
		if (this.disabled) return `The ${PROVIDER_NAMES[this.provider]} provider is disabled (disabledProviders)`;
		if (file.level === "user" && !this.userEnabled()) {
			return `User-level ${PROVIDER_NAMES[this.provider]} config is opt-in: add "${this.provider}" to omp's enabledProviders`;
		}
		return null;
	}

	/** Record the file as a source and read it; `text` is null when missing, unreadable or skipped. */
	async read(file: { path: string; level: McpScope }): Promise<{ source: McpSourceFile; text: string | null }> {
		const source: McpSourceFile = {
			provider: this.provider,
			providerName: PROVIDER_NAMES[this.provider],
			path: file.path,
			level: file.level,
			exists: false,
			loaded: false,
			skippedReason: this.skipReason(file),
			error: null,
			serverCount: 0,
		};
		this.sources.push(source);
		let text: string | null;
		try {
			text = await this.ctx.readFile(file.path);
		} catch (error) {
			source.exists = true;
			source.error = error instanceof Error ? error.message : String(error);
			return { source, text: null };
		}
		source.exists = text !== null;
		source.loaded = text !== null && !source.skippedReason;
		return { source, text: source.loaded ? text : null };
	}

	/** Read and parse one file; returns its servers when it contributes. */
	async load(file: PlannedFile): Promise<{ source: McpSourceFile; servers: ParsedServer[] }> {
		const { source, text } = await this.read(file);
		if (text === null) return { source, servers: [] };
		const parsed = await file.parse(text);
		source.error = parsed.error;
		source.serverCount = parsed.servers.length;
		return { source, servers: parsed.servers };
	}

	push(servers: ParsedServer[], file: { path: string; level: McpScope }): void {
		for (const server of servers) {
			this.rows.push({
				server,
				provider: this.provider,
				providerName: PROVIDER_NAMES[this.provider],
				path: file.path,
				level: file.level,
			});
		}
	}

	/** Load files in order, every file contributing. */
	async all(files: PlannedFile[]): Promise<void> {
		for (const file of files) this.push((await this.load(file)).servers, file);
	}

	/** Claude Code: only the first file with servers counts, per level. */
	async firstNonEmpty(files: PlannedFile[]): Promise<void> {
		let winner: string | null = null;
		for (const file of files) {
			const { source, servers } = await this.load(file);
			if (winner) {
				if (source.loaded) {
					source.loaded = false;
					source.skippedReason = `${PROVIDER_NAMES[this.provider]} reads only the first non-empty file (${winner})`;
				}
				continue;
			}
			if (servers.length > 0) {
				winner = file.path;
				this.push(servers, file);
			}
		}
	}
}

/** Discover every entry omp would consider for `ctx.cwd`, in precedence order (first wins). */
export async function discoverServers(ctx: DiscoveryContext): Promise<DiscoveryResult> {
	const { cwd, home, agentDir, env } = ctx;
	const project = (...parts: string[]): string | null => (cwd ? join(cwd, ...parts) : null);
	const planned = (entries: Array<[string | null, McpScope, PlannedFile["parse"]]>): PlannedFile[] =>
		entries.flatMap(([path, level, parse]) => (path ? [{ path, level, parse }] : []));
	const json = (dialect: "native" | "mcp-json" | "foreign", requireKey = false) => (text: string) =>
		parseMcpServersJson(text, dialect, env, { requireKey });
	const loaders: ProviderLoader[] = [];
	const loader = (provider: McpProviderId): ProviderLoader => {
		const created = new ProviderLoader(ctx, provider);
		loaders.push(created);
		return created;
	};

	// native (priority 100): project .omp/mcp.json, .omp/.mcp.json, then user mcp.json, .mcp.json.
	await loader("native").all(
		planned([
			[project(".omp", "mcp.json"), "project", json("native")],
			[project(".omp", ".mcp.json"), "project", json("native")],
			[join(agentDir, "mcp.json"), "user", json("native")],
			[join(agentDir, ".mcp.json"), "user", json("native")],
		]),
	);

	// claude (80): project files before user files; first non-empty file per level.
	const claudeOverride = env.CLAUDE_CONFIG_DIR?.trim();
	const claudeDir = claudeOverride ? resolve(claudeOverride) : join(home, ".claude");
	const claudeFile = claudeOverride ? join(claudeDir, ".claude.json") : join(home, ".claude.json");
	const claude = loader("claude");
	await claude.firstNonEmpty(
		planned([
			[project(".claude", ".mcp.json"), "project", json("foreign")],
			[project(".claude", "mcp.json"), "project", json("foreign")],
		]),
	);
	await claude.firstNonEmpty(
		planned([
			[claudeFile, "user", json("foreign")],
			[join(claudeDir, "mcp.json"), "user", json("foreign")],
		]),
	);

	// codex (70): project then user config.toml.
	const codexProject = project(".codex", "config.toml");
	const codexUser = join(home, ".codex", "config.toml");
	await loader("codex").all(
		planned([
			[codexProject, "project", text => parseCodexToml(text, codexProject ?? "", env)],
			[codexUser, "user", text => parseCodexToml(text, codexUser, env)],
		]),
	);

	// gemini (60): project then user settings.json.
	await loader("gemini").all(
		planned([
			[project(".gemini", "settings.json"), "project", json("foreign")],
			[join(home, ".gemini", "settings.json"), "user", json("foreign")],
		]),
	);

	// opencode (55): layers merged per server in ascending precedence; the last defining layer is the source.
	const opencode = loader("opencode");
	const layers: Array<[string | null, McpScope]> = [
		[join(home, ".config", "opencode", "opencode.json"), "user"],
		[join(home, ".config", "opencode", "opencode.jsonc"), "user"],
		[project("opencode.json"), "project"],
		[project("opencode.jsonc"), "project"],
		[project(".opencode", "opencode.json"), "project"],
		[project(".opencode", "opencode.jsonc"), "project"],
	];
	const merged = new Map<string, { config: Record<string, unknown>; file: { path: string; level: McpScope } }>();
	for (const [path, level] of layers) {
		if (!path) continue;
		const layer = { path, level };
		const { source, text } = await opencode.read(layer);
		if (text === null) continue;
		const substituted = await substituteOpenCodeVars(text, path, env, file => ctx.readFile(file).catch(() => null));
		const { mcp, error } = parseOpenCodeLayer(substituted);
		source.error = error;
		source.serverCount = Object.keys(mcp).length;
		for (const [name, value] of Object.entries(mcp)) {
			const record = JsonRecord.safeParse(value);
			if (!record.success || Array.isArray(value)) {
				source.error = `Invalid MCP config for "${name}"`;
				continue;
			}
			const previous = merged.get(name);
			merged.set(name, { config: previous ? mergeRecords(previous.config, record.data) : record.data, file: layer });
		}
	}
	for (const [name, { config, file }] of merged) opencode.push([buildOpenCodeServer(name, config)], file);

	// cursor, windsurf (50): project then user.
	await loader("cursor").all(
		planned([
			[project(".cursor", "mcp.json"), "project", json("foreign", true)],
			[join(home, ".cursor", "mcp.json"), "user", json("foreign", true)],
		]),
	);
	await loader("windsurf").all(
		planned([
			[project(".windsurf", "mcp_config.json"), "project", json("foreign")],
			[join(home, ".codeium", "windsurf", "mcp_config.json"), "user", json("foreign")],
		]),
	);

	// vscode (20): project only.
	await loader("vscode").all(planned([[project(".vscode", "mcp.json"), "project", text => parseVscodeJson(text, env)]]));

	// mcp-json (5): root fallbacks.
	await loader("mcp-json").all(
		planned([
			[project("mcp.json"), "project", json("mcp-json")],
			[project(".mcp.json"), "project", json("mcp-json")],
		]),
	);

	return { rows: loaders.flatMap(item => item.rows), sources: loaders.flatMap(item => item.sources) };
}

// ---------------------------------------------------------------------------------------------------------------
// Status resolution (pure)
// ---------------------------------------------------------------------------------------------------------------

export interface ResolveOptions {
	settings: McpDiscoverySettings;
	disabledServers: string[];
	enabledServers: string[];
	/** Primary writable files (`<agentDir>/mcp.json`, `<cwd>/.omp/mcp.json`). */
	editablePaths: string[];
}

/** omp's `isSameMCPConnection` over effective configs. */
function sameConnection(left: ParsedServer["effective"], right: ParsedServer["effective"]): boolean {
	if (!isDeepStrictEqual(left.auth, right.auth) || !isDeepStrictEqual(left.oauth, right.oauth)) return false;
	if ((left.requestIdFormat ?? "number") !== (right.requestIdFormat ?? "number")) return false;
	const transport = transportOf(left);
	if (transport !== transportOf(right)) return false;
	if (transport === "stdio") {
		return (
			left.command === right.command &&
			isDeepStrictEqual(left.args, right.args) &&
			isDeepStrictEqual(left.env, right.env) &&
			left.cwd === right.cwd
		);
	}
	return left.url === right.url && isDeepStrictEqual(left.headers, right.headers);
}

const EXA_URL = /mcp\.exa\.ai/i;
/** Exa tools covered by omp's native Exa integration. */
const NATIVE_EXA_TOOLS: Record<string, true> = { web_search_exa: true };

function requestedExaTools(config: ParsedServer["effective"]): string[] | null {
	const transport = transportOf(config);
	let raw: string | undefined;
	if (transport === "http" || transport === "sse") {
		if (config.url && URL.canParse(config.url)) raw = new URL(config.url).searchParams.get("tools") ?? undefined;
	} else {
		const args = config.args ?? [];
		for (let i = 0; i < args.length && raw === undefined; i++) {
			const arg = args[i] ?? "";
			if (/^--?tools$/i.test(arg)) raw = args[i + 1];
			else raw = (arg.match(/(?:^|[\s?&])tools=([^&\s]+)/i) ?? arg.match(/--?tools[=\s]([^\s]+)/i))?.[1];
		}
	}
	const tools = raw?.split(",").map(tool => tool.trim()).filter(Boolean) ?? [];
	return tools.length > 0 ? tools : null;
}

/** omp's `filterExaMCPServers` predicate: true when omp drops the server in favour of native Exa. */
export function isFilteredExa(name: string, config: ParsedServer["effective"]): boolean {
	const transport = transportOf(config);
	const isExa =
		name.toLowerCase() === "exa" ||
		((transport === "http" || transport === "sse") && Boolean(config.url && EXA_URL.test(config.url))) ||
		(transport === "stdio" && (config.args ?? []).some(arg => EXA_URL.test(arg)));
	if (!isExa) return false;
	return !(requestedExaTools(config)?.some(tool => !NATIVE_EXA_TOOLS[tool.toLowerCase()]) ?? false);
}

const BROWSER_NAMES: Record<string, true> = {
	puppeteer: true,
	playwright: true,
	browserbase: true,
	"browser-tools": true,
	"browser-use": true,
	browser: true,
};
const BROWSER_PKG =
	/(?:@modelcontextprotocol\/server-puppeteer|@playwright\/mcp|@browserbasehq\/mcp-server-browserbase|@agentdeskai\/browser-tools-mcp|@agent-infra\/mcp-server-browser|puppeteer-mcp|playwright-mcp|pptr-mcp|browser-use-mcp|mcp-browser-use)/i;
const BROWSER_URL = /browserbase\.com|browser-use\.com/i;

/** omp's `isBrowserMCPServer`. */
export function isBrowserServer(name: string, config: ParsedServer["effective"]): boolean {
	if (BROWSER_NAMES[name.toLowerCase()]) return true;
	const transport = transportOf(config);
	if (transport === "http" || transport === "sse") return Boolean(config.url && BROWSER_URL.test(config.url));
	return Boolean(config.command && BROWSER_PKG.test(config.command)) || (config.args ?? []).some(arg => BROWSER_PKG.test(arg));
}

/** Apply omp's loader semantics to discovered rows (kept in order) and build the public entries. */
export function resolveEntries(rows: DiscoveredRow[], options: ResolveOptions): McpServerEntry[] {
	const { settings } = options;
	const denied = new Set(options.disabledServers);
	const forced = new Set(options.enabledServers);
	const disabledExtensions = new Set(settings.disabledExtensions);
	const editable = new Set(options.editablePaths);
	const keyOwner = new Map<string, DiscoveredRow>();
	const survivors: DiscoveredRow[] = [];

	return rows.map(row => {
		const { server } = row;
		const effective = server.effective;
		const errors = [...server.errors];
		let status: McpServerStatus = "active";
		let detail: string | null = null;
		let shadowedBy: DiscoveredRow | undefined;

		if (disabledExtensions.has(`mcp:${server.name}`)) {
			status = "extension-disabled";
			detail = `"mcp:${server.name}" is in omp's disabledExtensions setting`;
		} else if (row.level === "project" && !settings.enableProjectConfig) {
			status = "excluded";
			detail = "Project-level MCP config is disabled (mcp.enableProjectConfig: false)";
		} else if (denied.has(server.name) || (effective.enabled === false && !forced.has(server.name))) {
			status = denied.has(server.name) ? "denied" : "disabled";
			detail = denied.has(server.name)
				? "Listed in the user disabledServers denylist"
				: "enabled: false in its config file";
			shadowedBy = keyOwner.get(server.name);
			if (!shadowedBy) keyOwner.set(server.name, row);
		} else {
			shadowedBy = keyOwner.get(server.name) ?? survivors.find(other => sameConnection(other.server.effective, effective));
			if (!keyOwner.has(server.name)) keyOwner.set(server.name, row);
			if (shadowedBy) {
				status = "shadowed";
				detail =
					shadowedBy.server.name === server.name
						? `A higher-priority entry named "${server.name}" wins (${shadowedBy.path})`
						: `Same connection as higher-priority "${shadowedBy.server.name}" (${shadowedBy.path})`;
			} else {
				// Dedupe happens before validation: invalid survivors still equivalence-shadow later rows.
				survivors.push(row);
				const invalid = capabilityError(effective);
				if (invalid) {
					status = "invalid";
					detail = invalid;
					errors.push(invalid);
				} else {
					if (isFilteredExa(server.name, effective)) {
						status = "exa-filtered";
						detail = "omp uses its native Exa integration instead of this server";
					} else if (settings.browserEnabled && isBrowserServer(server.name, effective)) {
						status = "browser-filtered";
						detail = "omp hides browser-automation MCP servers while browser.enabled is true";
					}
				}
			}
		}

		return {
			id: `${row.path}#${server.name}`,
			name: server.name,
			provider: row.provider,
			providerName: row.providerName,
			path: row.path,
			level: row.level,
			ompOwned: row.provider === "native" || row.provider === "mcp-json",
			editable: editable.has(row.path),
			transport: transportOf(effective),
			config: server.config,
			raw: server.raw,
			status,
			statusDetail: detail,
			enabled: status !== "disabled" && status !== "denied" && status !== "extension-disabled",
			shadowedBy: shadowedBy && shadowedBy !== row ? { name: shadowedBy.server.name, path: shadowedBy.path } : null,
			errors,
			unresolvedVars: server.unresolvedVars,
		};
	});
}
