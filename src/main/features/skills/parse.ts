import { matchesGlob } from "node:path";
import { type Document, isScalar, isSeq, parse as parseYaml } from "yaml";
import { z } from "zod";
import type { JsonValue } from "@shared/contracts/config";
import type {
	SkillChange,
	SkillDisabledReason,
	SkillIssue,
	SkillLevel,
	SkillPackageInfo,
	SkillSearchResult,
	SkillsSettings,
	SkillVersionInfo,
} from "@shared/contracts/skills";
import { deleteDocumentPath, documentJson, setDocumentPath } from "../../services/omp-config";
import { uncaughtErrorMessage } from "../plugins/parse";

// ─── omp skill list --json ────────────────────────────────────────────────────

const ListedSkillSchema = z.object({
	name: z.string(),
	description: z.string(),
	filePath: z.string(),
	baseDir: z.string(),
	source: z.string(),
	hide: z.boolean(),
});
export type ListedSkill = z.infer<typeof ListedSkillSchema>;

const SkillListSchema = z.object({
	skills: z.array(ListedSkillSchema),
	warnings: z.array(z.object({ skillPath: z.string(), message: z.string() })),
});
export type SkillList = z.infer<typeof SkillListSchema>;

/** `omp skill list [dir] --json`. */
export function parseSkillList(stdout: string): SkillList {
	return SkillListSchema.parse(JSON.parse(stdout));
}

/** Split omp's `<provider>:<level>` source label. */
export function splitSource(source: string): { provider: string; level: SkillLevel } {
	const colon = source.lastIndexOf(":");
	const provider = colon > 0 ? source.slice(0, colon) : source;
	return { provider, level: source.slice(colon + 1) === "project" ? "project" : "user" };
}

/** Registry id + version from a Skillshare store path (`…/skillshare/@scope/name/<version>/SKILL.md`). */
export function registryFromPath(filePath: string): { id: string; version: string } | null {
	const match = /[\\/]skillshare[\\/](@[^\\/]+)[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]SKILL\.md$/.exec(filePath);
	if (!match) return null;
	return { id: `${match[1]}/${match[2]}`, version: match[3] ?? "" };
}

// ─── omp config list --json ───────────────────────────────────────────────────

/** `omp config list --json`: key → `{ value, type, description }`; `value` is absent for unset keys without defaults. */
const ConfigListSchema = z.record(z.string(), z.object({ value: z.unknown().optional() }));
const StringList = z.array(z.string()).catch([]);

type SettingField = Exclude<keyof SkillsSettings, "disabledSkills">;

/** Where a {@link SkillsSettings} field lives in config.yml, and omp's default for it. */
export interface SkillSettingSpec {
	path: readonly string[];
	default: boolean | string | string[];
}

/** Config paths and omp v18 defaults (`omp config list --json` against an empty agent dir). */
export const SKILL_SETTINGS: Record<SettingField, SkillSettingSpec> = {
	enabled: { path: ["skills", "enabled"], default: true },
	enableSkillCommands: { path: ["skills", "enableSkillCommands"], default: true },
	listInSystemPrompt: { path: ["skillful"], default: true },
	enablePiUser: { path: ["skills", "enablePiUser"], default: true },
	enablePiProject: { path: ["skills", "enablePiProject"], default: true },
	enableAgentsUser: { path: ["skills", "enableAgentsUser"], default: true },
	enableAgentsProject: { path: ["skills", "enableAgentsProject"], default: true },
	enableClaudeUser: { path: ["skills", "enableClaudeUser"], default: false },
	enableClaudeProject: { path: ["skills", "enableClaudeProject"], default: true },
	enableCodexUser: { path: ["skills", "enableCodexUser"], default: false },
	customDirectories: { path: ["skills", "customDirectories"], default: [] },
	ignoredSkills: { path: ["skills", "ignoredSkills"], default: [] },
	includeSkills: { path: ["skills", "includeSkills"], default: [] },
	registryUrl: { path: ["skills", "registryUrl"], default: "https://skills.omp.sh" },
};

