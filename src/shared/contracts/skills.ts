/**
 * Skills contract: the skills an omp session would load, why others are off, SKILL.md diagnostics,
 * skill toggles/settings, and the Skillshare registry (`omp skill …`, omp v18).
 *
 * Discovery is omp's own: `omp skill list <cwd> --json` reports the effective set exactly as a session in
 * `cwd` resolves it (provider precedence, collisions → `<namespace>/<name>`, filters). Disabled skills are
 * found with a second listing that runs omp with a temporary config overlay (`PI_CONFIG_FILES`) which clears
 * every skill filter and opts all sources in; the difference is attributed to the setting responsible.
 *
 * Providers omp loads skills from (`provider` values), highest precedence first:
 * - `native` — `~/.omp/agent/skills/<name>/SKILL.md` (user) and `.omp/skills/` walking up from cwd (project)
 * - `omp-plugins` — `skills/` of extension packages / installed npm plugins
 * - `claude` — `~/.claude/skills` (user, opt-in) and `.claude/skills` (project)
 * - `claude-plugins`, `agent-plugins` — skills inside Claude/marketplace plugins
 * - `agents` — `~/.agents/skills`, `~/.agent/skills` and project `.agents/skills` / `.agent/skills`
 * - `codex` — `~/.codex/skills` (user, opt-in) and `.codex/skills`
 * - `opencode` — `~/.config/opencode/skills` (user, opt-in) and `.opencode/skills`
 * - `github` — project `.github/skills`
 * - `skillshare` — registry packages installed with `omp skill install` (pinned by `skills.lock.json`)
 * - `omp-managed` — auto-learned skills under `~/.omp/agent/managed-skills` (always defers to authored ones)
 * - `custom` — directories listed in `skills.customDirectories`
 *
 * Toggling: omp disables a single skill with a `skill:<name>` entry in the global `disabledExtensions`
 * setting. Source toggles and glob filters live in {@link SkillsSettings}. Writes edit the global
 * `config.yml` in place (comments and formatting kept; a value equal to omp's default removes the key);
 * reads report the effective values from `omp config list`, so a project config layer can still win.
 *
 * Registry: `omp skill search|info` are JSON; install / update / uninstall print text, parsed into
 * {@link SkillChange}s. They stream output as `skills:progress`. omp has no JSON listing of registry installs
 * (`omp skill list` shows loaded skills), so `skills:registry:installed` reads `skills.json` /
 * `skills.lock.json` directly.
 */

/** Known `provider` ids (see file doc). Values outside this list come from newer omp versions. */
export const SKILL_PROVIDERS = [
	"native",
	"omp-plugins",
	"claude",
	"claude-plugins",
	"agent-plugins",
	"agents",
	"codex",
	"opencode",
	"github",
	"skillshare",
	"omp-managed",
	"custom",
] as const;
export type SkillProvider = (typeof SKILL_PROVIDERS)[number];

/** Display labels for {@link SkillProvider}. */
export const SKILL_PROVIDER_LABELS: Record<SkillProvider, string> = {
	native: "omp",
	"omp-plugins": "omp plugin",
	claude: "Claude Code",
	"claude-plugins": "Claude plugin",
	"agent-plugins": "Agent plugin",
	agents: "Agents (.agents)",
	codex: "Codex",
	opencode: "OpenCode",
	github: "GitHub (.github)",
	skillshare: "Skillshare registry",
	"omp-managed": "Auto-learned",
	custom: "Custom directory",
};

export type SkillLevel = "user" | "project";

/**
 * Why a discovered skill is not loaded, in omp's filter order:
 * - `skillsOff` — `skills.enabled` is false (no skills load at all)
 * - `disabled` — listed in `disabledExtensions` as `skill:<name>`; `skills:setEnabled` flips it
 * - `sourceDisabled` — its source is off: a `skills.enable*` toggle, `disabledProviders`, or a foreign
 *   user-level provider (claude/codex/opencode/github/claude-plugins in `~/`) not opted in via `enabledProviders`
 * - `ignored` — matches a `skills.ignoredSkills` glob
 * - `notIncluded` — `skills.includeSkills` is non-empty and does not match
 * - `duplicate` — an identical copy of a loaded skill, or superseded by it
 */
