/**
 * MCP (Model Context Protocol) server management, mirroring omp's own config model.
 *
 * omp-native config lives in two writable files:
 * - user scope: `<agentDir>/mcp.json` (`PI_CODING_AGENT_DIR`, default `~/.omp/agent/mcp.json`)
 * - project scope: `<cwd>/.omp/mcp.json`
 *
 * File shape (`{ "$schema"?, "mcpServers"?: { name: config }, "disabledServers"?: string[], "enabledServers"?: string[] }`).
 * Unknown top-level keys and unknown per-server fields are preserved on every write. Writes use omp's own
 * serialization (2-space JSON, `$schema` inserted first when missing, file mode 0600) so a file edited here is
 * byte-identical to one written by `/mcp add` / `/mcp enable`.
 *
 * omp additionally *reads* (never writes) MCP servers from other tools; `mcp:list` reports those read-only with
 * their source file: Claude Code (`~/.claude.json`, `~/.claude/mcp.json`, `.claude/.mcp.json`, `.claude/mcp.json`),
 * OpenAI Codex (`~/.codex/config.toml`, `.codex/config.toml`), Gemini CLI (`settings.json`), OpenCode
 * (`opencode.json[c]`), Cursor (`mcp.json`), Windsurf (`mcp_config.json`), VS Code (`.vscode/mcp.json`), the
 * compatibility files `.omp/.mcp.json` / `<agentDir>/.mcp.json`, and the root fallbacks `<cwd>/mcp.json` /
 * `<cwd>/.mcp.json`. Foreign *user-level* (`~/…`) sources only load when opted in via omp's `enabledProviders`
 * setting, exactly like omp.
 *
 * Not covered (omp capability gaps for a GUI): servers contributed by installed plugins/marketplace packages
 * (omp exposes no non-interactive listing for them), omp's named profiles (`--profile`; the user scope is always the
 * default agent dir), and omp-managed OAuth credentials (stored in `agent.db`; `mcp:test` sends only configured
 * headers, so OAuth-only servers report `authRequired`). omp has no `omp mcp …` CLI, so connection state of a
 * *running* session is not available here — `mcp:test` performs its own short-lived connection instead.
 */

export type McpScope = "user" | "project";

export type McpTransport = "stdio" | "http" | "sse";

/** Write destination: the primary omp-native `mcp.json` of a scope. */
export type McpTarget = { scope: "user" } | { scope: "project"; cwd: string };

/** `auth` block: stored-credential metadata omp uses for managed OAuth refresh. */
export interface McpAuthConfig {
	type: "oauth" | "apikey";
	credentialId?: string;
	tokenUrl?: string;
	clientId?: string;
	clientSecret?: string;
	resource?: string;
	[key: string]: unknown;
}

/** `oauth` block: explicit OAuth client / callback settings used by omp's `/mcp reauth`. */
export interface McpOAuthConfig {
	clientId?: string;
	clientSecret?: string;
	scope?: string;
	redirectUri?: string;
	callbackPort?: number;
	callbackPath?: string;
	/** OAuth `prompt` parameter; `""` forces omission. */
	prompt?: string;
	[key: string]: unknown;
}

/**
 * One server entry. `type` omitted means stdio. String values may contain `${VAR}` / `${VAR:-default}`
 * (expanded by omp at discovery). stdio `env` and remote `headers` values are further resolved right before
 * connecting: a value starting with `!` runs as a shell command (trimmed stdout; entry dropped on failure/empty),
 * a value naming a set environment variable is replaced by that variable, anything else is literal.
 *
 * Fields not listed here are preserved verbatim (index signature).
 */
export interface McpServerConfig {
	type?: McpTransport;
	/** stdio: executable. */
	command?: string;
	/** stdio: arguments. */
	args?: string[];
	/** stdio: extra environment on top of the inherited one. */
	env?: Record<string, string>;
	/** stdio: working directory (default: the project directory). */
	cwd?: string;
	/** http/sse: endpoint URL. */
	url?: string;
	/** http/sse: request headers. */
	headers?: Record<string, string>;
	/** `false` skips the server (unless the user `enabledServers` allowlist names it). Default true. */
	enabled?: boolean;
	/** MCP request timeout in ms; `0` disables client-side timeouts. Default 30000. */
	timeout?: number;
	/** Outgoing JSON-RPC id encoding. omp-native files only. */
	requestIdFormat?: "number" | "string";
	/** Include server instructions in the system prompt (default true). omp-native files only. */
	instructions?: boolean;
	auth?: McpAuthConfig;
	oauth?: McpOAuthConfig;
	[key: string]: unknown;
}