/** Renderer-supplied `skills:settings:set` patch, type-checked before anything is written (omp only warns on wrong types). */
export const SkillsSettingsPatchSchema = z
	.object({
		enabled: z.boolean(),
		enableSkillCommands: z.boolean(),
		listInSystemPrompt: z.boolean(),
		enablePiUser: z.boolean(),
		enablePiProject: z.boolean(),
		enableAgentsUser: z.boolean(),
		enableAgentsProject: z.boolean(),
		enableClaudeUser: z.boolean(),
		enableClaudeProject: z.boolean(),
		enableCodexUser: z.boolean(),
		customDirectories: z.array(z.string()),
		ignoredSkills: z.array(z.string()),
		includeSkills: z.array(z.string()),
		registryUrl: z.string().url(),
		disabledSkills: z.array(z.string()),
	})
	.partial()
	.strict();
export type SkillsSettingsPatch = z.infer<typeof SkillsSettingsPatchSchema>;

/** Settings that decide skill visibility, including provider switches that are not skill-specific. */
export interface SkillConfig {
	skills: SkillsSettings;
	disabledExtensions: string[];
	enabledProviders: string[];
	disabledProviders: string[];
}

/** Extract skill-related values from `omp config list --json` (omp's defaults for absent or mistyped keys). */
export function parseSkillConfig(stdout: string): SkillConfig {
	const config = ConfigListSchema.parse(JSON.parse(stdout));
	const value = (key: string): unknown => config[key]?.value;
	const setting = <T>(field: SettingField, schema: z.ZodType<T>, fallback: T): T =>
		schema.catch(fallback).parse(value(SKILL_SETTINGS[field].path.join(".")));
	const bool = (field: SettingField) => setting(field, z.boolean(), SKILL_SETTINGS[field].default === true);
	const list = (field: SettingField) => setting(field, z.array(z.string()), []);
	const disabledExtensions = StringList.parse(value("disabledExtensions"));
	return {
		skills: {
			enabled: bool("enabled"),
			enableSkillCommands: bool("enableSkillCommands"),
			listInSystemPrompt: bool("listInSystemPrompt"),
			enablePiUser: bool("enablePiUser"),
			enablePiProject: bool("enablePiProject"),
			enableAgentsUser: bool("enableAgentsUser"),
			enableAgentsProject: bool("enableAgentsProject"),
			enableClaudeUser: bool("enableClaudeUser"),
			enableClaudeProject: bool("enableClaudeProject"),
			enableCodexUser: bool("enableCodexUser"),
			customDirectories: list("customDirectories"),
			ignoredSkills: list("ignoredSkills"),
			includeSkills: list("includeSkills"),
			registryUrl: setting("registryUrl", z.string(), String(SKILL_SETTINGS.registryUrl.default)),
			disabledSkills: disabledExtensions.filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
		},
		disabledExtensions,
		enabledProviders: StringList.parse(value("enabledProviders")),
		disabledProviders: StringList.parse(value("disabledProviders")),
	};
}

// ─── config.yml edits (yaml Document, comments preserved) ─────────────────────

/** Set `path`, or remove it when `value` equals omp's default so config.yml keeps only real overrides. */
function writeSetting(doc: Document, path: readonly string[], value: JsonValue, fallback: JsonValue): void {
	if (JSON.stringify(value) === JSON.stringify(fallback)) deleteDocumentPath(doc, path);
	else setDocumentPath(doc, path, value);
}

/** `disabledExtensions` as written in this config file (not the effective, layered value). */
function documentDisabledExtensions(doc: Document): string[] {
	const parsed = z.array(z.string()).optional().safeParse(documentJson(doc).disabledExtensions);
	if (!parsed.success) throw new Error("disabledExtensions in config.yml is not a list of names");
	return parsed.data ?? [];
}

/**
 * Rewrite the file's `disabledExtensions` to `next`. An existing block list is edited item by item, so
 * comments on the entries that stay are kept; an emptied list is removed (omp's default is `[]`).
 */
