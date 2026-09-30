/**
 * Agents hub contract: omp task agents (bundled + custom markdown definitions), their enable/disable
 * state and per-agent model overrides.
 *
 * Sources, in omp's precedence order (first definition of a name wins, names are case-sensitive):
 * 1. project — nearest `<dir>/.omp/agents/*.md` walking up from the project cwd
 * 2. user — `<agentDir>/agents/*.md` (`~/.omp/agent/agents`)
 * 3. bundled — `scout`, `reviewer`, `security-reviewer`, `task`, `sonic`, read via `omp agents unpack`
 *
 * Not covered: agents contributed by omp extension packages (`<ext>/agents`) and Claude marketplace
 * plugins. omp has no CLI that lists the effective agent set, so those roots are not enumerated here.
 *
 * Settings are written to the global `config.yml` (comment-preserving): `task.disabledAgents` and
 * `task.agentModelOverrides`. A project settings layer can still shadow the saved value;
 * {@link AgentSettingsResult.shadowedBy} reports it.
 */

export type AgentScope = "bundled" | "user" | "project";
/** Scopes an agent file can be written to. */
export type AgentWritableScope = Exclude<AgentScope, "bundled">;

/** Agent names omp reserves for the top-level/sub session sentinels; definitions using them are rejected. */
export const AGENT_RESERVED_NAMES = ["main", "sub"] as const;

/** Thinking selectors accepted in `thinking-level` frontmatter (omp v18). */
export const AGENT_THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

/** omp built-in tool names (v18) for the tool picker. Extension/MCP tool names are also valid. `yield` is always added. */
export const AGENT_BUILTIN_TOOLS = [
	"read",
	"bash",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"ida",
	"eval",
	"github",
	"glob",
	"grep",
	"find",
	"lsp",
	"checkpoint",
	"rewind",
	"context_notes",
	"new_context",
	"security_scan",
	"task",
	"wait",
	"todo",
	"web_search",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
] as const;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Normalized agent fields, as omp's `parseAgentFields` reads them from frontmatter. */
export interface AgentFields {
	name: string;
	description: string;
	/** Explicit tool allow-list (always includes `yield`); undefined = all tools. */
	tools?: string[];
	/** Agents this one may spawn; `"*"` = any. Inferred as `"*"` when tools include `task`. */
	spawns?: string[] | "*";
	/** Prioritized model selectors (role aliases like `@smol` allowed). */
	model?: string[];
	thinkingLevel?: AgentThinkingLevel;
	/** Structured output schema (JTD-style), passed through opaquely. */
	output?: JsonValue;
	blocking?: boolean;
	autoloadSkills?: string[];
	/** false = `read` returns verbatim content instead of structural summaries. */
	readSummarize?: boolean;
	/** true = prewalk into the default target; string = target model pattern. */
	prewalk?: boolean | string;
	/** true = default advisor-role model; string = advisor model pattern. */
	advisor?: boolean | string;
}

export interface AgentEntry extends AgentFields {
	/** Stable id: the file path, or `bundled:<name>`. */
	id: string;
	scope: AgentScope;
	/** Absolute `.md` path; null for bundled agents. */
	filePath: string | null;
	/** Markdown body after the frontmatter. */
	systemPrompt: string;
	/** False when the name is in `task.disabledAgents`. */
	enabled: boolean;
	/** `task.agentModelOverrides[name]` normalized to a list; null when unset. Takes precedence over `model`. */
	modelOverride: string[] | null;
	/** The definition omp actually uses for this name (not shadowed by a higher-precedence scope). */
	active: boolean;
	/** Scope of the definition that shadows this one; null when active. */
	shadowedBy: AgentScope | null;
	/** Lower-precedence scopes this definition overrides (e.g. a user copy of a bundled agent). */
	overrides: AgentScope[];
	/** Non-fatal frontmatter problems (YAML fallback parsing, unknown thinking level, …). */
	warnings: string[];
}

/** A custom agent file omp skips because it cannot be parsed into a valid definition. */
export interface AgentFileError {
	filePath: string;
	scope: AgentWritableScope;
	message: string;
	/** Frontmatter `name` when readable, for display. */
	name: string | null;
}

export interface AgentDirs {
	user: string;
	/** Existing nearest project agents dir omp reads; null when none exists yet. */
	project: string | null;
	/** Where project agents are created when `project` is null (`<cwd>/.omp/agents`); null without a cwd. */
	projectDefault: string | null;
}