/** Discovery provider ids, identical to omp's provider ids (also the values used in `enabledProviders`). */
export type McpProviderId =
	| "native"
	| "claude"
	| "codex"
	| "gemini"
	| "opencode"
	| "cursor"
	| "windsurf"
	| "vscode"
	| "mcp-json";

/**
 * Effective state of one discovered entry, following omp's loader order exactly:
 * - `active`: omp would connect to it.
 * - `disabled`: `enabled: false` in its source (and not force-enabled by the user `enabledServers`).
 * - `denied`: named in the user `disabledServers` denylist (wins over everything).
 * - `shadowed`: a higher-priority entry owns the same name, or an equivalent connection under another name.
 * - `invalid`: fails omp's validation (see `errors`); omp drops it with a warning.
 * - `excluded`: project-level source while the `mcp.enableProjectConfig` setting is false.
 * - `extension-disabled`: `mcp:<name>` is listed in omp's `disabledExtensions` setting (extensions dashboard).
 * - `exa-filtered`: an Exa server that omp replaces with its native Exa integration.
 * - `browser-filtered`: a browser-automation server omp drops while `browser.enabled` is true.
 */
export type McpServerStatus =
	| "active"
	| "disabled"
	| "denied"
	| "shadowed"
	| "invalid"
	| "excluded"
	| "extension-disabled"
	| "exa-filtered"
	| "browser-filtered";

export interface McpServerEntry {
	/** Stable row id: `<path>#<name>`. */
	id: string;
	name: string;
	provider: McpProviderId;
	/** Human provider name as omp shows it ("OMP", "Claude Code", …). */
	providerName: string;
	/** Absolute source file. */
	path: string;
	level: McpScope;
	/** File format omp owns (native files and root `mcp.json`/`.mcp.json`): enable/disable edit `enabled` in place. */
	ompOwned: boolean;
	/**
	 * Entry lives in the primary `mcp.json` of its scope, so `mcp:update` / `mcp:remove` can target it
	 * (`{ scope: level, cwd }`). Entries in compatibility/foreign files are read-only here.
	 */
	editable: boolean;
	transport: McpTransport;
	/**
	 * Normalized config. For omp-owned files: the stored entry as written (placeholders unexpanded, omp's value
	 * coercions applied, unknown fields preserved) — send it back to `mcp:update` after editing. For foreign files:
	 * omp's translation into its own shape (already `${VAR}`-expanded, like omp does).
	 */
	config: McpServerConfig;
	/** The entry verbatim as found in the source file (JSON object, or the TOML table for Codex). */
	raw: Record<string, unknown>;
	status: McpServerStatus;
	/** Human explanation of `status`; null when active. */
	statusDetail: string | null;
	/** Toggle state: false when disabled/denied/extension-disabled for this name. */
	enabled: boolean;
	/** The entry that shadows this one (same name or equivalent connection). */
	shadowedBy: { name: string; path: string } | null;
	/** Validation / field-type problems (omp ignores invalid optional fields and drops invalid servers). */
	errors: string[];
	/** `${VAR}` placeholders that stay literal because the variable is unset in the user's environment. */
	unresolvedVars: string[];
}

/** One config file omp consults for MCP servers. */
export interface McpSourceFile {
	provider: McpProviderId;
	providerName: string;
	path: string;
	level: McpScope;
	exists: boolean;
	/** False when omp skips this file (see `skippedReason`); its servers are then not listed. */
	loaded: boolean;
	skippedReason: string | null;
	/** Parse error (invalid JSON/JSONC/TOML or wrong shape); omp then contributes no entries from it. */
	error: string | null;
	serverCount: number;
}

/** omp settings that shape MCP discovery, read via `omp config list --json`. */
export interface McpDiscoverySettings {
	/** `mcp.enableProjectConfig`: false excludes every project-level source. */
	enableProjectConfig: boolean;
	/** `browser.enabled`: while true omp drops browser-automation MCP servers (Playwright, Puppeteer, …). */
	browserEnabled: boolean;
	/** `enabledProviders`: opt-in foreign user-level sources (`claude`, `cursor`, `*`, …). */
	enabledProviders: string[];
	/** `disabledProviders`: providers omp ignores entirely. */
	disabledProviders: string[];
	/** `disabledExtensions`: extension ids (`mcp:<name>`) disabled in omp's extensions dashboard. */
	disabledExtensions: string[];
}

