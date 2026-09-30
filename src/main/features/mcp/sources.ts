/**
 * Per-format MCP source parsers, translating each tool's config into omp's server shape exactly the way omp's
 * discovery providers do (packages/coding-agent/src/discovery/{builtin,mcp-json,claude,codex,gemini,opencode,
 * cursor,windsurf,vscode}.ts). Pure apart from the injected file reader used for OpenCode `{file:…}` tokens.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { McpOAuthConfig, McpServerConfig } from "@shared/contracts/mcp";
import { type FieldDialect, JsonRecord, type ParsedServer, parseEntry } from "./config";

export interface FileParse {
	servers: ParsedServer[];
	/** Parse/shape problem for the whole file; omp then contributes no entries (or logs a warning). */
	error: string | null;
}

const StringArray = z.array(z.string());
const StringRecord = z.record(z.string(), z.string());

function parseJsonRoot(text: string): { root: Record<string, unknown> } | { error: string } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return { error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const root = JsonRecord.safeParse(json);
	return root.success && !Array.isArray(json) ? { root: root.data } : { error: "Top level is not a JSON object" };
}

function parseMap(map: Record<string, unknown>, dialect: FieldDialect, env: NodeJS.ProcessEnv): ParsedServer[] {
	const ompOwned = dialect === "native" || dialect === "mcp-json";
	return Object.entries(map).map(([name, value]) => {
		const parsed = parseEntry(name, value, dialect, env);
		// Foreign providers hand omp already-expanded values; omp-owned rows keep the as-written form for editing.
		return ompOwned ? parsed : { ...parsed, config: parsed.effective };
	});
}

/** A `{ "mcpServers": {...} }` file (omp native, root mcp.json, Claude, Cursor, Windsurf, Gemini). */
export function parseMcpServersJson(
	text: string,
	dialect: FieldDialect,
	env: NodeJS.ProcessEnv,
	options: { requireKey?: boolean } = {},
): FileParse {
	const parsed = parseJsonRoot(text);
	if ("error" in parsed) return { servers: [], error: parsed.error };
	const map = JsonRecord.safeParse(parsed.root.mcpServers);
	if (!map.success || Array.isArray(parsed.root.mcpServers)) {
		const missing = parsed.root.mcpServers === undefined;
		if (missing && !options.requireKey) return { servers: [], error: null };
		return { servers: [], error: missing ? "Missing 'mcpServers' key" : "'mcpServers' is not an object" };
	}
	return { servers: parseMap(map.data, dialect, env), error: null };
}

