import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Document } from "yaml";
import { z } from "zod";
import type {
	InvalidSkillFile,
	RegistryInstalledSkill,
	SkillDocument,
	SkillEntry,
	SkillInstallRequest,
	SkillLevel,
	SkillPackageInfo,
	SkillProgress,
	SkillRegistryResult,
	SkillSearchResult,
	SkillSearchSort,
	SkillsListing,
	SkillsSettings,
	SkillUninstallRequest,
	SkillUpdateRequest,
	SkillVersionInfo,
	SkillWarning,
} from "@shared/contracts/skills";
import { pathExists, writeText } from "../../files";
import { agentDir } from "../../omp/paths";
import type { OmpRunner } from "../plugins/stream";
import {
	allSkillsOverlay,
	analyzeSkillFile,
	applySkillSettingsToDocument,
	disabledReason,
	type ListedSkill,
	needsScriptApproval,
	parseRegistryOutput,
	parseSkillConfig,
	parseSkillList,
	parseSkillPackage,
	parseSkillSearch,
	parseSkillVersion,
	registryFailure,
	registryFromPath,
	SkillsSettingsPatchSchema,
	type SkillConfig,
	type SourceContext,
	setSkillEnabledInDocument,
	splitSource,
} from "./parse";

export type SkillProgressSink = (progress: SkillProgress) => void;

/**
 * Applies an edit to omp's global config.yml as a yaml Document (comments preserved). The app passes
 * `editConfig("global", …)` from `omp/config-file`, which serializes edits and re-validates with omp.
 */
export type GlobalConfigEditor = (edit: (doc: Document) => void) => Promise<void>;

const ManifestSchema = z.object({ skills: z.record(z.string(), z.string()).optional() });
const LockSchema = z.object({
	skills: z.record(z.string(), z.object({ version: z.string(), integrity: z.string() })).optional(),
});

