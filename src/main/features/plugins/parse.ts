import { z } from "zod";
import type {
	AvailablePlugin,
	MarketplacePlugin,
	MarketplaceSource,
	NpmPlugin,
	PluginConfig,
	PluginConfigValidation,
	PluginDoctorReport,
	PluginFeatureState,
	PluginScope,
	PluginSettingInfo,
	PluginsListing,
	PluginUpgrade,
} from "@shared/contracts/plugins";

const ScopeSchema = z.enum(["user", "project"]);

const FeatureSchema = z.object({
	description: z.string().optional(),
	default: z.boolean().optional(),
});

const SettingSchema = z.object({
	type: z.enum(["string", "number", "boolean", "enum"]),
	description: z.string().optional(),
	secret: z.boolean().optional(),
	env: z.string().optional(),
	default: z.union([z.string(), z.number(), z.boolean()]).optional(),
	values: z.array(z.string()).optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	step: z.number().optional(),
});

const ManifestSchema = z.object({
	description: z.string().optional(),
	tools: z.string().optional(),
	hooks: z.string().optional(),
	extensions: z.array(z.string()).optional(),
	commands: z.array(z.string()).optional(),
	features: z.record(z.string(), FeatureSchema).optional(),
	settings: z.record(z.string(), SettingSchema).optional(),
});

/** `InstalledPlugin` as printed by `omp plugin list|install|link --json`. */
const InstalledPluginSchema = z.object({
	name: z.string(),
	version: z.string(),
	path: z.string(),
	manifest: ManifestSchema,
	enabledFeatures: z.array(z.string()).nullable(),
	enabled: z.boolean(),
});

const MarketplaceEntrySchema = z.object({
	scope: ScopeSchema,
	installPath: z.string(),
	version: z.string(),
	installedAt: z.string(),
	lastUpdated: z.string(),
	gitCommitSha: z.string().optional(),
	enabled: z.boolean().optional(),
});

const MarketplaceSummarySchema = z.object({
	id: z.string(),
	scope: ScopeSchema,
	entries: z.array(MarketplaceEntrySchema),
	shadowedBy: z.literal("project").optional(),
});

const ListSchema = z.object({
	npm: z.array(InstalledPluginSchema),
	marketplace: z.array(MarketplaceSummarySchema),
});

const FeaturesSchema = z.object({
	plugin: z.string(),
	enabledFeatures: z.array(z.string()).nullable(),
	availableFeatures: z.array(z.string()),
});

const ConfigListSchema = z.object({
	settings: z.record(z.string(), z.unknown()),
	schema: z.record(z.string(), SettingSchema),
});

const ConfigValidateSchema = z.object({
	valid: z.boolean(),
	errors: z.array(z.object({ plugin: z.string(), key: z.string(), error: z.string() })),
});

const DoctorSchema = z.array(
	z.object({
		name: z.string(),
		status: z.enum(["ok", "warning", "error"]),
		message: z.string(),
		fixed: z.boolean().optional(),
	}),
);

const PackageUpgradeSchema = z.object({
	upgraded: z.string(),
	from: z.string().nullable(),
	to: z.string(),
	changed: z.boolean(),
});

/**
 * Parse the JSON document in omp's stdout. Some commands print a confirmation line before the JSON
 * (`plugin features --enable` prints "✔ Updated features for …" first), so parsing starts at the first
 * line that opens an object or array.
 */