/** VS Code `.vscode/mcp.json` as omp reads it: servers under `mcp.servers`, transport in `transport`. */
export function parseVscodeJson(text: string, env: NodeJS.ProcessEnv): FileParse {
	const parsed = parseJsonRoot(text);
	if ("error" in parsed) return { servers: [], error: parsed.error };
	const mcp = JsonRecord.safeParse(parsed.root.mcp);
	const servers = mcp.success ? JsonRecord.safeParse(mcp.data.servers) : null;
	if (!servers?.success) return { servers: [], error: null };
	return { servers: parseMap(servers.data, "vscode", env), error: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Codex (config.toml [mcp_servers.*])
// ---------------------------------------------------------------------------------------------------------------

const CodexServer = z.looseObject({
	enabled: z.boolean().optional(),
	command: z.string().optional(),
	args: StringArray.optional(),
	env: StringRecord.optional(),
	env_vars: StringArray.optional(),
	url: z.string().optional(),
	http_headers: StringRecord.optional(),
	env_http_headers: StringRecord.optional(),
	bearer_token_env_var: z.string().optional(),
	cwd: z.string().optional(),
	tool_timeout_sec: z.number().optional(),
});

/** omp's `resolvePluginStdioPaths(…, "cwd")`: root relative cwd, and path-like commands against it. */
function rootStdioPaths(command: string | undefined, cwd: string | undefined, configDir: string) {
	const rootedCwd = cwd === undefined ? undefined : isAbsolute(cwd) ? cwd : resolve(configDir, cwd);
	const rootedCommand =
		command !== undefined && /^\.\.?[/\\]/.test(command) ? resolve(rootedCwd ?? configDir, command) : command;
	return { command: rootedCommand, cwd: rootedCwd };
}

/** Codex `config.toml`; `configPath` roots relative commands like omp does. No `${VAR}` expansion (Codex has none). */
export function parseCodexToml(text: string, configPath: string, env: NodeJS.ProcessEnv): FileParse {
	let root: Record<string, unknown>;
	try {
		root = JsonRecord.parse(parseToml(text));
	} catch (error) {
		return { servers: [], error: `Invalid TOML: ${error instanceof Error ? error.message : String(error)}` };
	}
	const table = JsonRecord.safeParse(root.mcp_servers);
	if (!table.success) return { servers: [], error: null };
	const configDir = dirname(configPath);
	const servers: ParsedServer[] = [];
	for (const [name, value] of Object.entries(table.data)) {
		const rawRecord = JsonRecord.safeParse(value);
		const raw = rawRecord.success ? rawRecord.data : {};
		const parsed = CodexServer.safeParse(value);
		if (!parsed.success) {
			const errors = parsed.error.issues.map(issue => `${issue.path.join(".") || name}: ${issue.message}`);
			servers.push({ name, raw, config: {}, effective: {}, errors, unresolvedVars: [] });
			continue;
		}
		const codex = parsed.data;
		const rooted = rootStdioPaths(codex.command, codex.cwd, configDir);
		const config: McpServerConfig = {};
		if (codex.enabled === false) config.enabled = false;
		if (rooted.command !== undefined) config.command = rooted.command;
		if (codex.args) config.args = codex.args;
		if (codex.url) config.url = codex.url;
		if (rooted.cwd !== undefined) config.cwd = rooted.cwd;
		const serverEnv: Record<string, string> = { ...codex.env };
		for (const varName of codex.env_vars ?? []) {
			const forwarded = env[varName];
			if (forwarded !== undefined) serverEnv[varName] = forwarded;
		}
		if (Object.keys(serverEnv).length > 0) config.env = serverEnv;
		const headers: Record<string, string> = { ...codex.http_headers };
		for (const [header, varName] of Object.entries(codex.env_http_headers ?? {})) {
			const forwarded = env[varName];
			if (forwarded !== undefined) headers[header] = forwarded;
		}
		const token = codex.bearer_token_env_var ? env[codex.bearer_token_env_var] : undefined;
		if (token) headers.Authorization = `Bearer ${token}`;
		if (Object.keys(headers).length > 0) config.headers = headers;
		if (codex.url) config.type = "http";
		else if (codex.command) config.type = "stdio";
		if (codex.tool_timeout_sec !== undefined && codex.tool_timeout_sec > 0) config.timeout = codex.tool_timeout_sec * 1000;
		servers.push({ name, raw, config, effective: config, errors: [], unresolvedVars: [] });
	}
	return { servers, error: null };
}

// ---------------------------------------------------------------------------------------------------------------
// OpenCode (opencode.json / opencode.jsonc → "mcp")
// ---------------------------------------------------------------------------------------------------------------

/** Remove `//` and `/* *\/` comments and trailing commas outside strings (JSONC → JSON). */
export function stripJsonc(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === '"') {
			const start = i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			out += text.slice(start, ++i);
		} else if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
			out += " ";
		} else {
			out += ch;
			i++;
		}
	}
	let result = "";
	for (let j = 0; j < out.length; j++) {
		const ch = out[j];
		if (ch === '"') {
			const start = j++;
			while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
			result += out.slice(start, j + 1);
			continue;
		}
		if (ch === ",") {
			let k = j + 1;
			while (k < out.length && /\s/.test(out[k] ?? "")) k++;
			if (out[k] === "}" || out[k] === "]") continue;
		}
		result += ch;
	}
	return result;
}

/**
 * OpenCode's load-time substitution: `{env:VAR}` (empty when unset) and `{file:path}` (trimmed, JSON-escaped,
 * relative to the config file; tokens on `//` comment lines are left alone; missing files expand to nothing).
 */