function writeDisabledExtensions(doc: Document, next: readonly string[]): void {
	const node = doc.get("disabledExtensions", true);
	if (next.length === 0) {
		deleteDocumentPath(doc, ["disabledExtensions"]);
		return;
	}
	if (!isSeq(node)) {
		setDocumentPath(doc, ["disabledExtensions"], [...next]);
		return;
	}
	const keep = new Set(next);
	node.items = node.items.filter(item => isScalar(item) && typeof item.value === "string" && keep.has(item.value));
	const present = new Set(node.items.map(item => (isScalar(item) ? item.value : null)));
	for (const entry of next) if (!present.has(entry)) node.add(doc.createNode(entry));
}

/** Enable/disable one skill in the file's `disabledExtensions` (read-modify-write on the same document). */
export function setSkillEnabledInDocument(doc: Document, name: string, enabled: boolean): void {
	writeDisabledExtensions(doc, toggleDisabledExtensions(documentDisabledExtensions(doc), name, enabled));
}

/** Apply a validated settings patch to a config document; `disabledSkills` replaces only the `skill:` entries. */
export function applySkillSettingsToDocument(doc: Document, patch: SkillsSettingsPatch): void {
	const { disabledSkills, ...rest } = patch;
	const values: Partial<Record<string, JsonValue>> = rest;
	for (const [field, spec] of Object.entries(SKILL_SETTINGS)) {
		const value = values[field];
		if (value !== undefined) writeSetting(doc, spec.path, value, spec.default);
	}
	if (disabledSkills) {
		const others = documentDisabledExtensions(doc).filter(id => !id.startsWith("skill:"));
		writeDisabledExtensions(doc, [...others, ...disabledSkills.map(name => `skill:${name}`)]);
	}
}

/**
 * Config overlay (`PI_CONFIG_FILES`) that makes `omp skill list` report every discoverable skill: no
 * name filters, every source and provider on. Non-skill `disabledExtensions` entries are kept so extension
 * packages that are off do not contribute skills.
 */
export function allSkillsOverlay(config: SkillConfig): string {
	const keep = config.disabledExtensions.filter(id => !id.startsWith("skill:"));
	return `${JSON.stringify(
		{
			disabledExtensions: keep,
			enabledProviders: ["*"],
			disabledProviders: [],
			skills: {
				enabled: true,
				enablePiUser: true,
				enablePiProject: true,
				enableAgentsUser: true,
				enableAgentsProject: true,
				enableClaudeUser: true,
				enableClaudeProject: true,
				enableCodexUser: true,
				ignoredSkills: [],
				includeSkills: [],
			},
		},
		null,
		"\t",
	)}\n`;
}

// ─── Disabled-reason attribution ──────────────────────────────────────────────

/** omp's opt-in user-level providers (`FOREIGN_USER_PROVIDERS` in capability/index.ts). */
const FOREIGN_USER_PROVIDERS: Record<string, true> = {
	cursor: true,
	codex: true,
	claude: true,
	"claude-plugins": true,
	gemini: true,
	opencode: true,
	windsurf: true,
	github: true,
};

export interface SourceContext {
	config: SkillConfig;
	/** The skill file lives in Claude Code's own config tree (claude-plugins from `~/.claude/plugins`). */
	inClaudeTree: boolean;
	/** `CLAUDE_CONFIG_DIR` is set, which opts Claude user sources in. */
	claudeConfigDirSet: boolean;
}

function userSourceEnabled(provider: string, context: SourceContext): boolean {
	const { enabledProviders, disabledProviders } = context.config;
	if (disabledProviders.includes(provider)) return false;
	if (FOREIGN_USER_PROVIDERS[provider] !== true) return true;
	if (enabledProviders.some(id => id === provider || id === "*" || id === "all")) return true;
	if (provider === "claude-plugins" && enabledProviders.includes("claude")) return true;
	return provider === "claude" && context.claudeConfigDirSet;
}

