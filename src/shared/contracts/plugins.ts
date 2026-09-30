/**
 * Plugins contract: omp plugin management through `omp plugin …` (omp v18).
 *
 * Two kinds of installed plugins:
 * - **npm/link** — packages under `~/.omp/plugins/node_modules` installed from npm, git (`github:user/repo`,
 *   `https://…#ref`) or linked from a local directory. They carry an omp manifest (`package.json` `omp`/`pi`
 *   field) with optional *features* and a *settings* schema. Runtime state lives in `omp-plugins.lock.json`.
 * - **marketplace** — Claude-compatible plugins installed from a configured marketplace as `name@marketplace`,
 *   at `user` scope (`~/.omp/plugins/installed_plugins.json`) or `project` scope (nearest `.omp/plugins/`).
 *   An enabled project install shadows the user install of the same id.
 *
 * Every channel that takes `cwd` runs omp there, which decides the project (project-scope marketplace
 * registry, `.omp/plugin-overrides.json`). Omitted `cwd` = the home directory (user scope only).
 *
 * Error model: install / uninstall / upgrade / marketplace add·update·remove return a
 * {@link PluginOperationResult} (never reject for omp failures — show `error` and `log`). Quick queries and
 * settings writes (`list`, `features:*`, `config:*`, `setEnabled`, `doctor`, `discover`) reject with omp's
 * message.
 *
 * Long operations stream output: pass your own `opId` (e.g. `crypto.randomUUID()`) and subscribe to
 * `plugins:progress` before invoking; `plugins:cancel` kills a running operation. Mutations broadcast
 * `plugins:changed` afterwards.
 *
 * omp capability gaps (no channel offered):
 * - resetting a plugin's features back to manifest defaults (`enabledFeatures: null`) — the CLI can only
 *   write explicit lists;
 * - per-project disables/feature overrides for npm plugins (`.omp/plugin-overrides.json` has no CLI writer);
 * - `omp plugin marketplace list` and `omp plugin discover` have no `--json`; their text output is parsed,
 *   so catalog fields beyond name / version / description (author, category, tags, source) are unavailable;
 * - marketplace installs print no JSON; the installed version is parsed from omp's confirmation line.
 */

export type PluginScope = "user" | "project";

/** One optional feature declared in an npm plugin's manifest. */
export interface PluginFeatureInfo {
	name: string;
	description: string | null;
	/** Enabled when the plugin uses manifest defaults (`enabledFeatures: null`). */
	default: boolean;
	/** Effective state: explicit list membership, or `default` when the plugin uses defaults. */
	enabled: boolean;
}

export type PluginSettingType = "string" | "number" | "boolean" | "enum";

/** One entry of an npm plugin's settings schema (`omp.settings`). */
export interface PluginSettingInfo {
	key: string;
	type: PluginSettingType;
	description: string | null;
	/** Mask the value in UI. */
	secret: boolean;
	/** Environment variable used as fallback when unset. */
	env: string | null;
	default: string | number | boolean | null;
	/** Allowed values for `enum` settings; empty otherwise. */
	values: string[];
	min: number | null;
	max: number | null;
	step: number | null;
}

/** An npm/git/linked plugin from `omp plugin list --json` (`npm` section). */
export interface NpmPlugin {
	kind: "npm";
	/** Package name; the handle for every other npm-plugin channel. */
	name: string;
	version: string;
	/** Absolute package directory (inside the plugins `node_modules`, possibly a symlink for linked plugins). */
	path: string;
	description: string | null;
	enabled: boolean;
	/** Explicit feature list, or null when the plugin uses manifest defaults. */
	enabledFeatures: string[] | null;
	features: PluginFeatureInfo[];
	settings: PluginSettingInfo[];
	/** Entry points declared by the manifest (paths relative to the package). */
	entryPoints: { tools: string | null; hooks: string | null; extensions: string[]; commands: string[] };
}

/** One scope's install record of a marketplace plugin. */
export interface MarketplacePluginInstall {
	scope: PluginScope;
	/** Absolute cached plugin directory. */
	installPath: string;
	version: string;
	/** ISO 8601. */
	installedAt: string;
	/** ISO 8601. */
	lastUpdated: string;
	gitCommitSha: string | null;
	enabled: boolean;
}