export type SkillDisabledReason = "skillsOff" | "disabled" | "sourceDisabled" | "ignored" | "notIncluded" | "duplicate";

export type SkillIssueCode =
	/** SKILL.md is empty; omp skips it. */
	| "empty"
	/** SKILL.md could not be read. */
	| "unreadable"
	/** No `---` frontmatter block: name falls back to the directory, description is empty. */
	| "noFrontmatter"
	/** Frontmatter is not valid YAML even after omp's lenient repair; omp falls back to `key: value` lines. */
	| "yamlError"
	/** Frontmatter parses to something other than a mapping; omp ignores it. */
	| "notMapping"
	/** No description: native, plugin, github and custom-directory loaders skip the skill; others load it blind. */
	| "missingDescription"
	/** `name`/`description` is not a string. */
	| "invalidType"
	/** Name contains `/` or `\` (reserved for namespaces); omp skips the skill. */
	| "invalidName"
	/** `enabled: false` in frontmatter; omp skips the skill. */
	| "disabledInFrontmatter";

export interface SkillIssue {
	code: SkillIssueCode;
	/** `error`: omp does not load the skill (for some or all providers). `warning`: loads, but degraded. */
	severity: "error" | "warning";
	message: string;
}

/** A discovery warning from omp (collisions, unreadable directories, registry lock problems). */
export interface SkillWarning {
	/** The file or directory it concerns; null for provider-level warnings. */
	skillPath: string | null;
	message: string;
}

export interface SkillEntry {
	/**
	 * The name omp exposes (`skill://<name>`, `/skill:<name>`). Colliding, differing skills get
	 * `<namespace>/<name>`. Disabled skills show the name they would get with every source enabled.
	 */
	name: string;
	description: string;
	/** Absolute SKILL.md path; the key for `skills:read`. */
	filePath: string;
	baseDir: string;
	/** {@link SkillProvider} id. */
	provider: SkillProvider | (string & {});
	level: SkillLevel;
	/** Raw omp source label, `<provider>:<level>`. */
	source: string;
	/** `hide: true` / `disable-model-invocation`: loaded but not listed in the system prompt. */
	hidden: boolean;
	/** Loaded by a session in this cwd. */
	enabled: boolean;
	disabledReason: SkillDisabledReason | null;
	/**
	 * The name to pass to `skills:setEnabled`: the `disabledExtensions` entry that disables it, else its
	 * name. null for skills omp cannot toggle individually (reason `duplicate`).
	 */
	toggleName: string | null;
	/** Set for registry-installed skills (`provider: "skillshare"`). */
	registry: { id: string; version: string } | null;
	/** Frontmatter diagnostics of the SKILL.md. */
	issues: SkillIssue[];
	/** omp discovery warnings about this file (e.g. name collisions). */
	warnings: string[];
}

/** A SKILL.md under a skill root that omp did not load because of a frontmatter error. */
export interface InvalidSkillFile {
	filePath: string;
	/** Directory name (omp's fallback skill name). */
	dirName: string;
	issues: SkillIssue[];
}

export interface SkillsListing {
	cwd: string;
	/** `skills.enabled`; when false omp loads no skills and every entry has reason `skillsOff`. */
	skillsEnabled: boolean;
	/** Loaded skills first (omp's order), then disabled ones by name. */
	skills: SkillEntry[];
	invalid: InvalidSkillFile[];
	/** omp warnings not tied to a listed skill. */
	warnings: SkillWarning[];
}

export interface SkillDocument {
	filePath: string;
	/** Raw file text. */
	content: string;
	/** Parsed frontmatter (kebab-case keys as written); empty when absent or invalid. */
	frontmatter: Record<string, unknown>;
	/** Markdown after the frontmatter block. */
	body: string;
	issues: SkillIssue[];
}

