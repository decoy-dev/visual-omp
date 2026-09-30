import { isMap, parseDocument, parse as parseYaml } from "yaml";
import { z } from "zod";
import type { FolderProblem, InstructionsProvider, ProjectNameProblem, RuleDraft } from "@shared/contracts/project";

const INVALID_NAME_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Checks a folder name against the rules of macOS and Windows alike, so a project stays
 * openable when it is shared across machines. Returns null when the name is acceptable.
 */
export function projectNameProblem(name: string): ProjectNameProblem | null {
	const trimmed = name.trim();
	if (!trimmed) return "empty";
	if (Buffer.byteLength(trimmed, "utf8") > 255) return "tooLong";
	if (INVALID_NAME_CHARS.test(trimmed)) return "invalidChars";
	if (trimmed === "." || trimmed === ".." || WINDOWS_DEVICE_NAME.test(trimmed)) return "reserved";
	if (/[. ]$/.test(trimmed)) return "trailingDotOrSpace";
	return null;
}

/** Map a filesystem error to the folder browser's stable problem code. */
export function folderProblem(error: unknown): FolderProblem {
	const code = error instanceof Error && "code" in error ? error.code : null;
	if (code === "ENOENT" || code === "ENOTDIR") return "notFound";
	if (code === "EACCES" || code === "EPERM") return "permissionDenied";
	return "unreadable";
}

export interface InstructionCandidate {
	provider: InstructionsProvider;
	relPath: string;
	kind: "context" | "sticky";
}

/**
 * Project-root context files in omp's shadowing order (highest priority first; ties resolve
 * by provider registration order, so standalone `AGENTS.md` beats standalone `CLAUDE.md`),
 * followed by the sticky native `RULES.md`.
 */
export const INSTRUCTION_CANDIDATES: readonly InstructionCandidate[] = [
	{ provider: "native", relPath: ".omp/AGENTS.md", kind: "context" },
	{ provider: "claude", relPath: ".claude/CLAUDE.md", kind: "context" },
	{ provider: "agents", relPath: ".agent/AGENTS.md", kind: "context" },
	{ provider: "agents", relPath: ".agents/AGENTS.md", kind: "context" },
	{ provider: "gemini", relPath: ".gemini/GEMINI.md", kind: "context" },
	{ provider: "github", relPath: ".github/copilot-instructions.md", kind: "context" },
	{ provider: "agents-md", relPath: "AGENTS.md", kind: "context" },
	{ provider: "claude-md", relPath: "CLAUDE.md", kind: "context" },
	{ provider: "native", relPath: ".omp/RULES.md", kind: "sticky" },
];

/** Suggested file for new project instructions: read by omp and most other agent tools. */
export const DEFAULT_INSTRUCTIONS_REL_PATH = "AGENTS.md";

/**
 * The context file omp loads for a session started at the project root: the first candidate
 * with non-blank content. omp ignores standalone `AGENTS.md`/`CLAUDE.md` whose parent folder
 * name starts with `.` (those belong to config-directory providers).
 */
export function activeInstruction(
	files: ReadonlyArray<InstructionCandidate & { content: string | null }>,
	projectDirName: string,
): string | null {
	const dotDir = projectDirName.startsWith(".");
	for (const file of files) {
		if (file.kind !== "context" || !file.content?.trim()) continue;
		if (dotDir && (file.provider === "agents-md" || file.provider === "claude-md")) continue;
		return file.relPath;
	}
	return null;
}

export interface ParsedRule {
	description: string | null;
	globs: string[];
	alwaysApply: boolean;
	enabled: boolean;
	/** Raw `applyTo` (GitHub instructions). */
	applyTo: string | null;
	body: string;
	frontmatterError: string | null;
}

const RuleFrontmatter = z.object({
	description: z.string().optional().catch(undefined),
	globs: z
		.union([z.string().transform(value => [value]), z.array(z.unknown()).transform(items => items.filter(item => typeof item === "string"))])
		.optional()
		.catch(undefined),
	alwaysApply: z
		.unknown()
		.optional()
		.transform(value => value === true),
	enabled: z
		.unknown()
		.optional()
		.transform(value => value !== false),
	applyTo: z.string().optional().catch(undefined),
});

