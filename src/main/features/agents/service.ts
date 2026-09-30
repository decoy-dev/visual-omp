import { mkdtemp, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type {
	AgentCreateDraft,
	AgentDraft,
	AgentEntry,
	AgentFile,
	AgentFileError,
	AgentScope,
	AgentSettingsResult,
	AgentsSnapshot,
	AgentValidation,
	AgentWritableScope,
} from "@shared/contracts/agents";
import { pathExists, readText, writeText } from "../../files";
import { runOmpJson } from "../../omp/cli";
import { deleteConfigPath, readConfig, setConfigPath } from "../../omp/config-file";
import { agentDir } from "../../omp/paths";
import {
	agentFileName,
	applyAgentDraft,
	parseAgentMarkdown,
	readFrontmatter,
	serializeAgent,
	splitFrontmatter,
} from "./parse";

const UnpackResult = z.object({ written: z.array(z.string()) });
const DisabledAgentsValue = z.object({ value: z.array(z.string()) });
/** `task.agentModelOverrides` values are one selector or a prioritized selector list. */
const ModelOverride = z.union([z.string(), z.array(z.string())]);
const ModelOverridesValue = z.object({ value: z.record(z.string(), ModelOverride) });
/** The `task` section of a settings file, for the keys this feature edits. */
const TaskSettingsFile = z
	.object({
		task: z
			.object({
				disabledAgents: z.array(z.string()).optional(),
				agentModelOverrides: z.record(z.string(), ModelOverride).optional(),
			})
			.loose()
			.optional(),
	})
	.loose();

interface BundledAgent {
	name: string;
	content: string;
	validation: Extract<AgentValidation, { ok: true }>;
}

function userAgentsDir(): string {
	return join(agentDir(), "agents");
}

/** omp `findAllNearestProjectConfigDirs("agents")`, `.omp` source: the first `.omp/agents` dir walking up. */
async function nearestProjectAgentsDir(cwd: string): Promise<string | null> {
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, ".omp", "agents");
		const info = await stat(candidate).catch(() => null);
		if (info?.isDirectory()) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

async function scopeDir(scope: AgentWritableScope, cwd: string | null | undefined): Promise<string> {
	if (scope === "user") return userAgentsDir();
	if (!cwd) throw new Error("A project folder is required for project agents.");
	return (await nearestProjectAgentsDir(cwd)) ?? join(resolve(cwd), ".omp", "agents");
}

/** Only `.md` files directly inside the user agents dir or a `.omp/agents` dir may be read or changed. */
function agentFileScope(filePath: string): AgentWritableScope {
	const file = resolve(filePath);
	const dir = dirname(file);
	if (!file.endsWith(".md")) throw new Error(`Not an agent markdown file: ${filePath}`);
	if (dir === resolve(userAgentsDir())) return "user";
	if (basename(dir) === "agents" && basename(dirname(dir)) === ".omp") return "project";
	throw new Error(`Not inside an omp agents folder: ${filePath}`);
}

function agentFile(filePath: string, scope: AgentWritableScope, content: string): AgentFile {
	return { filePath, scope, content, validation: parseAgentMarkdown(content) };
}

let bundledCache: Promise<BundledAgent[]> | null = null;

/** Bundled definitions exactly as omp serializes them (`omp agents unpack` into a scratch dir). */
function bundledAgents(refresh = false): Promise<BundledAgent[]> {
	if (refresh || !bundledCache) {
		bundledCache = (async () => {
			const dir = await mkdtemp(join(tmpdir(), "vomp-agents-"));
			try {
				const { written } = UnpackResult.parse(
					await runOmpJson(["agents", "unpack", "--dir", dir, "--force", "--json"], { cwd: dir }),
				);
				const agents: BundledAgent[] = [];
				for (const file of written.sort()) {
					const content = await readText(file);
					const validation = parseAgentMarkdown(content);
					if (!validation.ok) throw new Error(`omp produced an invalid bundled agent ${basename(file)}: ${validation.error}`);
					agents.push({ name: validation.fields.name, content, validation });
				}
				return agents;
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		})();
		bundledCache.catch(() => {
			bundledCache = null;
		});
	}
	return bundledCache;
}

interface LoadedDir {
	agents: Array<{ filePath: string; validation: Extract<AgentValidation, { ok: true }> }>;
	errors: AgentFileError[];
}

/** omp `loadAgentsFromDir`: `*.md` files (and symlinks) in lexicographic order; bad files are skipped. */
async function loadAgentsDir(dir: string | null, scope: AgentWritableScope): Promise<LoadedDir> {
	const result: LoadedDir = { agents: [], errors: [] };
	if (!dir) return result;
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.map(entry => entry.name)
		.sort((a, b) => a.localeCompare(b));
	for (const name of files) {
		const filePath = join(dir, name);
		let content: string;
		try {
			content = await readText(filePath);
		} catch (error) {
			result.errors.push({ filePath, scope, name: null, message: `Cannot read file: ${String(error)}` });
			continue;
		}
		const validation = parseAgentMarkdown(content);
		if (validation.ok) {
			result.agents.push({ filePath, validation });
		} else {
			const { frontmatter } = readFrontmatter(splitFrontmatter(content).metadata);
			const fmName = typeof frontmatter.name === "string" ? frontmatter.name : null;
			result.errors.push({ filePath, scope, name: fmName, message: validation.error });
		}
	}
	return result;
}

interface AgentSettings {
	disabled: string[];
	modelOverrides: Record<string, string[]>;
}

/** Effective values as omp resolves them for `cwd` (global + project layers + env). */
async function readAgentSettings(cwd: string | null | undefined): Promise<AgentSettings> {
	const options = { cwd: cwd ?? agentDir() };
	const [disabled, overrides] = await Promise.all([
		runOmpJson(["config", "get", "task.disabledAgents", "--json"], options),
		runOmpJson(["config", "get", "task.agentModelOverrides", "--json"], options),
	]);
	return {
		disabled: DisabledAgentsValue.parse(disabled).value,
		modelOverrides: Object.fromEntries(
			Object.entries(ModelOverridesValue.parse(overrides).value).map(([name, value]) => [
				name,
				typeof value === "string" ? [value] : value,
			]),
		),
	};
}

async function readTaskSettingsFile(scope: "global" | "project", cwd?: string): Promise<z.infer<typeof TaskSettingsFile>> {
	const { file, data } = await readConfig(scope, cwd);
	const parsed = TaskSettingsFile.safeParse(data);
	if (!parsed.success) throw new Error(`Unexpected task settings in ${file}: ${parsed.error.message}`);
	return parsed.data;
}

export async function listAgents(cwd?: string | null, refresh = false): Promise<AgentsSnapshot> {
	const userDir = userAgentsDir();
	const projectDir = cwd ? await nearestProjectAgentsDir(cwd) : null;
	const [bundled, project, user, settings] = await Promise.all([
		bundledAgents(refresh),
		loadAgentsDir(projectDir, "project"),
		loadAgentsDir(userDir, "user"),
		readAgentSettings(cwd),
	]);

	const disabled = new Set(settings.disabled);
	const winners = new Map<string, AgentEntry>();
	const agents: AgentEntry[] = [];
	const add = (
		scope: AgentScope,
		id: string,
		filePath: string | null,
		{ fields, systemPrompt, warnings }: Extract<AgentValidation, { ok: true }>,
	) => {
		const winner = winners.get(fields.name);
		const entry: AgentEntry = {
			...fields,
			id,
			scope,
			filePath,
			systemPrompt,
			enabled: !disabled.has(fields.name),
			modelOverride: settings.modelOverrides[fields.name] ?? null,
			active: !winner,
			shadowedBy: winner?.scope ?? null,
			overrides: [],
			warnings,
		};
		if (winner) {
			if (!winner.overrides.includes(scope)) winner.overrides.push(scope);
		} else {
			winners.set(fields.name, entry);
		}
		agents.push(entry);
	};
	for (const agent of project.agents) add("project", agent.filePath, agent.filePath, agent.validation);
	for (const agent of user.agents) add("user", agent.filePath, agent.filePath, agent.validation);
	for (const agent of bundled) add("bundled", `bundled:${agent.name}`, null, agent.validation);

	return {
		agents,
		errors: [...project.errors, ...user.errors],
		dirs: { user: userDir, project: projectDir, projectDefault: cwd ? join(resolve(cwd), ".omp", "agents") : null },
		disabled: settings.disabled,
		modelOverrides: settings.modelOverrides,
	};
}

export async function readAgentFile(filePath: string): Promise<AgentFile> {
	const scope = agentFileScope(filePath);
	return agentFile(resolve(filePath), scope, await readText(filePath));
}

export async function createAgent(
	draft: AgentCreateDraft,
	scope: AgentWritableScope,
	cwd?: string | null,
): Promise<AgentFile> {
	const content = serializeAgent(draft);
	const validation = parseAgentMarkdown(content);
	if (!validation.ok) throw new Error(validation.error);
	const filePath = join(await scopeDir(scope, cwd), agentFileName(draft.name));
	if (await pathExists(filePath)) throw new Error(`An agent file already exists at ${filePath}`);
	await writeText(filePath, content);
	return { filePath, scope, content, validation };
}

export async function updateAgent(filePath: string, draft: AgentDraft): Promise<AgentFile> {
	const scope = agentFileScope(filePath);
	const content = applyAgentDraft(await readText(filePath), draft);
	const file = agentFile(resolve(filePath), scope, content);
	if (!file.validation.ok) throw new Error(file.validation.error);
	await writeText(file.filePath, content);
	return file;
}

export async function writeAgentRaw(filePath: string, content: string): Promise<AgentFile> {
	const file = agentFile(resolve(filePath), agentFileScope(filePath), content);
	await writeText(file.filePath, content);
	return file;
}

export async function deleteAgent(filePath: string): Promise<void> {
	agentFileScope(filePath);
	await unlink(resolve(filePath));
}

export async function customizeBundledAgent(
	name: string,
	scope: AgentWritableScope,
	cwd?: string | null,
	overwrite = false,
): Promise<AgentFile> {
	const agent = (await bundledAgents()).find(candidate => candidate.name === name);
	if (!agent) throw new Error(`No bundled agent named "${name}".`);
	const filePath = join(await scopeDir(scope, cwd), `${name}.md`);
	if (!overwrite && (await pathExists(filePath))) throw new Error(`An agent file already exists at ${filePath}`);
	await writeText(filePath, agent.content);
	return { filePath, scope, content: agent.content, validation: agent.validation };
}

type TaskSection = z.infer<typeof TaskSettingsFile>["task"];

/** This feature's read-modify-write settings edits must not interleave. */
let settingsQueue: Promise<unknown> = Promise.resolve();

/**
 * Write to the global `config.yml`, then report the effective values for `cwd` and, when the change
 * did not take effect, whether the project's `.omp/config.yml` is what shadows it.
 */
function updateAgentSettings(
	cwd: string | null | undefined,
	write: () => Promise<unknown>,
	isEffective: (settings: AgentSettings) => boolean,
	projectShadows: (task: TaskSection) => boolean,
): Promise<AgentSettingsResult> {
	const run = settingsQueue.then(async (): Promise<AgentSettingsResult> => {
		await write();
		const settings = await readAgentSettings(cwd);
		if (isEffective(settings)) return { ...settings, shadowedBy: null };
		const project = cwd ? (await readTaskSettingsFile("project", cwd)).task : undefined;
		return { ...settings, shadowedBy: projectShadows(project) ? "project" : "other" };
	});
	settingsQueue = run.catch(() => undefined);
	return run;
}

export function setAgentEnabled(name: string, enabled: boolean, cwd?: string | null): Promise<AgentSettingsResult> {
	const path = ["task", "disabledAgents"];
	return updateAgentSettings(
		cwd,
		async () => {
			const stored = (await readTaskSettingsFile("global")).task?.disabledAgents ?? [];
			const next = enabled ? stored.filter(entry => entry !== name) : [...new Set([...stored, name])];
			return next.length > 0 ? setConfigPath("global", undefined, path, next) : deleteConfigPath("global", undefined, path);
		},
		settings => settings.disabled.includes(name) !== enabled,
		task => task?.disabledAgents !== undefined,
	);
}

export function setAgentModelOverride(
	name: string,
	model: string[] | null,
	cwd?: string | null,
): Promise<AgentSettingsResult> {
	const selectors = model?.map(entry => entry.trim()).filter(Boolean) ?? [];
	const [only] = selectors;
	const path = ["task", "agentModelOverrides", name];
	return updateAgentSettings(
		cwd,
		() =>
			selectors.length === 0
				? deleteConfigPath("global", undefined, path)
				: // A lone selector is stored as a plain string, the common hand-written form.
					setConfigPath("global", undefined, path, selectors.length === 1 && only ? only : selectors),
		settings => JSON.stringify(settings.modelOverrides[name] ?? []) === JSON.stringify(selectors),
		task => task?.agentModelOverrides?.[name] !== undefined,
	);
}