/** Skill-related omp settings (global `config.yml` values as omp resolves them). */
export interface SkillsSettings {
	/** `skills.enabled` — master switch. */
	enabled: boolean;
	/** `skills.enableSkillCommands` — register `/skill:<name>` commands. */
	enableSkillCommands: boolean;
	/** `skillful` — list skills in the system prompt (toggle per session with `/skillful`). */
	listInSystemPrompt: boolean;
	/** `skills.enablePiUser` — `~/.omp/agent/skills`. */
	enablePiUser: boolean;
	/** `skills.enablePiProject` — `.omp/skills`. */
	enablePiProject: boolean;
	/** `skills.enableAgentsUser` — `~/.agents/skills`. */
	enableAgentsUser: boolean;
	/** `skills.enableAgentsProject` — `.agents/skills`. */
	enableAgentsProject: boolean;
	/** `skills.enableClaudeUser` — `~/.claude/skills` (also enabled by `enabledProviders: [claude]`). */
	enableClaudeUser: boolean;
	/** `skills.enableClaudeProject` — `.claude/skills`. */
	enableClaudeProject: boolean;
	/** `skills.enableCodexUser` — `~/.codex/skills` (also enabled by `enabledProviders: [codex]`). */
	enableCodexUser: boolean;
	/** `skills.customDirectories` — extra roots scanned one level deep (relative to the project). */
	customDirectories: string[];
	/** `skills.ignoredSkills` — glob patterns excluded. */
	ignoredSkills: string[];
	/** `skills.includeSkills` — glob allowlist (empty = all). */
	includeSkills: string[];
	/** `skills.registryUrl` — Skillshare registry. */
	registryUrl: string;
	/** Names disabled via `disabledExtensions` `skill:<name>` entries. */
	disabledSkills: string[];
}

// ─── Registry (Skillshare) ────────────────────────────────────────────────────

export type SkillSearchSort = "relevance" | "downloads" | "recent";

export interface SkillRegistryUser {
	username: string;
	/** Hex seed for a generated avatar. */
	avatar: string;
}

export interface SkillSearchHit {
	/** `@scope/name`. */
	id: string;
	scope: string;
	name: string;
	description: string;
	keywords: string[];
	/** Latest version. */
	version: string;
	publisher: SkillRegistryUser;
	/** Epoch ms. */
	updatedAt: number;
	weeklyDownloads: number;
	/** Deprecation message. */
	deprecated: string | null;
}

export interface SkillSearchResult {
	total: number;
	page: number;
	perPage: number;
	hits: SkillSearchHit[];
}

export interface SkillVersionSummary {
	version: string;
	/** Epoch ms. */
	publishedAt: number;
	publisher: SkillRegistryUser;
	integrity: string;
	size: number;
	unpackedSize: number;
	fileCount: number;
	/** Ships executables or `scripts/`: installing needs explicit approval (`yes: true`). */
	hasScripts: boolean;
	yanked: boolean;
	deprecated: string | null;
}

/** `omp skill info @scope/name --json` (the packument). */
export interface SkillPackageInfo {
	id: string;
	scope: string;
	name: string;
	description: string;
	keywords: string[];
	license: string | null;
	repository: string | null;
	homepage: string | null;
	owners: SkillRegistryUser[];
	/** e.g. `{ latest: "1.2.0" }`. */
	distTags: Record<string, string>;
	/** Newest first. */
	versions: SkillVersionSummary[];
	/** Epoch ms. */
	createdAt: number;
	updatedAt: number;
	downloads: { weekly: number; total: number };
}

export interface SkillPackageFile {
	path: string;
	size: number;
	sha256: string;
	executable: boolean;
}

/** `omp skill info @scope/name@<version|range|tag> --json`: one resolved version. */
export interface SkillVersionInfo extends SkillVersionSummary {
	id: string;
	scope: string;
	name: string;
	description: string;
	license: string | null;
	compatibility: string | null;
	allowedTools: string | null;
	metadata: Record<string, string>;
	keywords: string[];
	repository: string | null;
	homepage: string | null;
	files: SkillPackageFile[];
	readmePath: string;
}

/** A registry package recorded in a `skills.json` / `skills.lock.json`. */
export interface RegistryInstalledSkill {
	/** `@scope/name`. */
	id: string;
	/** `project` = nearest project `.omp/`, `user` = `~/.omp/agent` (`global: true`). */
	scope: SkillLevel;
	/** Manifest range; null for a lock entry without a manifest entry. */
	range: string | null;
	/** Locked version; null when the manifest entry was never installed. */
	version: string | null;
	/** The locked version is unpacked in the store with matching integrity (false → run update). */
	stored: boolean;
	/** The `skills.json` it is recorded in. */
	manifestPath: string;
}

