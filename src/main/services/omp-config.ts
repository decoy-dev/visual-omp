/**
 * Pure parsers and transforms for omp's settings, model and usage CLI output and for editing omp's
 * YAML config files. No Electron or process access, so everything here is unit-testable.
 */
import { Document, isMap, isScalar, parseDocument, YAMLMap } from "yaml";
import { z } from "zod";
import type {
	JsonValue,
	ModelCost,
	ModelInfo,
	ModelKind,
	RoleThinking,
	SettingSource,
	SettingType,
} from "@shared/contracts/config";

// ─── JSON helpers ──────────────────────────────────────────────────────────

export const JsonValueSchema: z.ZodType<JsonValue> = z.json();

/** Structural equality of JSON values (object key order ignored). */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
	if (a === b) return true;
	if (a === null || b === null || a === undefined || b === undefined) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => jsonEqual(item, b[index]));
	}
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}

export function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Value at `segments` inside a parsed config object; undefined when any segment is missing. */
export function getPath(root: JsonValue | undefined, segments: readonly string[]): JsonValue | undefined {
	let node = root;
	for (const segment of segments) {
		if (!isJsonObject(node) || !Object.hasOwn(node, segment)) return undefined;
		node = node[segment];
	}
	return node;
}

/** omp's layer merge: objects merge key by key, anything else (arrays included) replaces. */
export function deepMerge(base: JsonValue | undefined, over: JsonValue | undefined): JsonValue | undefined {
	if (over === undefined) return base;
	if (!isJsonObject(base) || !isJsonObject(over)) return over;
	const merged: { [key: string]: JsonValue } = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const next = deepMerge(merged[key], value);
		if (next !== undefined) merged[key] = next;
	}
	return merged;
}

// ─── `omp config list --json` ──────────────────────────────────────────────

const SettingTypeSchema = z.enum(["boolean", "string", "number", "enum", "array", "record"]);

/** One entry of `omp config list --json`: `value` is omitted when unset or redacted. */
const ConfigListEntrySchema = z.object({
	value: JsonValueSchema.optional(),
	redacted: z.literal(true).optional(),
	type: SettingTypeSchema,
	description: z.string(),
});

export const ConfigListSchema = z.record(z.string(), ConfigListEntrySchema);

export interface ListedSetting {
	key: string;
	type: SettingType;
	description: string;
	/** null when unset or redacted. */
	value: JsonValue;
	redacted: boolean;
}

export function parseConfigList(json: unknown): Map<string, ListedSetting> {
	const parsed = ConfigListSchema.parse(json);
	const out = new Map<string, ListedSetting>();
	for (const [key, entry] of Object.entries(parsed)) {
		out.set(key, {
			key,
			type: entry.type,
			description: entry.description,
			value: entry.value ?? null,
			redacted: entry.redacted === true,
		});
	}
	return out;
}

// ─── `omp read cfg://` ─────────────────────────────────────────────────────

const REDACTED_TOKEN = "<redacted>";
/** cfg:// tree comments keep the description's first sentence, capped at this many characters. */
const TREE_COMMENT_MAX_CHARS = 120;

type CfgToken = { redacted: true } | { redacted: false; value: JsonValue };

/** Parse one value as cfg:// formats it: `null`, `<redacted>`, a boolean/number, or JSON. */
function parseCfgToken(text: string): CfgToken | undefined {
	if (text === REDACTED_TOKEN) return { redacted: true };
	try {
		return { redacted: false, value: JsonValueSchema.parse(JSON.parse(text)) };
	} catch {
		return undefined;
	}
}

/** The description text cfg:// tree comments show: first sentence, truncated with an ellipsis. */
export function treeDescription(description: string): string {
	const sentence = description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? description;
	return sentence.length > TREE_COMMENT_MAX_CHARS ? `${sentence.slice(0, TREE_COMMENT_MAX_CHARS - 1)}…` : sentence;
}

export interface TreeSetting {
	enumValues: string[] | null;
	/** Schema default; null when the setting has no default. */
	defaultValue: JsonValue;
}

/**
 * Parse the YAML-ish tree `omp read cfg://` prints: `key: <value>  # [a|b|c · ][default <value> · ]<first sentence>`.
 * The default only appears when the value differs from it; otherwise the value is the default.
 * `known` (from `omp config list --json`) supplies each setting's type and full description so
 * the comment can be split without guessing. Lines that are neither settings nor namespaces (a
 * read-tool notice) are ignored; settings missing from the tree are simply absent from the result.
 */
