/**
 * omp settings, models, model roles/presets, tool approval and provider login status.
 *
 * Every read takes an optional project `cwd`: omp resolves settings as
 * environment → project (`<cwd>/.omp/config.yml`, `.omp/settings.json`, `.claude/settings.json`, …)
 * → global (`<agentDir>/config.yml`) → schema default. Without `cwd` only the global layer applies.
 *
 * Sources used in main (all read-only unless noted):
 * - `omp config list --json` (values, types, descriptions), `omp read cfg://` (enum values and
 *   defaults), `omp read cfg://<key>` (authoritative source layer), `omp config path` (agent dir).
 * - `omp models --json --kind all`, `omp models refresh --json --kind all`.
 * - `omp usage --json` (logged-in accounts).
 * - Writes edit the YAML file of the chosen scope in place with the `yaml` Document API (comments
 *   and formatting are kept), then re-load it through `omp config get` and roll back if omp rejects
 *   it. `omp config set` is not used for writes because it only targets the global file.
 *
 * omp capability gaps (no channel, by design):
 * - The settings-panel metadata (tab, group, label, submenu option labels) is not exposed by any
 *   omp CLI; {@link SettingInfo.namespace} (the dotted prefix) is the only grouping available.
 * - `omp models` lists only models that are usable right now (credentials configured or keyless);
 *   there is no CLI listing of the full catalog including unauthenticated providers, nor of the
 *   OAuth providers `omp login <provider>` accepts.
 * - Applying a model preset cannot switch the model of a chat that is already running: omp only
 *   exposes that through the TUI (`/modelpreset switch <name>`); a running omp live-reloads the
 *   role assignments from disk, and new chats start with them.
 */

// ─── Settings ──────────────────────────────────────────────────────────────

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Declared value kind of a setting (omp registry `type`). */
export type SettingType = "boolean" | "string" | "number" | "enum" | "array" | "record";

/** Config layer a write targets. */
export type SettingScope = "global" | "project";

/**
 * Layer supplying a setting's effective value, highest precedence first: environment variable,
 * runtime override, `--config` overlay, project config, global config, schema default.
 * The app never passes overlays or runtime overrides, so `overlay`/`runtime` only appear when
 * `PI_CONFIG_FILES` is set in the user's environment.
 */
export type SettingSource = "env" | "runtime" | "overlay" | "project" | "global" | "default";

export interface SettingInfo {
	/** Dotted setting id as written in config files, e.g. `compaction.enabled`. */
	key: string;
	/** Dotted prefix of {@link key} (`compaction` for `compaction.enabled`); null for top-level keys. */
	namespace: string | null;
	type: SettingType;
	/** omp's description; empty for config-file-only settings. */
	description: string;
	/** Allowed values for `enum` settings; null otherwise. */
	enumValues: string[] | null;
	/** Schema default; null when the setting has no default (unset). */
	defaultValue: JsonValue;
	/** Effective value for the requested cwd; null when unset or {@link redacted}. */
	value: JsonValue;
	/** A credential is configured; its value is withheld everywhere (also from the layer values). */
	redacted: boolean;
	/** Effective value differs from the default (always true for a configured credential). */
	modified: boolean;
	source: SettingSource;
	/** Raw value in the global config file; null when absent or redacted. */
	globalValue: JsonValue;
	/** Raw value in `<cwd>/.omp/config.yml`; null when absent, redacted, or no cwd was given. */
	projectValue: JsonValue;
}

export interface ConfigSnapshot {
	/** Project directory the values were resolved for; null = global only. */
	cwd: string | null;
	/** omp agent dir (`omp config path`; honours `PI_CODING_AGENT_DIR` and profiles). */
	agentDir: string;
	/** Global config file (`config.yml`, or an existing `config.yaml`). */
	globalFile: string;
	/** `<cwd>/.omp/config.yml`; null without cwd. */
	projectFile: string | null;
	/** Every registered setting, sorted by key. */
	settings: SettingInfo[];
}

export interface SettingWriteResult {
	/** The setting after the write, re-read through omp. */
	setting: SettingInfo;
	/**
	 * Higher layer that still decides the effective value, so the write has no visible effect here
	 * (e.g. `project` after a global write, `env` when an environment variable overrides it). null when
	 * the written layer is effective.
	 */
	shadowedBy: SettingSource | null;
}

/** Which config file changed on disk (not emitted for the app's own writes). */
export interface ConfigChangedEvent {
	scope: SettingScope;
	/** Project directory for `project` changes; null for the global file. */
	cwd: string | null;
	file: string;
}

// ─── Models ────────────────────────────────────────────────────────────────

/** omp catalog kind. Chat roles take `chat`; the kind roles take the matching runner kind. */
export type ModelKind = "chat" | "tiny" | "image" | "tts" | "stt" | "search" | "judge" | "embedding" | "rerank" | "video";

