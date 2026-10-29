/**
 * Discovers the markdown slash commands omp loads for a project, mirroring omp's own discovery
 * (discovery/builtin.ts + discovery/claude.ts): `<cwd>/.omp/commands/*.md`, `<agentDir>/commands/*.md`
 * and `<cwd>/.claude/commands/**` (nested files become `dir:name`). Description comes from frontmatter
 * `description`, else the first non-empty line cut to 60 characters (extensibility/slash-commands.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CustomCommand } from "@shared/contracts/composer";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MAX_DESCRIPTION = 60;

const frontmatterSchema = z
	.object({
		description: z.string().optional(),
		"argument-hint": z.string().optional(),
		argumentHint: z.string().optional(),
	})
	.loose();

/** Description + argument hint of one command file. */
export function parseCommandFile(content: string): { description: string; argumentHint: string | null } {
	const match = FRONTMATTER.exec(content);
	let meta: z.infer<typeof frontmatterSchema> = {};
	if (match?.[1]) {
		try {
			const parsed = frontmatterSchema.safeParse(parseYaml(match[1]));
			if (parsed.success) meta = parsed.data;
		} catch {
			// Invalid YAML: omp falls back to the body too.
		}
	}
	const body = match ? content.slice(match[0].length) : content;
	const firstLine = body
		.split("\n")
		.map(line => line.trim())
		.find(line => line.length > 0);
	const fallback = firstLine
		? firstLine.length > MAX_DESCRIPTION
			? `${firstLine.slice(0, MAX_DESCRIPTION)}...`
			: firstLine
		: "";
	return {
		description: meta.description?.trim() || fallback,
		argumentHint: (meta["argument-hint"] ?? meta.argumentHint)?.trim() || null,
	};
}

async function markdownFiles(dir: string, recursive: boolean): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true, recursive });
	} catch {
		return [];
	}
	return entries
		.filter(entry => entry.isFile() && entry.name.endsWith(".md"))
		.map(entry => join(entry.parentPath, entry.name));
}

async function load(dir: string, scope: CustomCommand["scope"], nested: boolean): Promise<CustomCommand[]> {
	const files = await markdownFiles(dir, nested);
	const commands = await Promise.all(
		files.map(async (filePath): Promise<CustomCommand | null> => {
			let content: string;
			try {
				content = await readFile(filePath, "utf8");
			} catch {
				return null;
			}
			const name = relative(dir, filePath).replace(/\.md$/, "").split(/[\\/]/).join(":");
			return { name, scope, filePath, ...parseCommandFile(content) };
		}),
	);
	return commands.filter(command => command !== null);
}

/** Commands for `cwd`, first definition of a name wins (project before user), sorted by name. */
export async function discoverCommands(cwd: string, agentDir: string): Promise<CustomCommand[]> {
	const groups = await Promise.all([
		load(join(cwd, ".omp", "commands"), "project", false),
		load(join(cwd, ".claude", "commands"), "project", true),
		load(join(agentDir, "commands"), "user", false),
	]);
	const byName = new Map<string, CustomCommand>();
	for (const command of groups.flat()) if (!byName.has(command.name)) byName.set(command.name, command);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

