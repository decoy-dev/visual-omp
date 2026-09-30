import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { app } from "electron";
import type { ProjectSummary } from "@shared/ipc";
import type {
	InstructionFile,
	ProjectCreateResult,
	ProjectInstructions,
	ProjectNameCheck,
	ProjectRule,
	RecentFolder,
	RuleDraft,
	RuleSource,
} from "@shared/contracts/project";
import { writeText } from "../files";
import { handle } from "../ipc";
import { listProjects } from "../omp/sessions";
import { getPrefs, setPrefs } from "../prefs";
import {
	APPLY_TO_ALL,
	DEFAULT_INSTRUCTIONS_REL_PATH,
	INSTRUCTION_CANDIDATES,
	activeInstruction,
	normalizeRuleName,
	parseRuleMarkdown,
	projectNameProblem,
	renderRuleMarkdown,
} from "../services/project";

const MAX_RECENT = 50;
const recentFile = join(app.getPath("userData"), "recent-folders.json");
const RecentList = z.array(z.object({ path: z.string(), openedAt: z.number() }));
type RecentList = z.infer<typeof RecentList>;

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** File content, or null when it does not exist. Other read errors propagate. */
async function readIfExists(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

let recent: RecentList | null = null;
let recentWrite: Promise<void> = Promise.resolve();

async function loadRecent(): Promise<RecentList> {
	if (recent) return recent;
	const text = await readIfExists(recentFile).catch(() => null);
	let parsed: RecentList = [];
	if (text) {
		try {
			parsed = RecentList.catch([]).parse(JSON.parse(text));
		} catch {
			parsed = [];
		}
	}
	recent ??= parsed;
	return recent;
}

async function saveRecent(next: RecentList): Promise<void> {
	recent = next;
	const snapshot = JSON.stringify(next, null, 2);
	const write = recentWrite.then(() => writeText(recentFile, snapshot));
	// Keep the queue alive after a failed write; this caller still sees the error.
	recentWrite = write.catch(() => {});
	await write;
}

async function checkName(name: string, parentDir?: string): Promise<ProjectNameCheck> {
	const parent = resolve(parentDir ?? join(homedir(), "Projects"));
	const path = join(parent, name.trim());
	const problem = projectNameProblem(name);
	if (problem) return { ok: false, problem, path, existsEmpty: false };
	let info;
	try {
		info = await stat(path);
	} catch (error) {
		if (isMissing(error)) return { ok: true, problem: null, path, existsEmpty: false };
		throw error;
	}
	if (!info.isDirectory()) return { ok: false, problem: "notDirectory", path, existsEmpty: false };
	const entries = (await readdir(path)).filter(entry => entry !== ".DS_Store");
	if (entries.length > 0) return { ok: false, problem: "notEmpty", path, existsEmpty: false };
	return { ok: true, problem: null, path, existsEmpty: true };
}

async function addProject(input: string): Promise<ProjectSummary> {
	const path = resolve(input);
	const info = await stat(path).catch(() => null);
	if (!info?.isDirectory()) throw new Error(`Not a folder: ${path}`);
	const prefs = getPrefs();
	setPrefs({ extraProjects: [path, ...prefs.extraProjects.filter(p => p !== path)] });
	const list = await loadRecent();
	await saveRecent([{ path, openedAt: Date.now() }, ...list.filter(item => item.path !== path)].slice(0, MAX_RECENT));
	app.addRecentDocument(path);
	const summary = (await listProjects()).find(project => project.path === path);
	return summary ?? { path, name: basename(path) || path, sessionCount: 0, lastActivity: 0, exists: true };
}

async function createProject(name: string, parentDir?: string): Promise<ProjectCreateResult> {
	const check = await checkName(name, parentDir);
	if (!check.ok) return { ok: false, problem: check.problem ?? "empty", path: check.path };
	await mkdir(check.path, { recursive: true });
	await addProject(check.path);
	return { ok: true, path: check.path };
}

async function removeProject(input: string): Promise<void> {
	const path = resolve(input);
	const prefs = getPrefs();
	setPrefs({
		extraProjects: prefs.extraProjects.filter(p => p !== path),
		pinnedProjects: prefs.pinnedProjects.filter(p => p !== path),
	});
	await saveRecent((await loadRecent()).filter(item => item.path !== path));
}

async function recentFolders(limit = 12): Promise<RecentFolder[]> {
	const [projects, list] = await Promise.all([listProjects(), loadRecent()]);
	const opened = new Map(list.map(item => [item.path, item.openedAt]));
	const registered = new Set(getPrefs().extraProjects);
	return projects
		.map(project => ({
			path: project.path,
			name: project.name,
			lastUsed: Math.max(project.lastActivity, opened.get(project.path) ?? 0),
			sessionCount: project.sessionCount,
			exists: project.exists,
			registered: registered.has(project.path),
		}))
		.sort((a, b) => b.lastUsed - a.lastUsed)
		.slice(0, Math.max(0, limit));
}

function inProject(projectDir: string, relPath: string): string {
	return join(projectDir, ...relPath.split("/"));
}

async function readInstructions(input: string): Promise<ProjectInstructions> {
	const projectDir = resolve(input);
	const files = await Promise.all(
		INSTRUCTION_CANDIDATES.map(async candidate => {
			const path = inProject(projectDir, candidate.relPath);
			const content = await readIfExists(path);
			return { ...candidate, path, content, exists: content !== null };
		}),
	);
	const activeRelPath = activeInstruction(files, basename(projectDir));
	const withActive: InstructionFile[] = files.map(file => ({
		...file,
		active: file.kind === "sticky" ? Boolean(file.content?.trim()) : file.relPath === activeRelPath,
	}));
	const primaryRelPath =
		activeRelPath ??
		files.find(file => file.kind === "context" && file.exists)?.relPath ??
		DEFAULT_INSTRUCTIONS_REL_PATH;
	return { projectDir, files: withActive, activeRelPath, primaryRelPath };
}

async function writeInstructions(input: string, relPath: string, content: string): Promise<ProjectInstructions> {
	if (!INSTRUCTION_CANDIDATES.some(candidate => candidate.relPath === relPath)) {
		throw new Error(`Not a project instructions file: ${relPath}`);
	}
	const projectDir = resolve(input);
	await writeText(inProject(projectDir, relPath), content);
	return readInstructions(projectDir);
}

/** A directory of rule files, or a single legacy rule file (named after the file without its dot). */
type RuleLocation =
	| { source: RuleSource; dir: string; extensions: string[]; recursive?: boolean }
	| { source: RuleSource; file: string };

/** Project-root rule conventions omp discovers (see oh-my-pi docs/rulebook-matching-pipeline.md). */
const RULE_LOCATIONS: RuleLocation[] = [
	{ source: "omp", dir: ".omp/rules", extensions: [".md", ".mdc"] },
	{ source: "agents", dir: ".agent/rules", extensions: [".md", ".mdc"] },
	{ source: "agents", dir: ".agents/rules", extensions: [".md", ".mdc"] },
	{ source: "cursor", dir: ".cursor/rules", extensions: [".mdc", ".md"] },
	{ source: "cursor", file: ".cursorrules" },
	{ source: "windsurf", dir: ".windsurf/rules", extensions: [".md"] },
	{ source: "windsurf", file: ".windsurfrules" },
	{ source: "cline", dir: ".clinerules", extensions: [".md"] },
	{ source: "cline", file: ".clinerules" },
	{ source: "github", dir: ".github/instructions", extensions: [".instructions.md"], recursive: true },
];

async function filesIn(dir: string, extensions: string[], recursive: boolean): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const found: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory() && recursive) found.push(...(await filesIn(full, extensions, true)));
		else if (entry.isFile() && extensions.some(ext => entry.name.toLowerCase().endsWith(ext))) found.push(full);
	}
	return found;
}