export async function substituteOpenCodeVars(
	text: string,
	configPath: string,
	env: NodeJS.ProcessEnv,
	readFile: (path: string) => Promise<string | null>,
): Promise<string> {
	const envExpanded = text.replace(/\{env:([^}]+)\}/g, (_match, name: string) => env[name] ?? "");
	let out = "";
	let cursor = 0;
	for (const match of envExpanded.matchAll(/\{file:[^}]+\}/g)) {
		const token = match[0];
		const index = match.index;
		out += envExpanded.slice(cursor, index);
		cursor = index + token.length;
		const lineStart = envExpanded.lastIndexOf("\n", index - 1) + 1;
		if (envExpanded.slice(lineStart, index).trimStart().startsWith("//")) {
			out += token;
			continue;
		}
		let filePath = token.slice("{file:".length, -1);
		if (filePath.startsWith("~/")) filePath = join(homedir(), filePath.slice(2));
		const content = await readFile(isAbsolute(filePath) ? filePath : resolve(dirname(configPath), filePath));
		if (content !== null) out += JSON.stringify(content.trim()).slice(1, -1);
	}
	return out + envExpanded.slice(cursor);
}

/** The `mcp` map of one OpenCode layer (after {@link substituteOpenCodeVars}). */
export function parseOpenCodeLayer(text: string): { mcp: Record<string, unknown>; error: string | null } {
	const parsed = parseJsonRoot(stripJsonc(text));
	if ("error" in parsed) return { mcp: {}, error: `Invalid JSONC: ${parsed.error}` };
	const mcp = JsonRecord.safeParse(parsed.root.mcp);
	return { mcp: mcp.success ? mcp.data : {}, error: null };
}

/** omp's `mergeConfigRecords`: later layer wins, nested records merge. */
export function mergeRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = JsonRecord.safeParse(result[key]);
		const incoming = JsonRecord.safeParse(value);
		result[key] =
			existing.success && incoming.success && !Array.isArray(value) ? mergeRecords(existing.data, incoming.data) : value;
	}
	return result;
}

const OpenCodeServer = z.looseObject({
	type: z.unknown().optional(),
	command: z.union([z.string(), z.array(z.string())]).optional().catch(undefined),
	args: StringArray.optional().catch(undefined),
	env: StringRecord.optional().catch(undefined),
	environment: StringRecord.optional().catch(undefined),
	url: z.string().optional().catch(undefined),
	headers: StringRecord.optional().catch(undefined),
	enabled: z.boolean().optional().catch(undefined),
	timeout: z.number().optional().catch(undefined),
	oauth: z
		.looseObject({
			clientId: z.string().optional().catch(undefined),
			clientSecret: z.string().optional().catch(undefined),
			scope: z.string().optional().catch(undefined),
			callbackPort: z.number().optional().catch(undefined),
			redirectUri: z.string().optional().catch(undefined),
		})
		.optional()
		.catch(undefined),
});

/** omp's `buildMCPServer` for one merged OpenCode entry. */
export function buildOpenCodeServer(name: string, merged: Record<string, unknown>): ParsedServer {
	const oc = OpenCodeServer.parse(merged);
	const config: McpServerConfig = {};
	if (oc.type === "local") config.type = "stdio";
	else if (oc.type === "remote") config.type = "http";
	else if (oc.url) config.type = "http";
	else if (oc.command) config.type = "stdio";
	const commandArgs = Array.isArray(oc.command) ? oc.command.slice(1) : [];
	const command = Array.isArray(oc.command) ? oc.command[0] : oc.command;
	const args = [...commandArgs, ...(oc.args ?? [])];
	if (command !== undefined) config.command = command;
	if (args.length > 0) config.args = args;
	const env = oc.environment ?? oc.env;
	if (env) config.env = env;
	if (oc.url) config.url = oc.url;
	if (oc.headers) config.headers = oc.headers;
	if (oc.enabled !== undefined) config.enabled = oc.enabled;
	if (oc.timeout !== undefined) config.timeout = oc.timeout;
	if (oc.oauth) {
		const oauth: McpOAuthConfig = {};
		if (oc.oauth.clientId !== undefined) oauth.clientId = oc.oauth.clientId;
		if (oc.oauth.clientSecret !== undefined) oauth.clientSecret = oc.oauth.clientSecret;
		if (oc.oauth.scope !== undefined) oauth.scope = oc.oauth.scope;
		if (oc.oauth.callbackPort !== undefined) oauth.callbackPort = oc.oauth.callbackPort;
		if (oc.oauth.redirectUri !== undefined) oauth.redirectUri = oc.oauth.redirectUri;
		if (Object.keys(oauth).length > 0) config.oauth = oauth;
	}
	return { name, raw: merged, config, effective: config, errors: [], unresolvedVars: [] };
}