export function extractJson(stdout: string): unknown {
	const start = stdout.search(/^[[{]/m);
	if (start === -1) throw new Error(`omp printed no JSON: ${stdout.trim().slice(0, 200) || "(empty output)"}`);
	return JSON.parse(stdout.slice(start));
}

function toSettings(schema: Record<string, z.infer<typeof SettingSchema>> | undefined): PluginSettingInfo[] {
	return Object.entries(schema ?? {}).map(([key, setting]) => ({
		key,
		type: setting.type,
		description: setting.description ?? null,
		secret: setting.secret === true,
		env: setting.env ?? null,
		default: setting.default ?? null,
		values: setting.values ?? [],
		min: setting.min ?? null,
		max: setting.max ?? null,
		step: setting.step ?? null,
	}));
}

function toNpmPlugin(plugin: z.infer<typeof InstalledPluginSchema>): NpmPlugin {
	const { manifest, enabledFeatures } = plugin;
	const explicit = enabledFeatures ? new Set(enabledFeatures) : null;
	return {
		kind: "npm",
		name: plugin.name,
		version: plugin.version,
		path: plugin.path,
		description: manifest.description ?? null,
		enabled: plugin.enabled,
		enabledFeatures,
		features: Object.entries(manifest.features ?? {}).map(([name, feature]) => ({
			name,
			description: feature.description ?? null,
			default: feature.default === true,
			enabled: explicit ? explicit.has(name) : feature.default === true,
		})),
		settings: toSettings(manifest.settings),
		entryPoints: {
			tools: manifest.tools ?? null,
			hooks: manifest.hooks ?? null,
			extensions: manifest.extensions ?? [],
			commands: manifest.commands ?? [],
		},
	};
}

/** Split `name@marketplace` at the last `@` (marketplace names never contain one). */
export function splitPluginId(id: string): { name: string; marketplace: string } {
	const at = id.lastIndexOf("@");
	return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

function toMarketplacePlugin(summary: z.infer<typeof MarketplaceSummarySchema>): MarketplacePlugin {
	const installs = summary.entries.map(entry => ({
		scope: entry.scope,
		installPath: entry.installPath,
		version: entry.version,
		installedAt: entry.installedAt,
		lastUpdated: entry.lastUpdated,
		gitCommitSha: entry.gitCommitSha ?? null,
		enabled: entry.enabled !== false,
	}));
	const primary = installs[0];
	return {
		kind: "marketplace",
		id: summary.id,
		...splitPluginId(summary.id),
		scope: summary.scope,
		version: primary?.version ?? "unknown",
		enabled: primary?.enabled ?? true,
		shadowedByProject: summary.shadowedBy === "project",
		installs,
	};
}

/** `omp plugin list --json`. */
export function parsePluginList(stdout: string): PluginsListing {
	const list = ListSchema.parse(extractJson(stdout));
	return { npm: list.npm.map(toNpmPlugin), marketplace: list.marketplace.map(toMarketplacePlugin) };
}

/** `omp plugin install <npm|git|path> --json` (an `InstalledPlugin`). */
export function parseInstalledPlugin(stdout: string): NpmPlugin {
	return toNpmPlugin(InstalledPluginSchema.parse(extractJson(stdout)));
}

/** `omp plugin features <name> [--enable|--disable|--set …] --json`. */
export function parseFeatureState(stdout: string): PluginFeatureState {
	return FeaturesSchema.parse(extractJson(stdout));
}

/** `omp plugin config list <name> --json`. */
export function parsePluginConfig(plugin: string, stdout: string): PluginConfig {
	const config = ConfigListSchema.parse(extractJson(stdout));
	return { plugin, values: config.settings, schema: toSettings(config.schema) };
}

/** `omp plugin config validate --json`. */
export function parseConfigValidation(stdout: string): PluginConfigValidation {
	return ConfigValidateSchema.parse(extractJson(stdout));
}

/** `omp plugin doctor [--fix] --json` (exits 1 when unfixed errors remain, JSON is still printed). */
export function parseDoctor(stdout: string): PluginDoctorReport {
	const checks = DoctorSchema.parse(extractJson(stdout)).map(check => ({ ...check, fixed: check.fixed === true }));
	return { checks, healthy: !checks.some(check => check.status === "error" && !check.fixed) };
}

/** Marketplace install confirmation: `✔ Installed <name> from <marketplace> (<version>)`. */
export function parseMarketplaceInstall(output: string): { name: string; marketplace: string; version: string } | null {
	const match = /Installed (\S+) from (\S+) \(([^)]+)\)/.exec(output);
	if (!match) return null;
	const [, name = "", marketplace = "", version = ""] = match;
	return { name, marketplace, version };
}

/**
 * Upgrade results. Understands the marketplace text lines
 * (`Upgraded <id> (<scope>) to <version>`, `  <id> (<scope>): <from> -> <to>`) and the JSON printed by
 * omp builds that upgrade npm/git plugins in place (`{ upgraded, from, to, changed }`).
 */
export function parseUpgrades(stdout: string): PluginUpgrade[] {
	const upgrades: PluginUpgrade[] = [];
	const json = stdout.search(/^\{/m);
	if (json !== -1) {
		const parsed = PackageUpgradeSchema.safeParse(JSON.parse(stdout.slice(json)));
		if (parsed.success) {
			const { upgraded, from, to, changed } = parsed.data;
			return changed ? [{ id: upgraded, scope: null, from, to }] : [];
		}
	}
	for (const line of stdout.split("\n")) {
		const single = /^Upgraded (\S+) \((user|project)\) to (\S+)$/.exec(line.trim());
		if (single) {
			const [, id = "", scope, to = ""] = single;
			upgrades.push({ id, scope: ScopeSchema.parse(scope), from: null, to });
			continue;
		}
		const bulk = /^(\S+) \((user|project)\): (\S+) -> (\S+)$/.exec(line.trim());
		if (bulk) {
			const [, id = "", scope, from = "", to = ""] = bulk;
			upgrades.push({ id, scope: ScopeSchema.parse(scope), from, to });
		}
	}
	return upgrades;
}

/** `omp plugin marketplace list` (text): `  <name>  <sourceUri>` rows after a header. */
export function parseMarketplaceList(stdout: string): MarketplaceSource[] {
	const sources: MarketplaceSource[] = [];
	for (const line of stdout.split("\n")) {
		const match = /^ {2}(\S+) {2}(.+)$/.exec(line);
		if (match) sources.push({ name: match[1] ?? "", sourceUri: (match[2] ?? "").trim() });
	}
	return sources;
}

/**
 * `omp plugin discover <marketplace>` (text): `  <name>[@<version>]` rows, each optionally followed by a
 * 4-space-indented description. omp prints multi-line descriptions verbatim, so any other non-empty line
 * continues the current description.
 */
export function parseDiscover(
	stdout: string,
	marketplace: string,
	installed: ReadonlyMap<string, PluginScope[]>,
): AvailablePlugin[] {
	const plugins: AvailablePlugin[] = [];
	let inList = false;
	for (const line of stdout.split("\n")) {
		if (!inList) {
			inList = line.startsWith("Available Plugins");
			continue;
		}
		const entry = /^ {2}(\S+)$/.exec(line);
		const current = plugins.at(-1);
		if (entry) {
			const label = entry[1] ?? "";
			const at = label.indexOf("@");
			const name = at > 0 ? label.slice(0, at) : label;
			const id = `${name}@${marketplace}`;
			plugins.push({
				id,
				name,
				marketplace,
				version: at > 0 ? label.slice(at + 1) : null,
				description: null,
				installedScopes: installed.get(id) ?? [],
			});
		} else if (current && line.trim()) {
			const text = line.startsWith("    ") ? line.slice(4) : line;
			current.description = current.description === null ? text : `${current.description}\n${text}`;
		}
	}
	return plugins;
}

/**
 * The message of an uncaught omp exception. Bun prints those as a source excerpt, then
 * `error: <message>`, then `at …` frames; only the message is meaningful to users.
 */
export function uncaughtErrorMessage(stderr: string): string | null {
	return /^error: (.+)$/m.exec(stderr)?.[1]?.trim() ?? null;
}

/** omp's failure text: an uncaught exception's message, else stderr, else stdout, without status glyphs. */
export function failureMessage(stdout: string, stderr: string, fallback: string): string {
	const crash = uncaughtErrorMessage(stderr);
	if (crash) return crash;
	const text = (stderr.trim() || stdout.trim())
		.split("\n")
		.map(line => line.replace(/^[✘✖×]\s*/u, "").trim())
		.filter(Boolean)
		.join("\n");
	return text || fallback;
}
