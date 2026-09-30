/**
 * omp's MCP server config model: field normalization (mirroring the native provider in
 * packages/coding-agent/src/discovery/builtin.ts), `${VAR}` expansion (discovery/helpers.ts `expandEnvVarsDeep`),
 * and validation (mcp/config.ts `validateServerConfig`, mcp/config-writer.ts `validateServerName`,
 * capability/mcp.ts `validate`). Pure: no fs, no electron.
 */
import { z } from "zod";
import type { McpServerConfig, McpTransport } from "@shared/contracts/mcp";

export const JsonRecord = z.record(z.string(), z.unknown());
const StringArray = z.array(z.string());
const StringRecord = z.record(z.string(), z.string());
const Transport = z.enum(["stdio", "http", "sse"]);
const RequestIdFormat = z.enum(["number", "string"]);
const AuthConfig = z.looseObject({
	type: z.enum(["oauth", "apikey"]),
	credentialId: z.string().optional(),
	tokenUrl: z.string().optional(),
	clientId: z.string().optional(),
	clientSecret: z.string().optional(),
	resource: z.string().optional(),
});
const OAuthConfig = z.looseObject({
	clientId: z.string().optional(),
	clientSecret: z.string().optional(),
	scope: z.string().optional(),
	redirectUri: z.string().optional(),
	callbackPort: z.number().optional(),
	callbackPath: z.string().optional(),
	prompt: z.string().optional(),
});
const NonNegativeNumber = z.number().refine(value => Number.isFinite(value) && value >= 0);

/** One server as read from a source file. */
export interface ParsedServer {
	name: string;
	/** Entry verbatim. */
	raw: Record<string, unknown>;
	/** Normalized, as written (placeholders unexpanded for omp-owned files). */
	config: McpServerConfig;
	/** Normalized after omp's discovery-time `${VAR}` expansion — what omp evaluates and connects with. */
	effective: McpServerConfig;
	errors: string[];
	unresolvedVars: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// ${VAR} expansion
// ---------------------------------------------------------------------------------------------------------------

const PLACEHOLDER = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

/**
 * omp's `expandEnvVars`: `${VAR}` keeps an empty value verbatim and stays literal when unset; `${VAR:-default}`
 * uses the default when the variable is unset or empty. Literal leftovers are recorded in `unresolved`.
 */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv, unresolved?: Set<string>): string {
	return value.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => {
		const envValue = Object.hasOwn(env, name) ? env[name] : undefined;
		if (envValue !== undefined && (fallback === undefined || envValue !== "")) return envValue;
		if (fallback !== undefined) return fallback;
		unresolved?.add(name);
		return `\${${name}}`;
	});
}

/** Recursive {@link expandEnvVars} over strings in arrays/objects (keys untouched), like omp's `expandEnvVarsDeep`. */
export function expandEnvVarsDeep(value: unknown, env: NodeJS.ProcessEnv, unresolved?: Set<string>): unknown {
	if (typeof value === "string") return expandEnvVars(value, env, unresolved);
	if (Array.isArray(value)) return value.map(item => expandEnvVarsDeep(item, env, unresolved));
	const record = JsonRecord.safeParse(value);
	if (!record.success) return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record.data)) out[key] = expandEnvVarsDeep(item, env, unresolved);
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------------------------

/** Field flavours of the different discovery providers. */
export type FieldDialect =
	/** `.omp/mcp.json` & friends: coerces `"true"`/`"false"`/`"0"`/`"1"` and numeric-string timeouts. */
	| "native"
	/** Root `mcp.json` / `.mcp.json`: same fields, strict types. */
	| "mcp-json"
	/** Claude Code, Cursor, Gemini, Windsurf: no cwd/auth/oauth/requestIdFormat/instructions. */
	| "foreign"
	/** VS Code: like foreign but the transport is in `transport`, not `type`. */
	| "vscode";

const TRANSPORT_LABEL = `"stdio", "http" or "sse"`;

function checked<T>(key: string, value: unknown, schema: z.ZodType<T>, expected: string, errors: string[]): T | undefined {
	const result = schema.safeParse(value);
	if (result.success) return result.data;
	errors.push(`"${key}" must be ${expected}; ignored`);
	return undefined;
}

function coerceEnabled(value: unknown, dialect: FieldDialect, errors: string[]): boolean | undefined {
	if (value === null) return dialect === "native" ? undefined : checked("enabled", value, z.boolean(), "a boolean", errors);
	if (typeof value === "string" && dialect === "native") {
		const lower = value.toLowerCase();
		if (lower === "false" || lower === "0") return false;
		if (lower === "true" || lower === "1") return true;
	}
	return checked("enabled", value, z.boolean(), "a boolean", errors);
}