function toRule(projectDir: string, source: RuleSource, name: string, path: string, content: string): ProjectRule {
	const parsed = parseRuleMarkdown(content);
	const applyTo = parsed.applyTo?.trim() ?? null;
	return {
		name,
		source,
		path,
		relPath: relative(projectDir, path).split(sep).join("/"),
		editable: source === "omp",
		description: parsed.description,
		globs:
			source === "github"
				? (applyTo ?? "")
						.split(",")
						.map(glob => glob.trim())
						.filter(Boolean)
				: parsed.globs,
		alwaysApply: source === "github" ? applyTo !== null && APPLY_TO_ALL[applyTo] === true : parsed.alwaysApply,
		enabled: parsed.enabled,
		body: parsed.body,
		content,
		frontmatterError: parsed.frontmatterError,
	};
}

async function listRules(input: string): Promise<ProjectRule[]> {
	const projectDir = resolve(input);
	const groups = await Promise.all(
		RULE_LOCATIONS.map(async location => {
			let found: Array<{ path: string; name: string }>;
			if ("file" in location) {
				const path = inProject(projectDir, location.file);
				const info = await stat(path).catch(() => null);
				found = info?.isFile() ? [{ path, name: location.file.slice(1) }] : [];
			} else {
				const paths = await filesIn(inProject(projectDir, location.dir), location.extensions, location.recursive === true);
				found = paths.map(path => ({
					path,
					name: basename(path).replace(location.source === "github" ? /\.instructions\.md$/i : /\.(md|mdc)$/i, ""),
				}));
			}
			const rules = await Promise.all(
				found.map(async ({ path, name }) => {
					const content = await readIfExists(path);
					return content === null ? null : toRule(projectDir, location.source, name, path, content);
				}),
			);
			return rules
				.filter((rule): rule is ProjectRule => rule !== null)
				.sort((a, b) => a.name.localeCompare(b.name));
		}),
	);
	return groups.flat();
}

