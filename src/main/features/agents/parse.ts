/**
 * Pure agent-markdown handling mirroring omp's `parseFrontmatter` (packages/utils/src/frontmatter.ts)
 * and `parseAgentFields` (packages/coding-agent/src/discovery/helpers.ts), plus comment-preserving
 * frontmatter edits for the agents hub.
 */
import YAML, { isMap } from "yaml";
import { z } from "zod";
import {
	AGENT_BUILTIN_TOOLS,
	AGENT_RESERVED_NAMES,
	AGENT_THINKING_LEVELS,
	type AgentCreateDraft,
	type AgentDraft,
	type AgentFields,
	type AgentValidation,
} from "@shared/contracts/agents";

const FrontmatterRecord = z.record(z.string(), z.unknown());
const JsonData = z.json();
const ThinkingLevel = z.enum(AGENT_THINKING_LEVELS);

/** omp `parseArrayOrCSV`: string arrays keep their string items, strings split on commas. */
const StringListOrCsv = z.union([
	z.array(z.unknown()).transform(items => items.filter((item): item is string => typeof item === "string")),
	z.string().transform(text => text.split(",").map(part => part.trim()).filter(Boolean)),
]);

/** omp `parseBoolean`: booleans and case-insensitive "true"/"false" strings. */
const LooseBoolean = z.union([
	z.boolean(),
	z
		.string()
		.transform(text => text.trim().toLowerCase())
		.pipe(z.enum(["true", "false"]))
		.transform(text => text === "true"),
]);

/** omp `normalizeToolName`: built-in/hidden tool ids are case-insensitive; `search` is a legacy alias of `grep`. */
const CANONICAL_TOOLS: Record<string, string> = {
	...Object.fromEntries([...AGENT_BUILTIN_TOOLS, "yield", "goal", "think"].map(tool => [tool, tool])),
	search: "grep",
};

function stringList(value: unknown): string[] | undefined {
	const parsed = StringListOrCsv.safeParse(value);
	return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}

function looseBoolean(value: unknown): boolean | undefined {
	const parsed = LooseBoolean.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function normalizeKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeKeys);
	const record = FrontmatterRecord.safeParse(value);
	if (!record.success) return value;
	return Object.fromEntries(
		Object.entries(record.data).map(([key, item]) => [
			key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase()),
			normalizeKeys(item),
		]),
	);
}