/** A marketplace plugin from `omp plugin list --json` (`marketplace` section); one entry per id + scope. */
export interface MarketplacePlugin {
	kind: "marketplace";
	/** `name@marketplace`; the handle for uninstall / enable / disable / upgrade. */
	id: string;
	name: string;
	marketplace: string;
	scope: PluginScope;
	version: string;
	enabled: boolean;
	/** A project-scope install of the same id takes precedence over this user-scope one. */
	shadowedByProject: boolean;
	installs: MarketplacePluginInstall[];
}

export interface PluginsListing {
	npm: NpmPlugin[];
	marketplace: MarketplacePlugin[];
}

/** Outcome of a long-running plugin operation. */
export interface PluginOperationResult {
	opId: string;
	ok: boolean;
	/** omp's failure message (without the `✘` glyph); null on success. */
	error: string | null;
	/** Every non-empty output line (stdout and stderr, ANSI stripped) in arrival order. */
	log: string[];
}

export interface PluginInstallRequest {
	/**
	 * What to install, as `omp plugin install` accepts it:
	 * - npm: `pkg`, `@scope/pkg@1.2.0`, optionally with features `pkg[feat1,feat2]` / `pkg[*]`
	 * - git: `github:user/repo`, `https://github.com/user/repo#v1.0`
	 * - local directory: `./path` or `/abs/path` (linked, source edits apply without reinstall)
	 * - marketplace: `name@marketplace` for a configured marketplace
	 */
	spec: string;
	/** Marketplace installs only (omp ignores it for npm/local specs). Default `user`. */
	scope?: PluginScope;
	/** Reinstall over an existing install. */
	force?: boolean;
	cwd?: string;
	opId?: string;
}

export interface PluginInstallResult extends PluginOperationResult {
	/** The installed npm/git/linked plugin as omp reported it; null for marketplace installs and failures. */
	installed: NpmPlugin | null;
	/** Set for successful marketplace installs. */
	marketplace: { name: string; marketplace: string; version: string } | null;
}

export interface PluginUninstallRequest {
	/** npm package name, or marketplace id (`name@marketplace`; a bare name works when unambiguous). */
	name: string;
	/** Marketplace plugins: which scope's install to remove. */
	scope?: PluginScope;
	cwd?: string;
	opId?: string;
}

export interface PluginUpgradeRequest {
	/**
	 * Marketplace id (`name@marketplace`) or bare name. Omit to upgrade every marketplace plugin.
	 * npm/git plugins: omp v18.4 has no in-place upgrade — reinstall with `force: true` instead.
	 */
	id?: string;
	/** Only upgrade this scope's install (single-id upgrades). */
	scope?: PluginScope;
	cwd?: string;
	opId?: string;
}

export interface PluginUpgrade {
	id: string;
	scope: PluginScope | null;
	/** Previous version when omp reported it. */
	from: string | null;
	to: string;
}

export interface PluginUpgradeResult extends PluginOperationResult {
	upgrades: PluginUpgrade[];
}

/** `omp plugin features <name> --json`. */
export interface PluginFeatureState {
	plugin: string;
	/** Explicit list, or null when the plugin uses manifest defaults. */
	enabledFeatures: string[] | null;
	availableFeatures: string[];
}

/** `omp plugin config list <name> --json`. */
export interface PluginConfig {
	plugin: string;
	/** Stored values keyed by setting key (unset keys absent; secrets unmasked — mask by `schema[].secret`). */
	values: Record<string, unknown>;
	schema: PluginSettingInfo[];
}

export interface PluginConfigValidation {
	valid: boolean;
	errors: { plugin: string; key: string; error: string }[];
}

export type PluginDoctorStatus = "ok" | "warning" | "error";

export interface PluginDoctorCheck {
	/** Check id, e.g. `plugins_directory`, `node_modules`, `plugin:<name>`. */
	name: string;
	status: PluginDoctorStatus;
	message: string;
	/** `fix: true` repaired this issue. */
	fixed: boolean;
}

export interface PluginDoctorReport {
	checks: PluginDoctorCheck[];
	/** No unfixed errors. */
	healthy: boolean;
}

/** A configured marketplace (`omp plugin marketplace list`). */
export interface MarketplaceSource {
	name: string;
	/** What it was added from: `owner/repo`, git URL, catalog URL or local path. */
	sourceUri: string;
}