export interface AgentsSnapshot {
	/** Every definition from every scope, in precedence order (shadowed ones included, `active: false`). */
	agents: AgentEntry[];
	errors: AgentFileError[];
	dirs: AgentDirs;
	/** Effective `task.disabledAgents`. */
	disabled: string[];
	/** Effective `task.agentModelOverrides` (values normalized to lists). */
	modelOverrides: Record<string, string[]>;
}

/**
 * Structured agent edit. On create, `undefined`/`null` fields are omitted. On update, `undefined`
 * leaves the frontmatter key untouched, `null` removes it, a value replaces it; comments and unknown
 * keys are preserved.
 */
export interface AgentDraft {
	name?: string;
	description?: string;
	systemPrompt?: string;
	tools?: string[] | null;
	spawns?: string[] | "*" | null;
	model?: string[] | null;
	thinkingLevel?: AgentThinkingLevel | null;
	output?: JsonValue | null;
	blocking?: boolean | null;
	autoloadSkills?: string[] | null;
	readSummarize?: boolean | null;
	prewalk?: boolean | string | null;
	advisor?: boolean | string | null;
}

export interface AgentCreateDraft extends AgentDraft {
	name: string;
	description: string;
	systemPrompt: string;
}

/** Result of parsing agent markdown without touching disk (live editor validation). */
export type AgentValidation =
	| { ok: true; fields: AgentFields; systemPrompt: string; warnings: string[] }
	| { ok: false; error: string; warnings: string[] };

export interface AgentFile {
	filePath: string;
	scope: AgentWritableScope;
	content: string;
	validation: AgentValidation;
}

export interface AgentSettingsResult {
	/** Effective values for the given cwd after the change. */
	disabled: string[];
	modelOverrides: Record<string, string[]>;
	/**
	 * Why the saved global value is not the effective one: `project` = the project's
	 * `.omp/config.yml` sets the key; `other` = another layer (`.omp/settings.json`,
	 * `.claude/settings.json`, env or `--config` overlay). null when the change took effect.
	 */
	shadowedBy: "project" | "other" | null;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** All agents for a project (omit cwd for user + bundled only). `refresh` re-reads bundled agents from omp. */
		"agents:list": { args: [cwd?: string | null, refresh?: boolean]; result: AgentsSnapshot };
		/** Raw content + validation of a custom agent file inside a user/project agents dir. */
		"agents:read": { args: [filePath: string]; result: AgentFile };
		/** Parse agent markdown without saving (for live validation in an editor). */
		"agents:validate": { args: [content: string]; result: AgentValidation };
		/**
		 * Create `<scope dir>/<slug(name)>.md` (project scope: nearest existing `.omp/agents`, else
		 * `<cwd>/.omp/agents`). Fails if the file exists or the draft is invalid.
		 */
		"agents:create": {
			args: [draft: AgentCreateDraft, scope: AgentWritableScope, cwd?: string | null];
			result: AgentFile;
		};
		/** Apply a structured edit to an existing custom agent file (keeps comments/unknown keys). Fails if the result is invalid. */
		"agents:update": { args: [filePath: string, draft: AgentDraft]; result: AgentFile };
		/** Overwrite a custom agent file with raw markdown. Saves even when invalid; the validation reports what omp will do. */
		"agents:writeRaw": { args: [filePath: string, content: string]; result: AgentFile };
		/** Delete a custom agent file (only `.md` files inside a user/project agents dir). */
		"agents:delete": { args: [filePath: string]; result: void };
		/**
		 * Copy a bundled agent into a scope so it can be edited (same output as `omp agents unpack`,
		 * which does not carry `read-summarize`, `autoload-skills`, `prewalk` or `advisor`). Fails if the
		 * target file exists unless `overwrite`.
		 */
		"agents:customize": {
			args: [name: string, scope: AgentWritableScope, cwd?: string | null, overwrite?: boolean];
			result: AgentFile;
		};
		/** Toggle the name in `task.disabledAgents`. */
		"agents:setEnabled": {
			args: [name: string, enabled: boolean, cwd?: string | null];
			result: AgentSettingsResult;
		};
		/** Set (`null` clears) `task.agentModelOverrides[name]`; a list is tried in order. */
		"agents:setModelOverride": {
			args: [name: string, model: string[] | null, cwd?: string | null];
			result: AgentSettingsResult;
		};
	}
	interface IpcEventMap {
		/**
		 * Agent files or agent settings changed through this app. `cwd` is the affected project, or null
		 * when any project may be affected (user files, global settings, edits addressed by path).
		 */
		"agents:changed": { cwd: string | null };
	}
}