/** Provider reasoning effort a model supports. */
export type ThinkingEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** USD per million tokens. */
export interface ModelTokenCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelCost extends ModelTokenCost {
	/** Higher pricing that applies once the prompt exceeds `inputThreshold` tokens. */
	longContext: (ModelTokenCost & { inputThreshold: number }) | null;
}

/**
 * A model omp can use right now. `omp models` only lists available models (credentials configured
 * or keyless local runners), so every entry is usable; see `providers:list` for accounts.
 */
export interface ModelInfo {
	/** `provider/id`, the value model roles store (before an optional `:thinking` suffix). */
	selector: string;
	provider: string;
	id: string;
	name: string;
	kind: ModelKind;
	/** Tokens; null when the catalog does not say (local runners). */
	contextWindow: number | null;
	maxOutputTokens: number | null;
	/** Model reasons (thinks) at all. */
	reasoning: boolean;
	/** Efforts selectable as a role `:suffix`; empty when thinking is not controllable. */
	thinkingLevels: ThinkingEffort[];
	/** Catalog declares image input. */
	vision: boolean;
	/** null when the catalog has no pricing. */
	cost: ModelCost | null;
}

// ─── Model roles & presets ─────────────────────────────────────────────────

/** The 15 built-in roles, in omp's display order. */
export const BUILT_IN_MODEL_ROLES = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
] as const;
export type BuiltInModelRole = (typeof BUILT_IN_MODEL_ROLES)[number];

/**
 * Thinking selector a role value may carry as `provider/model:<level>`. `inherit` keeps the
 * session level, `off` disables thinking, `auto` lets omp pick per prompt.
 */
export type RoleThinking = "inherit" | "off" | ThinkingEffort | "auto";

/** Session default thinking level (`defaultThinkingLevel`). */
export type DefaultThinkingLevel = ThinkingEffort | "auto";

export interface ModelRoleInfo {
	/** Role id (`default`, `smol`, … or a custom role name). */
	id: string;
	/** Display name: `modelTags.<id>.name`, else omp's built-in name ("Fast" for smol), else the id. */
	name: string;
	builtIn: boolean;
	/** `chat` roles pick chat models; `kind` roles pick a runner kind (image, web search, speech…). */
	section: "chat" | "kind";
	/**
	 * Catalog kinds omp accepts for this role. `web` also accepts chat models with built-in web
	 * search, which the CLI does not flag, so it lists `chat` too.
	 */
	acceptsKinds: ModelKind[];
	/** omp theme colour name from `modelTags` or the built-in; null when none. */
	color: string | null;
	/** Hidden from omp's model selector (`modelTags.<id>.hidden`). */
	hidden: boolean;
	/** Listed in `cycleOrder` (Ctrl+P model cycling). */
	inCycle: boolean;
	/** Effective stored value, e.g. `anthropic/claude-opus-5-5:high`, `@slow`, or a fuzzy pattern; null when unassigned (omp then picks automatically). */
	value: string | null;
	/** {@link value} without the thinking suffix. */
	model: string | null;
	/** Thinking suffix of {@link value}; null when none. */
	thinking: RoleThinking | null;
	/** Layer supplying {@link value}; `default` when unassigned. */
	source: "project" | "global" | "default";
	/** Value in the global config file. */
	globalValue: string | null;
	/** Value in `<cwd>/.omp/config.yml`. */
	projectValue: string | null;
}

export interface ModelRolesState {
	cwd: string | null;
	/** `modelRoleStorage`: where role edits are written by default. */
	storage: SettingScope;
	storageSource: SettingSource;
	defaultThinkingLevel: DefaultThinkingLevel;
	/** Built-in roles first (display order), then custom roles from assignments, `cycleOrder` and `modelTags`. */
	roles: ModelRoleInfo[];
}

/** A role assignment; `thinking` null/omitted writes no suffix. */
export interface RoleAssignment {
	/** `provider/id`, `@role` alias, or any selector omp accepts (no thinking suffix). */
	model: string;
	thinking?: RoleThinking | null;
}

export interface RoleWriteOptions {
	cwd?: string;
	/** Target layer; defaults to `modelRoleStorage`. `project` requires `cwd`. */
	scope?: SettingScope;
}

export interface ModelPresetInfo {
	/** Letter first, then letters, digits, `-` or `_`. */
	name: string;
	/** Layer defining it; a project preset replaces a same-name global one whole. */
	source: SettingScope;
	modelRoles: Record<string, string>;
	defaultThinkingLevel: DefaultThinkingLevel | null;
	/** Why omp would refuse this hand-edited entry; null when valid. */
	problem: string | null;
}

/** A role whose effective value differs from the applied preset. */
export interface PresetShadowedRole {
	role: string;
	/** Preset value; null when the preset leaves the role unset. */
	expected: string | null;
	actual: string | null;
	source: "project" | "global" | "default";
}

