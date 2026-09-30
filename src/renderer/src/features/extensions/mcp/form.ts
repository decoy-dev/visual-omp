/** The custom MCP server form: plain fields ⇄ omp's `McpServerConfig`. */
import type { McpScope, McpServerConfig, McpTransport } from "@shared/contracts/mcp";
import { joinCommandLine, splitCommandLine } from "../format";

export interface KeyValueRow {
	key: string;
	value: string;
}

export interface McpForm {
	name: string;
	transport: McpTransport;
	/** stdio: the whole command line (`npx -y @modelcontextprotocol/server-memory`). */
	commandLine: string;
	/** http/sse endpoint. */
	url: string;
	/** stdio environment variables. */
	env: KeyValueRow[];
	/** http/sse request headers. */
	headers: KeyValueRow[];
	scope: McpScope;
}

export type McpFormError = "nameRequired" | "nameInvalid" | "nameTaken" | "commandRequired" | "urlRequired" | "urlInvalid";

export interface McpFormErrors {
	name?: McpFormError;
	command?: McpFormError;
	url?: McpFormError;
}

/** omp's server-name rule: letters, digits, `_ - . :`, single inner spaces, at most 100 characters. */
const NAME_PATTERN = /^[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+)*$/;

export function emptyForm(scope: McpScope): McpForm {
	return { name: "", transport: "stdio", commandLine: "", url: "", env: [], headers: [], scope };
}

function rows(record: Record<string, string> | undefined): KeyValueRow[] {
	return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

function record(list: readonly KeyValueRow[]): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const row of list) {
		const key = row.key.trim();
		if (key) out[key] = row.value;
	}
	return Object.keys(out).length ? out : undefined;
}

export function formFromConfig(name: string, config: McpServerConfig, scope: McpScope): McpForm {
	const transport = config.type ?? "stdio";
	return {
		name,
		transport,
		commandLine: config.command ? joinCommandLine([config.command, ...(config.args ?? [])]) : "",
		url: config.url ?? "",
		env: rows(config.env),
		headers: rows(config.headers),
		scope,
	};
}

/**
 * Build the config to save. `base` is the stored entry being edited: fields the form doesn't show
 * (timeout, auth, cwd, unknown keys) are kept; fields of the other transport are dropped.
 */
export function configFromForm(form: McpForm, base: McpServerConfig = {}): McpServerConfig {
	const { type: baseType, command: _c, args: _a, env: _e, url: _u, headers: _h, cwd, ...rest } = base;
	if (form.transport === "stdio") {
		const [command, ...args] = splitCommandLine(form.commandLine.trim());
		const env = record(form.env);
		return {
			// omp treats a missing `type` as stdio; keep an explicit one only when it was already written.
			...(baseType === "stdio" ? { type: "stdio" as const } : {}),
			...(command ? { command } : {}),
			...(args.length ? { args } : {}),
			...(env ? { env } : {}),
			...(cwd ? { cwd } : {}),
			...rest,
		};
	}
	const headers = record(form.headers);
	return { type: form.transport, url: form.url.trim(), ...(headers ? { headers } : {}), ...rest };
}

/** Field problems, as i18n codes. `takenNames` are the other servers already in the target file. */
export function validateForm(form: McpForm, takenNames: readonly string[] = []): McpFormErrors {
	const errors: McpFormErrors = {};
	const name = form.name.trim();
	if (!name) errors.name = "nameRequired";
	else if (name.length > 100 || !NAME_PATTERN.test(name)) errors.name = "nameInvalid";
	else if (takenNames.includes(name)) errors.name = "nameTaken";
	if (form.transport === "stdio") {
		if (!splitCommandLine(form.commandLine.trim())[0]) errors.command = "commandRequired";
	} else {
		const url = form.url.trim();
		if (!url) errors.url = "urlRequired";
		// `${VAR}` placeholders are expanded by omp, so only check the scheme.
		else if (!/^https?:\/\//i.test(url)) errors.url = "urlInvalid";
	}
	return errors;
}

/** Command line or URL shown in list rows. */
export function endpointOf(config: McpServerConfig): string {
	if ((config.type ?? "stdio") === "stdio") return joinCommandLine([config.command ?? "", ...(config.args ?? [])]).trim();
	return config.url ?? "";
}