function coerceTimeout(value: unknown, dialect: FieldDialect, errors: string[]): number | undefined {
	if (value === null && dialect === "native") return undefined;
	if (typeof value === "string" && dialect === "native" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	const strict = dialect === "native" || dialect === "mcp-json";
	return checked("timeout", value, strict ? NonNegativeNumber : z.number(), "a non-negative number", errors);
}

const OMP_ONLY_FIELDS: Record<string, true> = { cwd: true, auth: true, oauth: true, requestIdFormat: true, instructions: true };

/**
 * Normalize one stored entry. omp-owned dialects keep unknown fields (in their original order) so the result can
 * be written back without loss; foreign dialects keep only the fields omp reads from them.
 */
export function normalizeEntry(raw: Record<string, unknown>, dialect: FieldDialect, errors: string[]): McpServerConfig {
	const config: McpServerConfig = {};
	const ompOwned = dialect === "native" || dialect === "mcp-json";
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		if (!ompOwned && OMP_ONLY_FIELDS[key]) continue;
		switch (key) {
			case "type":
				if (dialect === "vscode") continue;
				config.type = checked(key, value, Transport, TRANSPORT_LABEL, errors);
				break;
			case "transport":
				if (dialect === "vscode") config.type = checked(key, value, Transport, TRANSPORT_LABEL, errors);
				else if (ompOwned) config[key] = value;
				break;
			case "command":
				config.command = checked(key, value, z.string(), "a string", errors);
				break;
			case "args":
				config.args = checked(key, value, StringArray, "an array of strings", errors);
				break;
			case "env":
				config.env = checked(key, value, StringRecord, "an object of strings", errors);
				break;
			case "cwd":
				config.cwd = checked(key, value, z.string(), "a string", errors);
				break;
			case "url":
				config.url = checked(key, value, z.string(), "a string", errors);
				break;
			case "headers":
				config.headers = checked(key, value, StringRecord, "an object of strings", errors);
				break;
			case "enabled":
				config.enabled = coerceEnabled(value, dialect, errors);
				break;
			case "timeout":
				config.timeout = coerceTimeout(value, dialect, errors);
				break;
			case "requestIdFormat":
				config.requestIdFormat = checked(key, value, RequestIdFormat, `"number" or "string"`, errors);
				break;
			case "instructions":
				config.instructions = checked(key, value, z.boolean(), "a boolean", errors);
				break;
			case "auth":
				config.auth = checked(key, value, AuthConfig, `an object with type "oauth" or "apikey"`, errors);
				break;
			case "oauth":
				config.oauth = checked(key, value, OAuthConfig, "an OAuth settings object", errors);
				break;
			default:
				if (ompOwned) config[key] = value;
		}
	}
	for (const key of Object.keys(config)) if (config[key] === undefined) delete config[key];
	return config;
}

/** Parse one entry of a provider's server map into its written and effective (expanded) forms. */
export function parseEntry(
	name: string,
	value: unknown,
	dialect: FieldDialect,
	env: NodeJS.ProcessEnv,
	options: { expand: boolean } = { expand: true },
): ParsedServer {
	const record = JsonRecord.safeParse(value);
	const raw = record.success ? record.data : {};
	const errors: string[] = record.success ? [] : [`Server "${name}" is not an object`];
	const unresolved = new Set<string>();
	const config = normalizeEntry(raw, dialect, errors);
	let effective = config;
	if (options.expand) {
		const expanded = JsonRecord.parse(expandEnvVarsDeep(raw, env, unresolved));
		effective = normalizeEntry(expanded, dialect, []);
	}
	return { name, raw, config, effective, errors, unresolvedVars: [...unresolved].sort() };
}

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

/** omp's transport inference (`convertToLegacyConfig`). */
export function transportOf(config: McpServerConfig): McpTransport {
	return config.type ?? (config.command ? "stdio" : config.url ? "http" : "stdio");
}

/** omp's `validateServerName` (config writer). Returns an error message or null. */
export function validateServerName(name: string): string | null {
	if (!name) return "Server name cannot be empty";
	if (name.length > 100) return "Server name is too long (max 100 characters)";
	if (!/^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/.test(name)) {
		return "Server name can only contain letters, numbers, dash, underscore, dot, colon, and single spaces";
	}
	return null;
}

/** omp's `validateServerConfig`, applied before every add/update. */
export function validateServerConfig(name: string, config: McpServerConfig): string[] {
	const errors: string[] = [];
	const type = config.type ?? "stdio";
	if (config.command && config.url) {
		errors.push(
			`Server "${name}": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both`,
		);
	}
	if (type === "stdio") {
		if (!config.command) errors.push(`Server "${name}": stdio server requires "command" field`);
	} else if (type === "http" || type === "sse") {
		if (!config.url) errors.push(`Server "${name}": ${type} server requires "url" field`);
	} else {
		errors.push(`Server "${name}": unknown server type "${String(type)}"`);
	}
	return errors;
}

/** The MCP capability's own `validate` (drops the server at discovery). Returns an error message or null. */
export function capabilityError(config: McpServerConfig): string | null {
	if (!config.command && !config.url) return "Must have command or url";
	if (config.type === "stdio" && !config.command) return "stdio transport requires command field";
	if ((config.type === "http" || config.type === "sse") && !config.url) return "http/sse transport requires url field";
	return null;
}