/** Split `---` frontmatter from the body exactly like omp (after CRLF + HTML comment normalization). */
export function splitFrontmatter(content: string): { metadata: string | null; body: string } {
	const normalized = content.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
	if (!normalized.startsWith("---")) return { metadata: null, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { metadata: null, body: normalized };
	return { metadata: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
}

function parseYamlRecord(metadata: string): Record<string, unknown> | null {
	const doc = YAML.parseDocument(metadata);
	if (doc.errors.length > 0) throw doc.errors[0];
	const record = FrontmatterRecord.safeParse(doc.toJS());
	return record.success ? record.data : null;
}

/** omp's repair step: quote plain scalars containing `: ` that YAML would reject. */
function quoteAmbiguousPlainScalars(metadata: string): string | undefined {
	let changed = false;
	const lines = metadata.split("\n").map(line => {
		const match = line.match(/^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/);
		if (!match) return line;
		const [, prefix = "", rawValue = "", suffix = ""] = match;
		const value = rawValue.trimEnd();
		if (!value.includes(": ") || /^["'[{|>!&*#]/.test(value)) return line;
		changed = true;
		return `${prefix}${JSON.stringify(value)}${suffix}`;
	});
	return changed ? lines.join("\n") : undefined;
}

/** Line-by-line `key: value` fallback omp uses when the YAML block does not parse. */
function parseSimpleKeyValues(metadata: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const line of metadata.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match?.[1]) continue;
		const raw = (match[2] ?? "").trim();
		let value: unknown = raw;
		if (raw.length > 0) {
			try {
				const parsed: unknown = YAML.parse(raw);
				if ((parsed !== null && typeof parsed !== "object") || Array.isArray(parsed)) value = parsed;
			} catch {
				// Not YAML on its own: omp keeps the raw string.
			}
		}
		out[match[1]] = value;
	}
	return out;
}

/** Frontmatter as omp sees it (camelCase keys), with the warnings omp would log. */
export function readFrontmatter(metadata: string | null): { frontmatter: Record<string, unknown>; warnings: string[] } {
	if (metadata === null) return { frontmatter: {}, warnings: [] };
	const finish = (record: Record<string, unknown> | null, warnings: string[] = []) => ({
		frontmatter: FrontmatterRecord.parse(normalizeKeys(record ?? {})),
		warnings,
	});
	try {
		return finish(parseYamlRecord(metadata.replaceAll("\t", "  ")));
	} catch (error) {
		const quoted = quoteAmbiguousPlainScalars(metadata);
		if (quoted) {
			try {
				return finish(parseYamlRecord(quoted.replaceAll("\t", "  ")));
			} catch {
				// Fall through to the simple key/value parser, like omp.
			}
		}
		const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
		return finish(parseSimpleKeyValues(metadata), [
			`Frontmatter is not valid YAML (${message}); omp falls back to simple "key: value" lines.`,
		]);
	}
}

/** omp `parseAgentFields`; returns the rejection reason instead of null. */
export function parseAgentFields(
	frontmatter: Record<string, unknown>,
	warnings: string[] = [],
): { ok: true; fields: AgentFields } | { ok: false; error: string } {
	const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!name) return { ok: false, error: "Missing required frontmatter field `name`." };
	if (!description) return { ok: false, error: "Missing required frontmatter field `description`." };
	const reserved: readonly string[] = AGENT_RESERVED_NAMES;
	if (reserved.includes(name.trim().toLowerCase())) {
		return { ok: false, error: `The agent name "${name}" is reserved by omp.` };
	}

	const fields: AgentFields = { name, description };

	let tools =
		Array.isArray(frontmatter.tools) && frontmatter.tools.length === 0 ? [] : stringList(frontmatter.tools);
	if (tools) {
		tools = [...new Set(tools.map(tool => CANONICAL_TOOLS[tool.toLowerCase()] ?? tool))];
		if (!tools.includes("yield")) tools.push("yield");
		fields.tools = tools;
	}

	const rawSpawns = typeof frontmatter.spawns === "string" ? frontmatter.spawns.trim() : frontmatter.spawns;
	const spawns = rawSpawns === "*" ? "*" : stringList(rawSpawns);
	if (spawns !== undefined) fields.spawns = spawns;
	else if (tools?.includes("task")) fields.spawns = "*";

	const model = stringList(frontmatter.model)
		?.map(entry => entry.trim())
		.filter(Boolean);
	if (model && model.length > 0) fields.model = model;

	const rawThinking =
		typeof frontmatter.thinkingLevel === "string"
			? frontmatter.thinkingLevel
			: typeof frontmatter.thinking === "string"
				? frontmatter.thinking
				: undefined;
	if (rawThinking !== undefined) {
		const level = ThinkingLevel.safeParse(rawThinking);
		if (level.success) fields.thinkingLevel = level.data;
		else warnings.push(`Unknown thinking level "${rawThinking}" is ignored by omp.`);
	}

	if (frontmatter.output !== undefined) {
		const output = JsonData.safeParse(frontmatter.output);
		if (output.success) fields.output = output.data;
		else warnings.push("`output` is not plain JSON data.");
	}

	const blocking = looseBoolean(frontmatter.blocking);
	if (blocking !== undefined) fields.blocking = blocking;
	const readSummarize = looseBoolean(frontmatter.readSummarize);
	if (readSummarize !== undefined) fields.readSummarize = readSummarize;

	for (const key of ["prewalk", "advisor"] as const) {
		const raw = frontmatter[key];
		const flag = looseBoolean(raw);
		if (flag !== undefined) fields[key] = flag;
		else if (typeof raw === "string" && raw.trim()) fields[key] = raw.trim();
	}

	const skills = stringList(frontmatter.autoloadSkills)
		?.map(skill => skill.trim())
		.filter(Boolean);
	if (skills) fields.autoloadSkills = skills;

	return { ok: true, fields };
}

/** Parse a whole agent markdown file the way omp's task discovery does. */
export function parseAgentMarkdown(content: string): AgentValidation {
	const { metadata, body } = splitFrontmatter(content);
	const { frontmatter, warnings } = readFrontmatter(metadata);
	if (metadata === null) warnings.push("No `---` frontmatter block found.");
	const result = parseAgentFields(frontmatter, warnings);
	if (!result.ok) return { ok: false, error: result.error, warnings };
	return { ok: true, fields: result.fields, systemPrompt: body, warnings };
}

// ---------------------------------------------------------------------------------------------
// Writing

type DraftField = Exclude<keyof AgentDraft, "systemPrompt">;

/** Key written for new frontmatter entries, followed by aliases omp also reads for the field. */
const FIELD_KEYS: Record<DraftField, readonly string[]> = {
	name: ["name"],
	description: ["description"],
	tools: ["tools"],
	spawns: ["spawns"],
	model: ["model"],
	thinkingLevel: ["thinking-level", "thinkingLevel", "thinking"],
	output: ["output"],
	blocking: ["blocking"],
	autoloadSkills: ["autoload-skills", "autoloadSkills"],
	readSummarize: ["read-summarize", "readSummarize"],
	prewalk: ["prewalk"],
	advisor: ["advisor"],
};
const DRAFT_FIELDS = Object.keys(FIELD_KEYS) as DraftField[];

function applyFields(doc: YAML.Document, draft: AgentDraft): void {
	if (!isMap(doc.contents)) doc.contents = doc.createNode({});
	for (const field of DRAFT_FIELDS) {
		const value = draft[field];
		if (value === undefined) continue;
		const keys = FIELD_KEYS[field];
		const existing = keys.find(key => doc.has(key));
		for (const key of keys) if (key !== existing) doc.delete(key);
		if (value === null) {
			if (existing) doc.delete(existing);
			continue;
		}
		// Short lists read best inline: `tools: [read, grep]`.
		const node = Array.isArray(value) && field !== "output" ? doc.createNode(value, { flow: true }) : doc.createNode(value);
		doc.set(existing ?? keys[0], node);
	}
}

function joinAgent(frontmatter: string, body: string): string {
	return `---\n${frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`}---\n\n${body.trim()}\n`;
}

/** Markdown for a new agent file. */
export function serializeAgent(draft: AgentCreateDraft): string {
	const doc = new YAML.Document({});
	applyFields(doc, draft);
	return joinAgent(doc.toString({ lineWidth: 0 }), draft.systemPrompt);
}

/**
 * Apply a structured edit to existing agent markdown, preserving comments, key order and unknown
 * keys. Unparseable frontmatter is rebuilt from what omp's fallback parser recovered.
 */
export function applyAgentDraft(content: string, draft: AgentDraft): string {
	const text = content.replace(/\r\n?/g, "\n");
	const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
	const metadata = end === -1 ? null : text.slice(4, end);
	const rest = end === -1 ? text : text.slice(text.indexOf("\n", end + 4) + 1 || text.length);
	const body = draft.systemPrompt ?? rest;

	let doc = new YAML.Document({});
	if (metadata !== null) {
		const parsed = YAML.parseDocument(metadata);
		doc = parsed.errors.length === 0 ? parsed : new YAML.Document(readFrontmatter(metadata).frontmatter);
	}
	applyFields(doc, draft);
	return joinAgent(doc.toString({ lineWidth: 0 }), body);
}

/** File name omp users would pick for an agent: the name with path-unsafe characters replaced. */
export function agentFileName(name: string): string {
	const slug = name
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[-.]+|-+$/g, "");
	return `${slug || "agent"}.md`;
}