async function readJsonFile<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return null;
	}
	return schema.parse(JSON.parse(text));
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export class SkillService {
	readonly #omp: OmpRunner;
	readonly #progress: SkillProgressSink;
	readonly #editGlobalConfig: GlobalConfigEditor;

	constructor(omp: OmpRunner, progress: SkillProgressSink, editGlobalConfig: GlobalConfigEditor) {
		this.#omp = omp;
		this.#progress = progress;
		this.#editGlobalConfig = editGlobalConfig;
	}

	async #query(argv: string[], cwd?: string, env?: Record<string, string>): Promise<string> {
		const result = await this.#omp.run(argv, { cwd: cwd ?? homedir(), env });
		if (result.code !== 0) {
			throw new Error(registryFailure(result.stdout, result.stderr, `omp ${argv.slice(0, 2).join(" ")} exited with ${result.code}`));
		}
		return result.stdout;
	}

	async #config(cwd?: string): Promise<SkillConfig> {
		return parseSkillConfig(await this.#query(["config", "list", "--json"], cwd));
	}

	/** Effective listing plus the every-source-on listing, run concurrently. */
	async #listings(cwd: string, config: SkillConfig) {
		const env = await this.#omp.env();
		const overlay = join(tmpdir(), `visual-omp-skills-${process.pid}-${randomUUID()}.json`);
		await writeText(overlay, allSkillsOverlay(config));
		try {
			const configFiles = [env.PI_CONFIG_FILES, overlay].filter(Boolean).join(delimiter);
			const argv = ["skill", "list", cwd, "--json"];
			const [effective, all] = await Promise.all([
				this.#query(argv, cwd).then(parseSkillList),
				this.#query(argv, cwd, { PI_CONFIG_FILES: configFiles }).then(parseSkillList),
			]);
			return { effective, all, env };
		} finally {
			await rm(overlay, { force: true });
		}
	}

	async list(cwd: string): Promise<SkillsListing> {
		const config = await this.#config(cwd);
		const { effective, all, env } = await this.#listings(cwd, config);
		const home = env.HOME || homedir();
		const claudeRoot = `${resolve(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"))}${sep}`;

		const loadedPaths = new Set(effective.skills.map(skill => skill.filePath));
		const disabled = all.skills
			.filter(skill => !loadedPaths.has(skill.filePath))
			.sort((a, b) => a.name.localeCompare(b.name));
		const listed: Array<{ skill: ListedSkill; enabled: boolean }> = [
			...effective.skills.map(skill => ({ skill, enabled: true })),
			...disabled.map(skill => ({ skill, enabled: false })),
		];

		const warningsByPath = new Map<string, string[]>();
		const unattached: SkillWarning[] = [];
		for (const warning of effective.warnings) {
			if (warning.skillPath && listed.some(({ skill }) => skill.filePath === warning.skillPath)) {
				warningsByPath.set(warning.skillPath, [...(warningsByPath.get(warning.skillPath) ?? []), warning.message]);
			} else {
				unattached.push({ skillPath: warning.skillPath || null, message: warning.message });
			}
		}

		const contents = await Promise.all(listed.map(({ skill }) => readFile(skill.filePath, "utf8").catch(() => null)));
		const skills = listed.map(({ skill, enabled }, index): SkillEntry => {
			const { provider, level } = splitSource(skill.source);
			const content = contents[index];
			const dirName = basename(skill.baseDir);
			const issues =
				content === null || content === undefined
					? [{ code: "unreadable" as const, severity: "error" as const, message: "SKILL.md could not be read." }]
					: analyzeSkillFile(content, dirName, provider).issues;
			const context: SourceContext = {
				config,
				inClaudeTree: skill.filePath.startsWith(claudeRoot),
				claudeConfigDirSet: Boolean(env.CLAUDE_CONFIG_DIR?.trim()),
			};
			const off = enabled ? null : disabledReason({ name: skill.name, provider, level }, context);
			return {
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
				baseDir: skill.baseDir,
				provider,
				level,
				source: skill.source,
				hidden: skill.hide,
				enabled,
				disabledReason: off?.reason ?? null,
				toggleName: off ? off.toggleName : skill.name,
				registry: provider === "skillshare" ? registryFromPath(skill.filePath) : null,
				issues,
				warnings: warningsByPath.get(skill.filePath) ?? [],
			};
		});

		const invalid = await this.#invalidFiles(cwd, env, config, listed.map(({ skill }) => skill), contents);
		return { cwd, skillsEnabled: config.skills.enabled, skills, invalid, warnings: unattached };
	}

	/**
	 * SKILL.md files in the skill roots that omp did not list and that have a load-blocking frontmatter
	 * problem. Files identical to a listed skill are omp's silent duplicate drops, not errors.
	 */
	async #invalidFiles(
		cwd: string,
		env: NodeJS.ProcessEnv,
		config: SkillConfig,
		listed: ListedSkill[],
		contents: Array<string | null>,
	): Promise<InvalidSkillFile[]> {
		const home = env.HOME || homedir();
		const roots = new Set<string>([
			join(agentDir(env), "skills"),
			join(cwd, ".omp", "skills"),
			join(cwd, ".agents", "skills"),
			join(home, ".agents", "skills"),
			...listed.map(skill => dirname(skill.baseDir)),
			...config.skills.customDirectories.map(dir => {
				const expanded = dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
				return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
			}),
		]);
		const known = new Set(listed.map(skill => skill.filePath));
		await Promise.all(listed.map(async skill => known.add(await realpath(skill.filePath).catch(() => skill.filePath))));
		const knownContents = new Set(contents.filter(content => content !== null));

		const candidates = await Promise.all(
			[...roots].map(async root => {
				const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
				return entries
					.filter(entry => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
					.map(entry => join(root, entry.name, "SKILL.md"));
			}),
		);
		const invalid: InvalidSkillFile[] = [];
		const seen = new Set<string>();
		for (const filePath of candidates.flat()) {
			if (known.has(filePath) || seen.has(filePath)) continue;
			seen.add(filePath);
			const content = await readFile(filePath, "utf8").catch(() => null);
			if (content === null || knownContents.has(content)) continue;
			if (known.has(await realpath(filePath).catch(() => filePath))) continue;
			const dirName = basename(dirname(filePath));
			const { issues } = analyzeSkillFile(content, dirName);
			if (issues.some(issue => issue.severity === "error")) invalid.push({ filePath, dirName, issues });
		}
		return invalid.sort((a, b) => a.filePath.localeCompare(b.filePath));
	}

	async read(filePath: string): Promise<SkillDocument> {
		if (basename(filePath) !== "SKILL.md") throw new Error(`Not a SKILL.md file: ${filePath}`);
		const content = await readFile(filePath, "utf8");
		const { frontmatter, body, issues } = analyzeSkillFile(content, basename(dirname(filePath)));
		return { filePath, content, frontmatter, body, issues };
	}

	async settings(): Promise<SkillsSettings> {
		return (await this.#config()).skills;
	}

	/** Toggle `skill:<name>` in the global config's `disabledExtensions` (read-modify-write inside one locked edit). */
	async setEnabled(name: string, enabled: boolean): Promise<SkillsSettings> {
		await this.#editGlobalConfig(doc => setSkillEnabledInDocument(doc, name, enabled));
		return this.settings();
	}

	/** Type-check the patch (omp only warns on wrong types), then apply it to the global config in one edit. */
	async setSettings(patch: Partial<SkillsSettings>): Promise<SkillsSettings> {
		const parsed = SkillsSettingsPatchSchema.safeParse(patch);
		if (!parsed.success) throw new Error(`Invalid skills settings: ${z.prettifyError(parsed.error)}`);
		await this.#editGlobalConfig(doc => applySkillSettingsToDocument(doc, parsed.data));
		return this.settings();
	}

	// ─── Registry ───────────────────────────────────────────────────────────────

	async search(query: string, sort: SkillSearchSort = "relevance"): Promise<SkillSearchResult> {
		return parseSkillSearch(await this.#query(["skill", "search", query, "--sort", sort, "--json"]));
	}

	async info(id: string): Promise<SkillPackageInfo> {
		return parseSkillPackage(await this.#query(["skill", "info", id, "--json"]));
	}

	async version(id: string, version: string): Promise<SkillVersionInfo> {
		return parseSkillVersion(await this.#query(["skill", "info", `${id}@${version}`, "--json"]));
	}

	/** omp's project `.omp/` for skills.json: nearest `.omp/` below home, else the git root's, else `<cwd>/.omp/`. */
	async #projectSkillsDir(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
		const home = resolve(env.HOME || homedir());
		const configDir = env.PI_CONFIG_DIR || ".omp";
		for (const marker of [configDir, ".git"]) {
			let dir = resolve(cwd);
			while (dir !== home) {
				if (marker === configDir ? await isDirectory(join(dir, marker)) : await pathExists(join(dir, marker))) {
					return join(dir, configDir);
				}
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		}
		return resolve(cwd) === home ? null : join(resolve(cwd), configDir);
	}

	async installed(cwd: string): Promise<RegistryInstalledSkill[]> {
		const env = await this.#omp.env();
		const userDir = agentDir(env);
		const projectDir = await this.#projectSkillsDir(cwd, env);
		const sources: Array<{ scope: SkillLevel; dir: string }> = [];
		if (projectDir && projectDir !== userDir) sources.push({ scope: "project", dir: projectDir });
		sources.push({ scope: "user", dir: userDir });
		const store = join(dirname(userDir), "skillshare");

		const out: RegistryInstalledSkill[] = [];
		for (const { scope, dir } of sources) {
			const manifestPath = join(dir, "skills.json");
			const [manifest, lock] = await Promise.all([
				readJsonFile(manifestPath, ManifestSchema),
				readJsonFile(join(dir, "skills.lock.json"), LockSchema),
			]);
			const ranges = manifest?.skills ?? {};
			const locked = lock?.skills ?? {};
			for (const id of [...new Set([...Object.keys(ranges), ...Object.keys(locked)])].sort()) {
				const entry = locked[id];
				const slash = id.indexOf("/");
				const stored =
					entry !== undefined &&
					slash > 1 &&
					(await readFile(join(store, id.slice(0, slash), id.slice(slash + 1), entry.version, ".skillshare-integrity"), "utf8")
						.then(text => text.trim() === entry.integrity)
						.catch(() => false));
				out.push({ id, scope, range: ranges[id] ?? null, version: entry?.version ?? null, stored, manifestPath });
			}
		}
		return out;
	}

	async #registryOperation(argv: string[], cwd: string, opId: string = randomUUID()): Promise<SkillRegistryResult> {
		const log: string[] = [];
		const result = await this.#omp.stream(argv, {
			cwd,
			opId,
			onLine: (line, stream) => {
				log.push(line);
				this.#progress({ opId, stream, line });
			},
		});
		const ok = result.code === 0;
		const parsed = parseRegistryOutput(result.stdout, result.stderr);
		return {
			opId,
			ok,
			error: ok ? null : registryFailure(result.stdout, result.stderr, `omp ${argv.slice(0, 2).join(" ")} exited with ${result.code}`),
			needsScriptApproval: !ok && needsScriptApproval(result.stderr),
			...parsed,
			log,
		};
	}

	install(request: SkillInstallRequest): Promise<SkillRegistryResult> {
		const argv = ["skill", "install", ...request.specs];
		if (request.global) argv.push("-g");
		if (request.yes) argv.push("-y");
		return this.#registryOperation(argv, request.cwd, request.opId);
	}

	update(request: SkillUpdateRequest): Promise<SkillRegistryResult> {
		const argv = ["skill", "update", ...request.names];
		if (request.global) argv.push("-g");
		if (request.yes) argv.push("-y");
		return this.#registryOperation(argv, request.cwd, request.opId);
	}

	uninstall(request: SkillUninstallRequest): Promise<SkillRegistryResult> {
		const argv = ["skill", "uninstall", ...request.names];
		if (request.global) argv.push("-g");
		return this.#registryOperation(argv, request.cwd, request.opId);
	}
}