export interface MarketplaceAddResult extends PluginOperationResult {
	/** The newly configured marketplace; null on failure. */
	added: MarketplaceSource | null;
}

/** A plugin offered by a marketplace catalog (`omp plugin discover <marketplace>`). */
export interface AvailablePlugin {
	/** `name@marketplace`, the install spec. */
	id: string;
	name: string;
	marketplace: string;
	version: string | null;
	description: string | null;
	/** Scopes this plugin is already installed at. */
	installedScopes: PluginScope[];
}

/** Streamed output line of a running plugin operation. */
export interface PluginProgress {
	opId: string;
	stream: "stdout" | "stderr";
	line: string;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Installed npm/linked and marketplace plugins as seen from `cwd`. */
		"plugins:list": { args: [cwd?: string]; result: PluginsListing };
		/** Install a plugin (npm, git, local path or `name@marketplace`); streams `plugins:progress`. */
		"plugins:install": { args: [request: PluginInstallRequest]; result: PluginInstallResult };
		/** Uninstall an npm plugin or marketplace plugin; streams `plugins:progress`. */
		"plugins:uninstall": { args: [request: PluginUninstallRequest]; result: PluginOperationResult };
		/** Upgrade one marketplace plugin, or all of them when `id` is omitted; streams `plugins:progress`. */
		"plugins:upgrade": { args: [request: PluginUpgradeRequest]; result: PluginUpgradeResult };
		/**
		 * Enable or disable a plugin. `name` is an npm package name or marketplace id; `scope` picks the
		 * marketplace install to change (npm plugins are global).
		 */
		"plugins:setEnabled": {
			args: [name: string, enabled: boolean, options?: { scope?: PluginScope; cwd?: string }];
			result: void;
		};
		/** Current feature selection of an npm plugin. */
		"plugins:features:get": { args: [name: string, cwd?: string]; result: PluginFeatureState };
		/** Replace an npm plugin's enabled feature list (`[]` disables all optional features). */
		"plugins:features:set": { args: [name: string, features: string[], cwd?: string]; result: PluginFeatureState };
		/** Settings values and schema of an npm plugin. */
		"plugins:config:get": { args: [name: string, cwd?: string]; result: PluginConfig };
		/**
		 * Set one plugin setting; `value` is text as typed (omp parses it per schema type and validates
		 * enum/min/max — rejects with omp's message, e.g. "Must be <= 5"). Resolves with the updated config.
		 */
		"plugins:config:set": { args: [name: string, key: string, value: string, cwd?: string]; result: PluginConfig };
		/** Remove a stored plugin setting (falls back to default / env). Resolves with the updated config. */
		"plugins:config:delete": { args: [name: string, key: string, cwd?: string]; result: PluginConfig };
		/** Validate stored settings of every installed plugin against their schemas. */
		"plugins:config:validate": { args: [cwd?: string]; result: PluginConfigValidation };
		/** Plugin health checks; `fix` attempts automatic repair. */
		"plugins:doctor": { args: [options?: { fix?: boolean; cwd?: string }]; result: PluginDoctorReport };
		/** Configured marketplaces. */
		"plugins:marketplace:list": { args: []; result: MarketplaceSource[] };
		/** Add a marketplace (`owner/repo`, git URL, `https://…/marketplace.json`, local path); may clone. */
		"plugins:marketplace:add": { args: [source: string, opId?: string]; result: MarketplaceAddResult };
		/** Remove a configured marketplace by name. */
		"plugins:marketplace:remove": { args: [name: string, opId?: string]; result: PluginOperationResult };
		/** Re-fetch one marketplace catalog, or all when `name` is omitted. */
		"plugins:marketplace:update": { args: [name?: string, opId?: string]; result: PluginOperationResult };
		/** Plugins offered by one marketplace, or by every configured marketplace when omitted. */
		"plugins:discover": { args: [marketplace?: string, cwd?: string]; result: AvailablePlugin[] };
		/** Kill a running operation started with `opId`; false when none is running. */
		"plugins:cancel": { args: [opId: string]; result: boolean };
	}

	interface IpcEventMap {
		/** Output line of a running install / uninstall / upgrade / marketplace operation. */
		"plugins:progress": PluginProgress;
		/** Installed plugins or marketplaces changed (`cwd` of the mutation, null for user-scope changes). */
		"plugins:changed": { cwd: string | null };
	}
}