/** omp's `isSourceEnabled` (extensibility/skills.ts) plus the whole-provider `disabledProviders` switch. */
export function sourceEnabled(provider: string, level: SkillLevel, context: SourceContext): boolean {
	const settings = context.config.skills;
	if (provider === "omp-managed" || provider === "custom") return true;
	if (context.config.disabledProviders.includes(provider)) return false;
	if (provider === "codex" && level === "user") return settings.enableCodexUser || userSourceEnabled("codex", context);
	if (provider === "claude" && level === "user") return settings.enableClaudeUser || userSourceEnabled("claude", context);
	if (provider === "claude" && level === "project") return settings.enableClaudeProject;
	if (provider === "native") return level === "user" ? settings.enablePiUser : settings.enablePiProject;
	if (provider === "agents") return level === "user" ? settings.enableAgentsUser : settings.enableAgentsProject;
	if (provider === "claude-plugins" && !context.inClaudeTree) return true;
	if (level === "user") return userSourceEnabled(provider, context);
	return true;
}

/** Bare skill name of a possibly namespaced `<namespace>/<name>`. */
function rawName(name: string): string {
	return name.slice(name.lastIndexOf("/") + 1);
}

/**
 * Attribute a skill that the effective listing omits to the setting that removed it, in omp's filter order.
 * Returns the reason plus the `disabledExtensions` name that matched (for toggling).
 */
export function disabledReason(
	skill: { name: string; provider: string; level: SkillLevel },
	context: SourceContext,
): { reason: SkillDisabledReason; toggleName: string | null } {
	const settings = context.config.skills;
	const names = skill.name === rawName(skill.name) ? [skill.name] : [rawName(skill.name), skill.name];
	const disabledBy = names.find(name => settings.disabledSkills.includes(name));
	if (!settings.enabled) return { reason: "skillsOff", toggleName: disabledBy ?? skill.name };
	if (disabledBy) return { reason: "disabled", toggleName: disabledBy };
	if (!sourceEnabled(skill.provider, skill.level, context)) return { reason: "sourceDisabled", toggleName: skill.name };
	if (names.some(name => settings.ignoredSkills.some(pattern => matchesGlob(name, pattern)))) {
		return { reason: "ignored", toggleName: skill.name };
	}
	if (settings.includeSkills.length > 0 && !settings.includeSkills.some(pattern => matchesGlob(skill.name, pattern))) {
		return { reason: "notIncluded", toggleName: skill.name };
	}
	return { reason: "duplicate", toggleName: null };
}

/** Rewrite `disabledExtensions` so `name` is (not) disabled, keeping every other entry in order. */
export function toggleDisabledExtensions(current: readonly string[], name: string, enabled: boolean): string[] {
	const entry = `skill:${name}`;
	const without = current.filter(id => id !== entry);
	return enabled ? without : [...without, entry];
}

// ─── SKILL.md frontmatter diagnostics ─────────────────────────────────────────

/** Providers whose loaders skip skills without a description (`requireDescription: true`). */
const REQUIRES_DESCRIPTION: Record<string, true> = { native: true, "omp-plugins": true, github: true, custom: true };

export interface FrontmatterAnalysis {
	frontmatter: Record<string, unknown>;
	body: string;
	issues: SkillIssue[];
}

const PLAIN_SCALAR_KEY_VALUE = /^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/;
const FLOW_OR_EXPLICIT_START = new Set(['"', "'", "[", "{", "|", ">", "!", "&", "*", "#"]);

/** omp's lenient repair: quote plain scalars containing `: ` (e.g. `description: Use when: X`). */
function quoteAmbiguousScalars(metadata: string): string | null {
	let changed = false;
	const lines = metadata.split("\n").map(line => {
		const match = PLAIN_SCALAR_KEY_VALUE.exec(line);
		if (!match) return line;
		const [, prefix = "", raw = "", suffix = ""] = match;
		const value = raw.trimEnd();
		if (!value.includes(": ") || FLOW_OR_EXPLICIT_START.has(value[0] ?? "")) return line;
		changed = true;
		return `${prefix}${JSON.stringify(value)}${suffix}`;
	});
	return changed ? lines.join("\n") : null;
}