export interface McpListResult {
	/** Project directory the list was computed for; null = user scope only. */
	cwd: string | null;
	/** Primary user file (`<agentDir>/mcp.json`), whether or not it exists. */
	userPath: string;
	/** Primary project file (`<cwd>/.omp/mcp.json`); null when `cwd` is null. */
	projectPath: string | null;
	/** Every discovered entry, in omp's precedence order (first wins). */
	servers: McpServerEntry[];
	/** Every file omp consults, in precedence order. */
	sources: McpSourceFile[];
	/** User-level denylist (`disabledServers` in the user file). */
	disabledServers: string[];
	/** User-level force-enable allowlist (`enabledServers` in the user file). */
	enabledServers: string[];
	settings: McpDiscoverySettings;
	/** Non-fatal problems (e.g. omp settings could not be read and defaults were assumed). */
	warnings: string[];
}

/** Raw contents of a primary omp-native MCP file. */
export interface McpFileInfo {
	scope: McpScope;
	path: string;
	exists: boolean;
	/** File text; null when missing. */
	content: string | null;
	/** JSON / shape error; writes through the structured channels refuse to touch a broken file. */
	error: string | null;
}

/**
 * How an enable/disable was persisted (omp's `setMcpServerEnabled` rules):
 * - `field`: `enabled` written on the entry in an omp-owned file (source file, else project, else user file).
 * - `disabledServers`: added to the user denylist (server defined only in a foreign tool's config).
 * - `enabledServers`: added to the user force-enable allowlist (foreign source says `enabled: false`).
 * Stale opposite overrides in the user file are cleaned up in every case.
 */
export type McpToggleMechanism = "field" | "disabledServers" | "enabledServers";

export interface McpToggleOptions {
	/** Project directory; null/omitted = no project file is considered. */
	cwd?: string | null;
	/**
	 * `McpServerEntry.path` of the row being toggled. Only honored for omp-owned files (native / root mcp.json);
	 * foreign tool configs are never mutated.
	 */
	sourcePath?: string;
}

export interface McpToggleResult {
	name: string;
	enabled: boolean;
	mechanism: McpToggleMechanism;
	/** Files that were rewritten (the entry's file and/or the user file for list cleanup). */
	changedPaths: string[];
}

export interface McpTestOptions {
	/** Project directory: default stdio `cwd`, `!command` working dir, and the root advertised via `roots/list`. */
	cwd?: string;
	/** Whole-test deadline in ms (spawn → initialize → list). Default 20000. */
	timeoutMs?: number;
}

export interface McpToolInfo {
	name: string;
	title: string | null;
	description: string | null;
	/** JSON Schema of the tool arguments, as sent by the server. */
	inputSchema: unknown;
}

export interface McpPromptInfo {
	name: string;
	title: string | null;
	description: string | null;
	arguments: { name: string; description: string | null; required: boolean }[];
}

export interface McpResourceInfo {
	uri: string;
	name: string;
	title: string | null;
	description: string | null;
	mimeType: string | null;
}

/** Phase reached by `mcp:test`; on failure, the phase that failed. */
export type McpTestStage = "config" | "spawn" | "connect" | "initialize" | "list" | "done";

export interface McpTestResult {
	ok: boolean;
	transport: McpTransport;
	stage: McpTestStage;
	/** Failure message; null on success. */
	error: string | null;
	timedOut: boolean;
	/** HTTP 401/403 — the server needs credentials (e.g. `/mcp reauth <name>` inside omp, or an Authorization header). */
	authRequired: boolean;
	/** `WWW-Authenticate` response header when `authRequired`. */
	authChallenge: string | null;
	/** Last HTTP status for http/sse when the failure was an HTTP error. */
	httpStatus: number | null;
	/** stdio child exit code / signal when it exited before the test finished. */
	exitCode: number | null;
	exitSignal: string | null;
	durationMs: number;
	/** Effective argv for stdio (after `${VAR}` expansion; env values are not included). */
	command: string[] | null;
	/** Effective URL for http/sse (after `${VAR}` expansion). */
	url: string | null;
	/** `${VAR}` placeholders left literal because the variable is unset. */
	unresolvedVars: string[];
	serverInfo: { name: string; version: string; title: string | null } | null;
	protocolVersion: string | null;
	/** Server capabilities from `initialize`. */
	capabilities: Record<string, unknown> | null;
	/** Server-provided instructions (omp adds these to the system prompt unless `instructions: false`). */
	instructions: string | null;
	tools: McpToolInfo[];
	/** Listed only when the server advertises the `prompts` capability. */
	prompts: McpPromptInfo[];
	/** Listed only when the server advertises the `resources` capability. */
	resources: McpResourceInfo[];
	/** Non-fatal failures while listing prompts/resources. */
	listErrors: string[];
	/** Tail of the stdio child's stderr (up to 8 KB). */
	stderr: string;
}