function nativeRulePaths(projectDir: string, name: string): { md: string; mdc: string } {
	const dir = inProject(projectDir, ".omp/rules");
	return { md: join(dir, `${name}.md`), mdc: join(dir, `${name}.mdc`) };
}

async function writeRule(input: string, draft: RuleDraft): Promise<ProjectRule[]> {
	const projectDir = resolve(input);
	const name = normalizeRuleName(draft.name);
	if (!name) throw new Error(`Rule names may use letters, digits, ".", "_" and "-": ${draft.name}`);
	const { md, mdc } = nativeRulePaths(projectDir, name);
	const mdcContent = await readIfExists(mdc);
	const target = mdcContent !== null ? mdc : md;
	const existing = mdcContent ?? (await readIfExists(md));
	await writeText(target, renderRuleMarkdown(existing, draft));
	return listRules(projectDir);
}

async function deleteRule(input: string, ruleName: string): Promise<ProjectRule[]> {
	const projectDir = resolve(input);
	const name = normalizeRuleName(ruleName);
	if (!name) throw new Error(`Not a rule name: ${ruleName}`);
	const { md, mdc } = nativeRulePaths(projectDir, name);
	await Promise.all([rm(md, { force: true }), rm(mdc, { force: true })]);
	return listRules(projectDir);
}

export function register(): void {
	handle("project:defaults", () => ({ parentDir: join(homedir(), "Projects") }));
	handle("project:checkName", (name, parentDir) => checkName(name, parentDir));
	handle("project:create", options => createProject(options.name, options.parentDir));
	handle("project:add", path => addProject(path));
	handle("project:remove", path => removeProject(path));
	handle("project:recent", limit => recentFolders(limit));
	handle("project:instructions", projectDir => readInstructions(projectDir));
	handle("project:instructions:write", (projectDir, relPath, content) => writeInstructions(projectDir, relPath, content));
	handle("project:rules", projectDir => listRules(projectDir));
	handle("project:rules:write", (projectDir, draft) => writeRule(projectDir, draft));
	handle("project:rules:delete", (projectDir, name) => deleteRule(projectDir, name));
}