function parseYamlLenient(metadata: string): { value: unknown; error: string | null } {
	const attempts = [metadata, metadata.replaceAll("\t", "  "), quoteAmbiguousScalars(metadata.replaceAll("\t", "  "))];
	let firstError: string | null = null;
	for (const text of attempts) {
		if (text === null) continue;
		try {
			return { value: parseYaml(text, { uniqueKeys: false }), error: null };
		} catch (error) {
			firstError ??= error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
		}
	}
	return { value: null, error: firstError };
}

/** omp's fallback when YAML fails: one `key: value` per line, each value parsed on its own when it can be. */
function lineFallback(metadata: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const line of metadata.split("\n")) {
		const match = /^([\w-]+):\s*(.*)$/.exec(line);
		if (!match?.[1]) continue;
		const raw = (match[2] ?? "").trim();
		let value: unknown = raw;
		try {
			const parsed: unknown = raw ? parseYaml(raw) : raw;
			if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) value = parsed;
		} catch {
			// keep the raw string, as omp does
		}
		result[match[1]] = value;
	}
	return result;
}

const FrontmatterRecord = z.record(z.string(), z.unknown());

/**
 * Parse SKILL.md frontmatter the way omp does (CRLF normalization, HTML comments stripped, lenient YAML
 * repair, `key: value` fallback) and report what would make omp skip or degrade the skill.
 * `provider` decides whether a missing description is fatal; omit it for files omp did not load.
 */
export function analyzeSkillFile(content: string, dirName: string, provider?: string): FrontmatterAnalysis {
	const issues: SkillIssue[] = [];
	if (!content) {
		return { frontmatter: {}, body: "", issues: [{ code: "empty", severity: "error", message: "SKILL.md is empty." }] };
	}
	const normalized = content.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
	const end = normalized.startsWith("---") ? normalized.indexOf("\n---", 3) : -1;
	let frontmatter: Record<string, unknown> = {};
	let body = normalized;
	if (end === -1) {
		issues.push({
			code: "noFrontmatter",
			severity: "warning",
			message: "No frontmatter block: the name falls back to the directory name and there is no description.",
		});
	} else {
		const metadata = normalized.slice(4, end);
		body = normalized.slice(end + 4).trim();
		const { value, error } = parseYamlLenient(metadata);
		if (error !== null) {
			frontmatter = lineFallback(metadata);
			issues.push({
				code: "yamlError",
				severity: "warning",
				message: `Frontmatter is not valid YAML (${error}); omp falls back to reading "key: value" lines.`,
			});
		} else if (value !== null && value !== undefined) {
			const record = FrontmatterRecord.safeParse(value);
			if (record.success && !Array.isArray(value)) frontmatter = record.data;
			else issues.push({ code: "notMapping", severity: "warning", message: "Frontmatter is not a key/value mapping; omp ignores it." });
		}
	}

	const { name, description, enabled } = frontmatter;
	if (name !== undefined && typeof name !== "string") {
		issues.push({ code: "invalidType", severity: "warning", message: `"name" is not a string; omp uses "${dirName}".` });
	}
	const effectiveName = typeof name === "string" && name.trim() ? name.trim() : dirName;
	if (/[\\/]/.test(effectiveName)) {
		issues.push({
			code: "invalidName",
			severity: "error",
			message: `Name "${effectiveName}" contains a path separator (reserved for namespaces); omp skips this skill.`,
		});
	}
	if (description !== undefined && typeof description !== "string") {
		issues.push({ code: "invalidType", severity: "warning", message: '"description" is not a string; omp treats it as empty.' });
	}
	if (typeof description !== "string" || !description.trim()) {
		const fatal = provider === undefined || REQUIRES_DESCRIPTION[provider] === true;
		issues.push({
			code: "missingDescription",
			severity: fatal ? "error" : "warning",
			message: fatal
				? "No description: omp's own, plugin, GitHub and custom-directory loaders skip skills without one."
				: "No description: the model cannot tell when to use this skill.",
		});
	}
	if (enabled === false) {
		issues.push({ code: "disabledInFrontmatter", severity: "error", message: "`enabled: false` in frontmatter; omp skips this skill." });
	}
	return { frontmatter, body, issues };
}