/** One change applied by install / update. */
export interface SkillChange {
	id: string;
	/** Previous version; null for a new install. */
	from: string | null;
	to: string;
	/** `added` new package, `updated` version change, `restored` re-unpacked locked version, `range` manifest range edit only. */
	kind: "added" | "updated" | "restored" | "range";
}

export interface SkillRegistryRequest {
	/** Project directory (project `skills.json` is the nearest `.omp/`, else the git root's, else `<cwd>/.omp/`). */
	cwd: string;
	/** Use the user-global `~/.omp/agent/skills.json` instead of the project's. */
	global?: boolean;
	opId?: string;
}

export interface SkillInstallRequest extends SkillRegistryRequest {
	/** `@scope/name[@version|range|tag]`; empty = install everything in `skills.json`. */
	specs: string[];
	/** Approve versions that ship scripts (see {@link SkillRegistryResult.needsScriptApproval}). */
	yes?: boolean;
}

export interface SkillUpdateRequest extends SkillRegistryRequest {
	/** `@scope/name` ids; empty = every manifest entry. */
	names: string[];
	yes?: boolean;
}

export interface SkillUninstallRequest extends SkillRegistryRequest {
	names: string[];
}

export interface SkillRegistryResult {
	opId: string;
	ok: boolean;
	/** omp's failure message; null on success. */
	error: string | null;
	/** Some version ships scripts and `yes` was not set; nothing was installed. Retry with `yes: true` after consent. */
	needsScriptApproval: boolean;
	changes: SkillChange[];
	/** Ids removed by uninstall. */
	removed: string[];
	/** `warn …` lines (deprecations, yanked versions). */
	warnings: string[];
	/** Every non-empty output line, ANSI stripped, in arrival order. */
	log: string[];
}

export interface SkillProgress {
	opId: string;
	stream: "stdout" | "stderr";
	line: string;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Every skill discovered for `cwd`, loaded or not, with diagnostics. */
		"skills:list": { args: [cwd: string]; result: SkillsListing };
		/** Read a SKILL.md (path must end in `SKILL.md`). */
		"skills:read": { args: [filePath: string]; result: SkillDocument };
		/**
		 * Enable/disable one skill by name via global `disabledExtensions` (`skill:<name>`). Use
		 * {@link SkillEntry.toggleName}. Skills off for other reasons need `skills:settings:set`.
		 */
		"skills:setEnabled": { args: [name: string, enabled: boolean]; result: SkillsSettings };
		"skills:settings:get": { args: []; result: SkillsSettings };
		/** Write the given settings to the global config.yml (values checked first); resolves with the new effective values. */
		"skills:settings:set": { args: [patch: Partial<SkillsSettings>]; result: SkillsSettings };

		/** Search the Skillshare registry (`q` accepts `owner:<scope>` and `keyword:<kw>` filters). */
		"skills:registry:search": { args: [query: string, sort?: SkillSearchSort]; result: SkillSearchResult };
		/** Package details for `@scope/name`. */
		"skills:registry:info": { args: [id: string]; result: SkillPackageInfo };
		/** One version of a package; `version` may be an exact version, range or dist-tag. */
		"skills:registry:version": { args: [id: string, version: string]; result: SkillVersionInfo };
		/** Registry packages recorded for the project (when `cwd` is in one) and the user. */
		"skills:registry:installed": { args: [cwd: string]; result: RegistryInstalledSkill[] };
		/** Install registry skills; streams `skills:progress`. */
		"skills:registry:install": { args: [request: SkillInstallRequest]; result: SkillRegistryResult };
		/** Update installed registry skills within their ranges; streams `skills:progress`. */
		"skills:registry:update": { args: [request: SkillUpdateRequest]; result: SkillRegistryResult };
		/** Remove registry skills from `skills.json`/lock and prune the store; streams `skills:progress`. */
		"skills:registry:uninstall": { args: [request: SkillUninstallRequest]; result: SkillRegistryResult };
		/** Kill a running registry operation; false when none is running under `opId`. */
		"skills:cancel": { args: [opId: string]; result: boolean };
	}

	interface IpcEventMap {
		/** Output line of a running registry install / update / uninstall. */
		"skills:progress": SkillProgress;
		/** Skill settings or installs changed (`cwd` of a project-scope registry change, else null). */
		"skills:changed": { cwd: string | null };
	}
}