const FrontmatterRecord = z.record(z.string(), z.unknown());

/** Split `---\n…\n---` frontmatter off a Markdown file the way omp does. */
function splitFrontmatter(content: string): { metadata: string | null; body: string } {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---")) return { metadata: null, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { metadata: null, body: normalized };
	return { metadata: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
}

/** omp's fallback for broken YAML: `key: value` per line, each value parsed on its own. */
function lineByLineFrontmatter(metadata: string): Record<string, unknown> {
	const record: Record<string, unknown> = {};
	for (const line of metadata.split("\n")) {
		const match = /^([\w-]+):\s*(.*)$/.exec(line);
		if (!match?.[1]) continue;
		const raw = (match[2] ?? "").trim();
		let value: unknown = raw;
		try {
			const parsed: unknown = parseYaml(raw);
			if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) value = parsed;
		} catch {}
		record[match[1]] = value;
	}
	return record;
}

/** Parse a rule file's frontmatter (`description`, `globs`, `alwaysApply`, `enabled`, `applyTo`) and body. */
export function parseRuleMarkdown(content: string): ParsedRule {
	const { metadata, body } = splitFrontmatter(content);
	let record: Record<string, unknown> = {};
	let frontmatterError: string | null = null;
	if (metadata !== null) {
		try {
			const parsed = FrontmatterRecord.safeParse(parseYaml(metadata) ?? {});
			record = parsed.success ? parsed.data : {};
			if (!parsed.success) frontmatterError = "Frontmatter is not a key/value map.";
		} catch (error) {
			frontmatterError = error instanceof Error ? error.message : String(error);
			record = lineByLineFrontmatter(metadata);
		}
	}
	const fields = RuleFrontmatter.parse(record);
	return {
		description: fields.description ?? null,
		globs: fields.globs ?? [],
		alwaysApply: fields.alwaysApply,
		enabled: fields.enabled,
		applyTo: fields.applyTo ?? null,
		body,
		frontmatterError,
	};
}

/** GitHub `applyTo` patterns that mean "every file" (injected as always-apply by omp). */
export const APPLY_TO_ALL: Record<string, true> = { "*": true, "**": true, "**/*": true };

const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Rule identity from a user-typed name (`.md`/`.mdc` stripped); null when unusable as a filename. */
export function normalizeRuleName(name: string): string | null {
	const stripped = name.trim().replace(/\.(md|mdc)$/i, "");
	return RULE_NAME.test(stripped) ? stripped : null;
}

/**
 * Render a native rule file from a draft, editing the existing frontmatter in place so
 * comments and unrelated keys (condition, scope, agents, …) survive. Draft fields left
 * `undefined` keep their current value. Unparseable existing frontmatter is replaced.
 */
export function renderRuleMarkdown(existing: string | null, draft: RuleDraft): string {
	const metadata = existing === null ? null : splitFrontmatter(existing).metadata;
	let doc = parseDocument(metadata ?? "");
	if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) doc = parseDocument("");
	if (draft.description !== undefined) {
		if (draft.description?.trim()) doc.set("description", draft.description.trim());
		else doc.delete("description");
	}
	if (draft.globs !== undefined) {
		const globs = draft.globs.map(glob => glob.trim()).filter(Boolean);
		if (globs.length > 0) doc.set("globs", doc.createNode(globs));
		else doc.delete("globs");
	}
	if (draft.alwaysApply !== undefined) {
		if (draft.alwaysApply) doc.set("alwaysApply", true);
		else doc.delete("alwaysApply");
	}
	if (draft.enabled !== undefined) {
		if (draft.enabled) doc.delete("enabled");
		else doc.set("enabled", false);
	}
	const body = `${draft.body.trim()}\n`;
	const hasKeys = isMap(doc.contents) && doc.contents.items.length > 0;
	if (!hasKeys) return body;
	return `---\n${doc.toString({ lineWidth: 0 })}---\n\n${body}`;
}
