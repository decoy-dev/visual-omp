/**
 * Discovers the markdown slash commands omp loads for a project, mirroring omp's own discovery
 * (discovery/builtin.ts + discovery/claude.ts): `<cwd>/.omp/commands/*.md`, `<agentDir>/commands/*.md`
 * and `<cwd>/.claude/commands/**` (nested files become `dir:name`). Description comes from frontmatter
 * `description`, else the first non-empty line cut to 60 characters (extensibility/slash-commands.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isMap, parseDocument, parse as parseYaml } from "yaml";
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

const STT_ACTION = "app.stt.toggle";
/** Function keys omp binds nothing to by default; the first one free in the user's file is used. */
const STT_KEY_CANDIDATES = ["f9", "f10", "f8", "f12", "f7"];

function keyList(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter(item => typeof item === "string");
	return [];
}

/**
 * Make sure omp's dictation toggle (`app.stt.toggle`, unbound by default) has a function key the app can
 * press. `source` is the current keybindings.yml text (null when missing). Returns the key to press and
 * the new file text, or `text: null` when the file already binds one (comments and layout are kept).
 */
export function ensureSttBinding(source: string | null): { key: string; text: string | null } {
	const doc = parseDocument(source ?? "");
	const raw: unknown = doc.toJS() ?? {};
	const config: Record<string, unknown> = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
	const current = keyList(config[STT_ACTION]).map(key => key.toLowerCase());
	const existing = STT_KEY_CANDIDATES.find(key => current.includes(key));
	if (existing) return { key: existing, text: null };
	const claimed = new Set(
		Object.entries(config)
			.filter(([action]) => action !== STT_ACTION)
			.flatMap(([, value]) => keyList(value).map(key => key.toLowerCase())),
	);
	const key = STT_KEY_CANDIDATES.find(candidate => !claimed.has(candidate));
	if (!key) throw new Error("No free function key for voice input in keybindings.yml");
	if (!isMap(doc.contents)) {
		// Empty (or comments-only) file: append a line so existing comments stay untouched.
		const prefix = source?.trim() ? `${source.replace(/\s*$/, "")}\n` : "";
		return { key, text: `${prefix}${STT_ACTION}: ${key}\n` };
	}
	doc.set(STT_ACTION, current.length > 0 ? [...keyList(config[STT_ACTION]), key] : key);
	return { key, text: doc.toString() };
}

/** omp's Editor `debugState()` shape (packages/tui/src/components/editor.ts). */
const editorStateSchema = z.object({
	textPreview: z.string(),
	textLength: z.number(),
	previewTruncated: z.boolean(),
	cursorLine: z.number(),
	lineCount: z.number(),
	placeholderActive: z.boolean(),
});

export type EditorDebugState = z.infer<typeof editorStateSchema>;

/**
 * The prompt editor among the TUI debug `values` (keys are `<kind>[<path>]`, kinds are minified, so the
 * editor is recognised by its state shape). Overlays come last in the path order; the shallowest match
 * outside them is the main prompt editor.
 */
export function findPromptEditor(values: Record<string, unknown>): EditorDebugState | null {
	let best: { depth: number; state: EditorDebugState } | null = null;
	for (const [key, value] of Object.entries(values)) {
		const parsed = editorStateSchema.safeParse(value);
		if (!parsed.success) continue;
		const depth = (/\[([\d.]*)\]$/.exec(key)?.[1] ?? "").split(".").length;
		if (!best || depth < best.depth) best = { depth, state: parsed.data };
	}
	return best?.state ?? null;
}

const BORDER_CHARS = /^[\s│┃|║▏▕]+|[\s│┃|║▏▕]+$/g;

/**
 * Full editor text when the debug preview is truncated (120 chars): find the painted editor rows that
 * start with the preview and join wrapped rows until the known length is reached. omp wraps at spaces
 * and drops the space at the break, so rows are joined with one space. Null when the rows can't be found.
 */
export function editorTextFromScreen(lines: readonly string[], state: EditorDebugState): string | null {
	const firstLine = state.textPreview.split("\n")[0] ?? "";
	const anchor = firstLine.slice(0, 24);
	if (!anchor) return null;
	const cleaned = lines.map(line => line.replace(BORDER_CHARS, ""));
	const start = cleaned.findIndex(line => line.startsWith(anchor));
	if (start < 0) return null;
	let text = "";
	for (let index = start; index < cleaned.length; index++) {
		const row = cleaned[index] ?? "";
		if (!row) break;
		const next = text ? `${text} ${row}` : row;
		if (next.length > state.textLength) {
			const tight = text + row;
			if (tight.length <= state.textLength) text = tight;
			break;
		}
		text = next;
		if (text.length >= state.textLength) break;
	}
	return text;
}