// ─── Registry JSON (search / info) ────────────────────────────────────────────

const UserSchema = z.object({ username: z.string(), avatar: z.string().catch("") });

const SearchHitSchema = z.object({
	scope: z.string(),
	name: z.string(),
	description: z.string().catch(""),
	keywords: z.array(z.string()).catch([]),
	version: z.string(),
	publisher: UserSchema,
	updatedAt: z.number(),
	weeklyDownloads: z.number().catch(0),
	deprecated: z.string().optional(),
});

const SearchSchema = z.object({
	total: z.number(),
	page: z.number(),
	perPage: z.number(),
	hits: z.array(SearchHitSchema),
});

/** `omp skill search <query> --json`. */
export function parseSkillSearch(stdout: string): SkillSearchResult {
	const result = SearchSchema.parse(JSON.parse(stdout));
	return {
		...result,
		hits: result.hits.map(hit => ({
			...hit,
			id: `@${hit.scope}/${hit.name}`,
			deprecated: hit.deprecated ?? null,
		})),
	};
}

const VersionSummarySchema = z.object({
	version: z.string(),
	publishedAt: z.number(),
	publisher: UserSchema,
	integrity: z.string(),
	size: z.number(),
	unpackedSize: z.number(),
	fileCount: z.number(),
	hasScripts: z.boolean(),
	yanked: z.boolean(),
	deprecated: z.string().optional(),
});

const PackumentSchema = z.object({
	scope: z.string(),
	name: z.string(),
	description: z.string().catch(""),
	keywords: z.array(z.string()).catch([]),
	license: z.string().optional(),
	repository: z.string().optional(),
	homepage: z.string().optional(),
	owners: z.array(UserSchema),
	distTags: z.record(z.string(), z.string()),
	versions: z.record(z.string(), VersionSummarySchema),
	createdAt: z.number(),
	updatedAt: z.number(),
	downloads: z.object({ weekly: z.number(), total: z.number() }),
});

const VersionManifestSchema = VersionSummarySchema.extend({
	scope: z.string(),
	name: z.string(),
	description: z.string().catch(""),
	license: z.string().optional(),
	compatibility: z.string().optional(),
	allowedTools: z.string().optional(),
	metadata: z.record(z.string(), z.string()).catch({}),
	keywords: z.array(z.string()).catch([]),
	repository: z.string().optional(),
	homepage: z.string().optional(),
	files: z.array(z.object({ path: z.string(), size: z.number(), sha256: z.string(), executable: z.boolean() })),
	readmePath: z.string(),
});

function compareVersionsDesc(a: string, b: string): number {
	const [coreA = "", preA] = a.split("-", 2);
	const [coreB = "", preB] = b.split("-", 2);
	const partsA = coreA.split(".").map(Number);
	const partsB = coreB.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (partsB[i] ?? 0) - (partsA[i] ?? 0);
		if (diff !== 0) return diff;
	}
	if (preA === preB) return 0;
	if (preA === undefined) return -1;
	if (preB === undefined) return 1;
	return preB.localeCompare(preA, "en", { numeric: true });
}