/** A value the user must/can provide for a preset. */
export interface McpPresetField {
	/** Placeholder id; template strings contain `{{id}}`. */
	id: string;
	label: string;
	/** `secret`: API key/token (mask it); `paths`: one or more directories (expands to several args). */
	kind: "secret" | "text" | "path" | "paths" | "url";
	required: boolean;
	description: string;
	placeholder: string | null;
	/** Where the value lands, for display. */
	target: "env" | "header" | "arg" | "url";
}

export interface McpPreset {
	id: string;
	label: string;
	description: string;
	category: "reference" | "developer" | "knowledge" | "web" | "productivity";
	homepage: string;
	/** Suggested server name for `mcp:add`. */
	suggestedName: string;
	transport: McpTransport;
	/** Config template containing `{{fieldId}}` tokens; build the final config with `mcp:preset:build`. */
	template: McpServerConfig;
	fields: McpPresetField[];
	/** Executables that must be on PATH (`npx`, `uvx`, `docker`). */
	requires: string[];
	/** Server signs in with OAuth: after adding, run `/mcp reauth <name>` inside omp. */
	oauth: boolean;
	/** Caveat to show (e.g. omp hides browser MCP servers while `browser.enabled` is on); null when none. */
	note: string | null;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Discover every MCP server omp would see for `cwd` (null = user scope only), with source files and states. */
		"mcp:list": { args: [cwd: string | null]; result: McpListResult };
		/** Read a primary omp-native MCP file verbatim. */
		"mcp:file:read": { args: [target: McpTarget]; result: McpFileInfo };
		/**
		 * Replace a primary omp-native MCP file with `content` (raw JSON editor). Rejects text that is not a JSON
		 * object or whose `mcpServers` / `disabledServers` / `enabledServers` have the wrong shape. Emits `mcp:changed`.
		 */
		"mcp:file:write": { args: [target: McpTarget, content: string]; result: McpFileInfo };
		/**
		 * Add a server to the target file. Validates the name (letters, digits, `_ - . :`, single spaces, ≤100) and the
		 * config (omp's `validateServerConfig`); fails if the name already exists there. Emits `mcp:changed`.
		 */
		"mcp:add": { args: [target: McpTarget, name: string, config: McpServerConfig]; result: void };
		/**
		 * Replace a server entry in the target file (adds it when missing, like omp). `newName` renames it in place,
		 * keeping its position; it fails if `newName` is already taken. Emits `mcp:changed`.
		 */
		"mcp:update": {
			args: [target: McpTarget, name: string, config: McpServerConfig, newName?: string];
			result: void;
		};
		/** Remove a server from the target file; fails when it is not there. Emits `mcp:changed`. */
		"mcp:remove": { args: [target: McpTarget, name: string]; result: void };
		/** Enable a server wherever it is defined, using omp's exact mechanism (see {@link McpToggleMechanism}). */
		"mcp:enable": { args: [name: string, options?: McpToggleOptions]; result: McpToggleResult };
		/** Disable a server wherever it is defined, using omp's exact mechanism (see {@link McpToggleMechanism}). */
		"mcp:disable": { args: [name: string, options?: McpToggleOptions]; result: McpToggleResult };
		/**
		 * Connect to a server config without saving it: spawn (stdio) or connect (Streamable HTTP / legacy SSE), run
		 * the MCP `initialize` handshake, send `notifications/initialized`, list tools (and prompts/resources when
		 * advertised), then always close and kill the child process tree. Never rejects; failures are in the result.
		 */
		"mcp:test": { args: [config: McpServerConfig, options?: McpTestOptions]; result: McpTestResult };
		/** Curated popular servers (real npm/PyPI packages and hosted endpoints). */
		"mcp:presets": { args: []; result: McpPreset[] };
		/**
		 * Fill a preset template with field values (`paths` fields take string[]). Optional fields left empty drop
		 * their env/header entry or argument. Throws when a required field is missing.
		 */
		"mcp:preset:build": {
			args: [presetId: string, values: Record<string, string | string[]>];
			result: McpServerConfig;
		};
	}

	interface IpcEventMap {
		/** MCP config files were written by this app (absolute paths); refresh `mcp:list`. */
		"mcp:changed": { paths: string[] };
	}
}