export interface PresetApplyResult {
	roles: ModelRolesState;
	/** Roles another layer still decides (e.g. global roles under project storage). Empty on a clean apply. */
	shadowed: PresetShadowedRole[];
	/** Set when the preset's thinking level is still overridden by a higher layer. */
	shadowedThinking: { expected: DefaultThinkingLevel; actual: DefaultThinkingLevel; source: SettingSource } | null;
}

/** `project`: the preset (also) lives in a project config and must be removed there. */
export type PresetDeleteResult = "deleted" | "missing" | "project";

// ─── Approval ──────────────────────────────────────────────────────────────

/**
 * `always-ask`: auto-approve read-only tools, ask for write and exec tools.
 * `write`: auto-approve read and workspace-write tools, ask for exec (bash, eval, browser, task…).
 * `yolo`: auto-approve everything (omp default); per-tool policies still apply.
 */
export type ApprovalMode = "always-ask" | "write" | "yolo";
/** Per-tool override honoured in every mode. */
export type ApprovalPolicy = "allow" | "prompt" | "deny";

export interface ToolApprovalPolicy {
	/** Tool name (`bash`, `edit`, an MCP tool name, …) or tool policy key (`write`). */
	tool: string;
	policy: ApprovalPolicy;
	/** Layer supplying the effective policy. */
	source: "project" | "global";
}

export interface ApprovalState {
	cwd: string | null;
	mode: ApprovalMode;
	modeSource: SettingSource;
	/** Sorted by tool. */
	policies: ToolApprovalPolicy[];
	/** `tools.approval` entries omp ignores because the value is not allow/prompt/deny. */
	unrecognized: { tool: string; value: JsonValue }[];
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Every setting with type, default, enum values, effective value and source. */
		"config:list": { args: [cwd?: string]; result: ConfigSnapshot };
		/** One setting; rejects for an unknown key. */
		"config:get": { args: [key: string, cwd?: string]; result: SettingInfo };
		/**
		 * Write a typed value into the global or project config file. Rejects when the value does not
		 * fit the setting's type/enum or omp refuses the resulting config (the file is then restored).
		 * `project` requires `cwd`.
		 */
		"config:set": {
			args: [key: string, value: JsonValue, scope: SettingScope, cwd?: string];
			result: SettingWriteResult;
		};
		/** Remove the key from that layer's file so lower layers or the default apply. */
		"config:reset": { args: [key: string, scope: SettingScope, cwd?: string]; result: SettingWriteResult };
		/**
		 * Start emitting `config:changed` for the global file and, with `cwd`, that project's
		 * `.omp/config.yml`. Reference-counted per cwd; pair with `config:unwatch`.
		 */
		"config:watch": { args: [cwd?: string]; result: void };
		"config:unwatch": { args: [cwd?: string]; result: void };

		/** Usable models of every kind for `cwd` (project settings can enable/disable providers). Cached 5 min and until config changes. */
		"config:models": { args: [cwd?: string]; result: ModelInfo[] };
		/** Force omp to re-fetch provider catalogs (`omp models refresh`), then list. */
		"config:models:refresh": { args: [cwd?: string]; result: ModelInfo[] };

		"config:roles": { args: [cwd?: string]; result: ModelRolesState };
		/**
		 * Assign (or with null, clear) a built-in or custom role. Clearing a project assignment makes
		 * the global one apply again. Custom role ids follow the preset name rule.
		 */
		"config:roles:set": {
			args: [role: string, assignment: RoleAssignment | null, options?: RoleWriteOptions];
			result: ModelRolesState;
		};

		/** Saved presets from the global and project config, sorted by name. */
		"config:presets": { args: [cwd?: string]; result: ModelPresetInfo[] };
		/** Save the effective roles and `defaultThinkingLevel` as a global preset (overwrites same name). */
		"config:presets:save": { args: [name: string, cwd?: string]; result: ModelPresetInfo };
		/**
		 * Write the preset's roles like omp's `/modelpreset switch`: into the `modelRoleStorage` scope,
		 * clearing roles the preset leaves out, plus its global `defaultThinkingLevel`. Rejects without
		 * writing when the preset is malformed or its default model is not available.
		 */
		"config:presets:apply": { args: [name: string, cwd?: string]; result: PresetApplyResult };
		/** Delete a global preset. */
		"config:presets:delete": { args: [name: string, cwd?: string]; result: PresetDeleteResult };

		"config:approval": { args: [cwd?: string]; result: ApprovalState };
		"config:approval:setMode": { args: [mode: ApprovalMode, scope: SettingScope, cwd?: string]; result: ApprovalState };
		/** Set `tools.approval.<tool>` in one layer; null removes the entry from that layer. */
		"config:approval:setPolicy": {
			args: [tool: string, policy: ApprovalPolicy | null, scope: SettingScope, cwd?: string];
			result: ApprovalState;
		};
	}

	interface IpcEventMap {
		/** A watched config file changed outside the app. Re-query what you display. */
		"config:changed": ConfigChangedEvent;
	}
}