export function parseCfgTree(text: string, known: ReadonlyMap<string, { type: SettingType; description: string }>): Map<string, TreeSetting> {
	const out = new Map<string, TreeSetting>();
	const stack: string[] = [];
	for (const line of text.split("\n")) {
		const match = /^((?: {2})*)([^\s:#][^:]*):(?: (.*))?$/.exec(line);
		if (!match) continue;
		const depth = (match[1] ?? "").length / 2;
		const name = match[2] ?? "";
		const rest = match[3];
		if (depth > stack.length) continue;
		stack.length = depth;
		if (rest === undefined) {
			stack.push(name);
			continue;
		}
		const key = [...stack, name].join(".");
		const meta = known.get(key);
		if (!meta) continue;
		const split = splitValueComment(rest);
		if (!split) continue;
		out.set(key, parseTreeComment(split.value, split.comment, meta));
	}
	return out;
}

function splitValueComment(rest: string): { value: CfgToken; comment: string } | undefined {
	const whole = parseCfgToken(rest);
	if (whole) return { value: whole, comment: "" };
	for (let index = rest.indexOf("  # "); index !== -1; index = rest.indexOf("  # ", index + 1)) {
		const value = parseCfgToken(rest.slice(0, index));
		if (value) return { value, comment: rest.slice(index + 4) };
	}
	return undefined;
}

function parseTreeComment(value: CfgToken, comment: string, meta: { type: SettingType; description: string }): TreeSetting {
	let rest = comment;
	if (meta.description) {
		const sentence = treeDescription(meta.description);
		if (rest === sentence) rest = "";
		else if (rest.endsWith(` · ${sentence}`)) rest = rest.slice(0, -(sentence.length + 3));
	}
	let enumValues: string[] | null = null;
	if (meta.type === "enum") {
		const end = rest.indexOf(" · ");
		const part = end === -1 ? rest : rest.slice(0, end);
		enumValues = part ? part.split("|") : [];
		rest = end === -1 ? "" : rest.slice(end + 3);
	}
	let defaultValue: JsonValue = value.redacted ? null : value.value;
	if (rest.startsWith("default ")) {
		const token = parseCfgToken(rest.slice("default ".length));
		defaultValue = token && !token.redacted ? token.value : null;
	}
	return { enumValues, defaultValue };
}

const SOURCE_BY_LABEL: Record<string, SettingSource> = {
	"environment variable": "env",
	"session override": "runtime",
	"--config overlay": "overlay",
	"project config": "project",
	"global config": "global",
	default: "default",
};

export interface LeafSetting {
	key: string;
	type: SettingType;
	value: JsonValue;
	redacted: boolean;
	defaultValue: JsonValue;
	source: SettingSource;
	enumValues: string[] | null;
	description: string;
}

/**
 * Parse `omp read cfg://<key>`:
 * `<key>: <value>` / `type: …` / `default: …` / `source: <label>` / [`values: [a, b]`] / [`description: …`].
 * A namespace tree may follow after a blank line (when other settings live below the key); it is ignored.
 */
export function parseCfgLeaf(text: string): LeafSetting {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const head = /^([^\s:]+): (.*)$/.exec(lines[0] ?? "");
	if (!head) throw new Error(`Unexpected cfg:// output: ${lines[0] ?? ""}`);
	const key = head[1] ?? "";
	const value = parseCfgToken(head[2] ?? "");
	if (!value) throw new Error(`Unparseable value for ${key}: ${head[2] ?? ""}`);
	const fields = new Map<string, string>();
	let index = 1;
	for (; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line === "") break;
		const field = /^(type|default|source|values|description): (.*)$/.exec(line);
		if (!field) break;
		if (field[1] === "description") {
			const tail: string[] = [field[2] ?? ""];
			while (index + 1 < lines.length && lines[index + 1] !== "") tail.push(lines[++index] ?? "");
			fields.set("description", tail.join("\n"));
			break;
		}
		fields.set(field[1] ?? "", field[2] ?? "");
	}
	const type = SettingTypeSchema.parse(fields.get("type"));
	const defaultToken = parseCfgToken(fields.get("default") ?? "null");
	const sourceLabel = fields.get("source") ?? "";
	const source = SOURCE_BY_LABEL[sourceLabel];
	if (!source) throw new Error(`Unknown setting source for ${key}: ${sourceLabel}`);
	const values = fields.get("values");
	return {
		key,
		type,
		value: value.redacted ? null : value.value,
		redacted: value.redacted,
		defaultValue: defaultToken && !defaultToken.redacted ? defaultToken.value : null,
		source,
		enumValues: values ? values.replace(/^\[|\]$/g, "").split(", ").filter(Boolean) : null,
		description: fields.get("description") ?? "",
	};
}

// ─── Value validation ──────────────────────────────────────────────────────

/** Why `value` cannot be written to a setting of this type; null when it fits (mirrors omp's `accepts`). */
export function valueProblem(type: SettingType, enumValues: readonly string[] | null, value: JsonValue): string | null {
	switch (type) {
		case "boolean":
			return typeof value === "boolean" ? null : "expected true or false";
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? null : "expected a finite number";
		case "string":
			return typeof value === "string" ? null : "expected text";
		case "enum":
			if (typeof value !== "string") return `expected one of ${(enumValues ?? []).join(", ")}`;
			return enumValues && !enumValues.includes(value) ? `expected one of ${enumValues.join(", ")}` : null;
		case "array":
			return Array.isArray(value) ? null : "expected a list";
		case "record":
			return isJsonObject(value) ? null : "expected a mapping";
	}
}

/**
 * The human message in omp's stderr. An uncaught error prints Bun's source excerpt and stack
 * around an `error: <message>` line; plain failures print just the message.
 */
export function ompErrorMessage(stderr: string, fallback: string): string {
	const lines = stderr.replace(/\r\n/g, "\n").split("\n");
	const marked = lines.find(line => line.startsWith("error: "));
	if (marked) return marked.slice("error: ".length).trim();
	return lines.map(line => line.trim()).find(line => line !== "" && !/^\d+ \|/.test(line) && !line.startsWith("at ")) ?? fallback;
}

// ─── YAML document edits ───────────────────────────────────────────────────

/**
 * Parse a config file for editing; an empty or comment-only file yields an empty mapping (its
 * comments kept). Throws on YAML errors and on a non-mapping top level, so a write can never
 * replace content it did not understand.
 */
export function parseConfigDocument(text: string): Document {
	const doc: Document = parseDocument(text);
	if (doc.errors.length > 0) throw new Error(`Invalid YAML: ${doc.errors[0]?.message ?? "parse error"}`);
	if (doc.contents === null) doc.contents = new YAMLMap();
	else if (!isMap(doc.contents)) throw new Error("Config file must contain a mapping at the top level");
	return doc;
}

/** Plain JSON view of a parsed config document (`{}` for an empty file). Throws on non-JSON YAML values. */
export function documentJson(doc: Document): { [key: string]: JsonValue } {
	const value = JsonValueSchema.parse(doc.toJS({ maxAliasCount: 100 }) ?? {});
	if (!isJsonObject(value)) throw new Error("Config file must contain a mapping at the top level");
	return value;
}

/**
 * Set `segments` to `value` in place, keeping comments and the formatting of untouched nodes.
 * Intermediate non-mapping nodes (e.g. `tools: null`) are replaced by mappings, and an empty `{}`
 * mapping that receives a key switches to block style.
 */
export function setDocumentPath(doc: Document, segments: readonly string[], value: JsonValue): void {
	let map = rootMap(doc);
	for (const segment of segments.slice(0, -1)) {
		if (map.items.length === 0) map.flow = false;
		const child = map.get(segment, true);
		if (isMap(child)) {
			map = child;
			continue;
		}
		const created = new YAMLMap();
		map.set(doc.createNode(segment), created);
		map = created;
	}
	if (map.items.length === 0) map.flow = false;
	const last = segments.at(-1);
	if (last === undefined) throw new Error("Empty setting path");
	const existing = map.get(last, true);
	if (isScalar(existing) && (value === null || typeof value !== "object")) {
		existing.value = value;
		return;
	}
	map.set(doc.createNode(last), doc.createNode(value));
}

/** Remove `segments`, then prune mappings the removal left empty. Returns whether anything was removed. */
export function deleteDocumentPath(doc: Document, segments: readonly string[]): boolean {
	const chain: YAMLMap[] = [rootMap(doc)];
	for (const segment of segments.slice(0, -1)) {
		const child = chain.at(-1)?.get(segment, true);
		if (!isMap(child)) return false;
		chain.push(child);
	}
	const last = segments.at(-1);
	const parent = chain.at(-1);
	if (last === undefined || !parent || !parent.has(last)) return false;
	parent.delete(last);
	for (let depth = chain.length - 1; depth > 0; depth--) {
		const node = chain[depth];
		const owner = chain[depth - 1];
		const key = segments[depth - 1];
		if (!node || !owner || key === undefined || node.items.length > 0 || node.commentBefore || node.comment) break;
		owner.delete(key);
	}
	return true;
}

function rootMap(doc: Document): YAMLMap {
	if (isMap(doc.contents)) return doc.contents;
	const map = new YAMLMap();
	doc.contents = map;
	return map;
}

// ─── `omp models --json` ───────────────────────────────────────────────────

const ModelKindSchema = z.enum(["chat", "tiny", "image", "tts", "stt", "search", "judge", "embedding", "rerank", "video"]);
const ThinkingEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
const TokenCostSchema = z.object({
	input: z.number(),
	output: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
});

const ModelJsonSchema = z.object({
	provider: z.string(),
	/** Unknown future kinds are kept out of the typed union rather than failing the whole list. */
	kind: z.string(),
	id: z.string(),
	selector: z.string(),
	name: z.string(),
	contextWindow: z.number().nullable(),
	maxTokens: z.number().nullable(),
	reasoning: z.boolean(),
	thinking: z.array(z.string()).nullable(),
	input: z.array(z.string()),
	cost: TokenCostSchema.extend({
		longContext: TokenCostSchema.extend({ inputThreshold: z.number() }).optional(),
	}).nullish(),
});

export const ModelsJsonSchema = z.object({ models: z.array(ModelJsonSchema) });

/** `omp models --json`; models of kinds this app does not know are dropped. */
export function parseModels(json: unknown): ModelInfo[] {
	const out: ModelInfo[] = [];
	for (const model of ModelsJsonSchema.parse(json).models) {
		const kind = ModelKindSchema.safeParse(model.kind);
		if (!kind.success) continue;
		const cost: ModelCost | null = model.cost
			? {
					input: model.cost.input,
					output: model.cost.output,
					cacheRead: model.cost.cacheRead,
					cacheWrite: model.cost.cacheWrite,
					longContext: model.cost.longContext ?? null,
				}
			: null;
		out.push({
			selector: model.selector,
			provider: model.provider,
			id: model.id,
			name: model.name,
			kind: kind.data,
			contextWindow: model.contextWindow,
			maxOutputTokens: model.maxTokens,
			reasoning: model.reasoning,
			thinkingLevels: (model.thinking ?? []).flatMap(level => {
				const parsed = ThinkingEffortSchema.safeParse(level);
				return parsed.success ? [parsed.data] : [];
			}),
			vision: model.input.includes("image"),
			cost,
		});
	}
	return out;
}

// ─── Role values ───────────────────────────────────────────────────────────

const ROLE_THINKING: readonly RoleThinking[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

function isRoleThinking(value: string): value is RoleThinking {
	return ROLE_THINKING.some(level => level === value);
}

/**
 * Split a stored role value (`provider/model:high`) into model and thinking suffix, like omp's
 * `splitThinkingSuffix`. A value that is itself a known model selector stays literal, because real
 * model ids can end in `:max` (e.g. `glm-4.7:max`).
 */
export function splitRoleValue(value: string, literalSelectors?: ReadonlySet<string>): { model: string; thinking: RoleThinking | null } {
	if (literalSelectors?.has(value)) return { model: value, thinking: null };
	const colon = value.lastIndexOf(":");
	if (colon <= 0) return { model: value, thinking: null };
	const suffix = value.slice(colon + 1);
	return isRoleThinking(suffix) ? { model: value.slice(0, colon), thinking: suffix } : { model: value, thinking: null };
}

export function formatRoleValue(model: string, thinking: RoleThinking | null | undefined): string {
	return thinking ? `${model}:${thinking}` : model;
}

/** omp's role and preset name rule: a letter, then letters, digits, `-` or `_`. */
export const ROLE_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;

/** Accepted catalog kinds per built-in role (omp `MODEL_ROLES[role].accepts`). */
export const ROLE_KINDS: Record<string, ModelKind[]> = {
	tiny: ["tiny", "chat"],
	memory: ["tiny", "chat"],
	image: ["image"],
	web: ["search", "chat"],
	speech: ["tts"],
	dictation: ["stt"],
	judge: ["judge", "tiny", "chat"],
};

// ─── `omp usage --json` ────────────────────────────────────────────────────

const OptionalText = z.string().nullish();
const UsageMetadataSchema = z
	.object({ email: OptionalText, accountId: OptionalText, orgName: OptionalText })
	.loose();

export const UsageJsonSchema = z.object({
	reports: z.array(z.object({ provider: z.string(), metadata: UsageMetadataSchema.optional() }).loose()),
	accountsWithoutUsage: z.array(
		z.object({ provider: z.string(), email: OptionalText, accountId: OptionalText, orgName: OptionalText }).loose(),
	),
	disabledCredentials: z.array(
		z
			.object({
				provider: z.string(),
				email: OptionalText,
				accountId: OptionalText,
				cause: z.string(),
				disabledAtMs: z.number().nullish(),
			})
			.loose(),
	),
});