/** `omp skill info @scope/name --json` (packument). */
export function parseSkillPackage(stdout: string): SkillPackageInfo {
	const pkg = PackumentSchema.parse(JSON.parse(stdout));
	return {
		id: `@${pkg.scope}/${pkg.name}`,
		scope: pkg.scope,
		name: pkg.name,
		description: pkg.description,
		keywords: pkg.keywords,
		license: pkg.license ?? null,
		repository: pkg.repository ?? null,
		homepage: pkg.homepage ?? null,
		owners: pkg.owners,
		distTags: pkg.distTags,
		versions: Object.values(pkg.versions)
			.map(version => ({ ...version, deprecated: version.deprecated ?? null }))
			.sort((a, b) => compareVersionsDesc(a.version, b.version)),
		createdAt: pkg.createdAt,
		updatedAt: pkg.updatedAt,
		downloads: { weekly: pkg.downloads.weekly, total: pkg.downloads.total },
	};
}

/** `omp skill info @scope/name@<version> --json` (one version manifest). */
export function parseSkillVersion(stdout: string): SkillVersionInfo {
	const version = VersionManifestSchema.parse(JSON.parse(stdout));
	return {
		...version,
		id: `@${version.scope}/${version.name}`,
		deprecated: version.deprecated ?? null,
		license: version.license ?? null,
		compatibility: version.compatibility ?? null,
		allowedTools: version.allowedTools ?? null,
		repository: version.repository ?? null,
		homepage: version.homepage ?? null,
	};
}

// ─── Registry install / update / uninstall text output ───────────────────────

export interface RegistryOutput {
	changes: SkillChange[];
	removed: string[];
	warnings: string[];
}

/** Split `@scope/name@version` at the version `@`. */
function splitSpec(label: string): { id: string; version: string } {
	const at = label.lastIndexOf("@");
	return at > 0 ? { id: label.slice(0, at), version: label.slice(at + 1) } : { id: label, version: "" };
}

/**
 * Parse `omp skill install|update|uninstall` output (NO_COLOR): `+ @a/b@1.0.0`, `@a/b 1.0.0 → 1.1.0`,
 * `✓ @a/b@1.0.0 (restored)`, `✓ @a/b@1.0.0 (^1.0.0)`, `- @a/b`, and `warn <message>` on stderr.
 */
export function parseRegistryOutput(stdout: string, stderr: string): RegistryOutput {
	const output: RegistryOutput = { changes: [], removed: [], warnings: [] };
	for (const line of stdout.split("\n").map(text => text.trim())) {
		let match = /^\+ (@\S+)$/.exec(line);
		if (match) {
			const { id, version } = splitSpec(match[1] ?? "");
			output.changes.push({ id, from: null, to: version, kind: "added" });
			continue;
		}
		match = /^(@[^\s@]+\/\S+) (\S+) → (\S+)$/.exec(line);
		if (match) {
			output.changes.push({ id: match[1] ?? "", from: match[2] ?? null, to: match[3] ?? "", kind: "updated" });
			continue;
		}
		match = /^✓ (@\S+) \((.+)\)$/.exec(line);
		if (match) {
			const { id, version } = splitSpec(match[1] ?? "");
			output.changes.push({ id, from: version, to: version, kind: match[2] === "restored" ? "restored" : "range" });
			continue;
		}
		match = /^- (@\S+)$/.exec(line);
		if (match) output.removed.push(match[1] ?? "");
	}
	for (const line of stderr.split("\n")) {
		const match = /^warn (.+)$/.exec(line.trim());
		if (match?.[1]) output.warnings.push(match[1]);
	}
	return output;
}

/** omp refused to install a version that ships scripts because `--yes` was not given (non-TTY). */
export function needsScriptApproval(stderr: string): boolean {
	return stderr.includes("Refusing to install scripts without confirmation");
}

/** omp's failure text from `skill <action>` / `error <message>` lines, else the whole stderr. */
export function registryFailure(stdout: string, stderr: string, fallback: string): string {
	const crash = uncaughtErrorMessage(stderr);
	if (crash) return crash;
	const text = stderr.trim() || stdout.trim();
	const cleaned = text
		.split("\n")
		.filter(line => !/^warn /.test(line))
		.map(line => line.replace(/^(?:error|skill \w+:) /, ""))
		.join("\n")
		.trim();
	return cleaned || fallback;
}
