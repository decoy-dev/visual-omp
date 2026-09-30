import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
	JsonValue,
	MemoryEntry,
	MemoryEntrySummary,
	MemoryListOptions,
	MemoryListResult,
	MemoryScope,
} from "@shared/contracts/memory";
import { pathExists } from "../../files";
import { DEFAULT_LIST_LIMIT, mtimeMs, parseTimestamp, preview } from "./common";
import { type EntryRef, entryId, MNEMOPI_SHARED_KEY, mnemopiProjectBank, scopeId } from "./paths";

/**
 * `mnemopi` backend: SQLite banks read with `node:sqlite`. Working-memory rows are deletable with the
 * same cleanup as mnemopi's `forgetWorking` (the `memory_edit forget` tool); episodic rows and facts
 * have no forget path in omp and stay read-only.
 */

type MnemopiStore = "working" | "episodic" | "fact";

/** Tables whose rows point back to a working-memory id via `source_memory_id` (mnemopi's MEMORIA_SOURCE_TABLES). */
const MEMORIA_SOURCE_TABLES = [
	"memoria_facts",
	"memoria_instructions",
	"memoria_kg",
	"memoria_preferences",
	"memoria_timelines",
];
/** Busy timeout matching omp's own connections, so a delete waits out an in-flight omp write. */
const BUSY_TIMEOUT_MS = 5000;

/** Database file of a bank scope key. */
export function mnemopiBankPath(dbPath: string, key: string): string {
	return key === MNEMOPI_SHARED_KEY ? dbPath : join(dirname(dbPath), "banks", key, "mnemopi.db");
}

function openReadOnly(path: string): DatabaseSync {
	return new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

function withDb<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

const NameRow = z.object({ name: z.string() });

function tableNames(db: DatabaseSync): Set<string> {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
	return new Set(z.array(NameRow).parse(rows).map(row => row.name));
}

const LIKE_ESCAPE = "\\";

/** Per-store SELECT producing the common list projection, filtered by `content LIKE ?`. */
function storeSelects(tables: Set<string>): string[] {
	const selects: string[] = [];
	for (const [store, table] of [
		["working", "working_memory"],
		["episodic", "episodic_memory"],
	] as const) {
		if (!tables.has(table)) continue;
		selects.push(`SELECT '${store}' AS store, id, substr(content, 1, 600) AS head, length(content) AS len,
			COALESCE(timestamp, created_at) AS ts, memory_type, source, temporal_tags
			FROM ${table} WHERE content LIKE ? ESCAPE '${LIKE_ESCAPE}'`);
	}
	if (tables.has("facts")) {
		const triple = "subject || ' ' || predicate || ' ' || object";
		selects.push(`SELECT 'fact' AS store, fact_id AS id, substr(${triple}, 1, 600) AS head, length(${triple}) AS len,
			COALESCE(timestamp, created_at) AS ts, 'fact' AS memory_type, 'facts' AS source, NULL AS temporal_tags
			FROM facts WHERE ${triple} LIKE ? ESCAPE '${LIKE_ESCAPE}'`);
	}
	return selects;
}

const ListRow = z.object({
	store: z.enum(["working", "episodic", "fact"]),
	id: z.string(),
	head: z.string(),
	len: z.number(),
	ts: z.union([z.string(), z.number()]).nullable(),
	memory_type: z.string().nullable(),
	source: z.string().nullable(),
	temporal_tags: z.string().nullable(),
});
const CountRow = z.object({ total: z.number() });
const AnnotationRow = z.object({ memory_id: z.string(), kind: z.string(), value: z.string() });
const StringArray = z.array(z.string());

/** Parse a JSON column, returning undefined for null/invalid JSON or a shape mismatch. */
function parseJsonColumn<T>(text: string | null | undefined, schema: z.ZodType<T>): T | undefined {
	if (!text) return undefined;
	try {
		const parsed = schema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function likePattern(query: string | undefined): string {
	const trimmed = query?.trim();
	return trimmed ? `%${trimmed.replace(/[\\%_]/g, char => `${LIKE_ESCAPE}${char}`)}%` : "%";
}

function annotationTags(db: DatabaseSync, tables: Set<string>, ids: string[]): Map<string, string[]> {
	const byId = new Map<string, string[]>();
	if (!tables.has("annotations") || ids.length === 0) return byId;
	const placeholders = ids.map(() => "?").join(", ");
	const rows = db
		.prepare(`SELECT memory_id, kind, value FROM annotations WHERE memory_id IN (${placeholders}) ORDER BY id`)
		.all(...ids);
	for (const row of z.array(AnnotationRow).parse(rows)) {
		// `has_source` repeats the row's source column, which is already a tag.
		if (row.kind === "has_source") continue;
		const tags = byId.get(row.memory_id) ?? [];
		tags.push(`${row.kind}:${row.value}`);
		byId.set(row.memory_id, tags);
	}
	return byId;
}

function baseTags(row: { memory_type?: string | null; source?: string | null; temporal_tags?: string | null }): string[] {
	const tags: string[] = [];
	if (row.memory_type && row.memory_type !== "unknown") tags.push(row.memory_type);
	if (row.source) tags.push(row.source);
	tags.push(...(parseJsonColumn(row.temporal_tags, StringArray) ?? []));
	return tags;
}

function summaryFields(key: string, path: string, store: MnemopiStore, id: string) {
	const ref: EntryRef = { backend: "mnemopi", key, kind: store, item: id };
	return {
		id: entryId(ref),
		scopeId: scopeId(ref),
		backend: "mnemopi" as const,
		kind: store,
		path,
		deletable: store === "working",
	};
}

function title(store: MnemopiStore, memoryType: string | null | undefined): string {
	if (store === "fact") return "Fact";
	const label = memoryType && memoryType !== "unknown" ? memoryType : store;
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/** One page of a bank's working, episodic and fact rows, newest first. */
export function listMnemopiEntries(path: string, key: string, options: MemoryListOptions): MemoryListResult {
	return withDb(openReadOnly(path), db => {
		const tables = tableNames(db);
		const selects = storeSelects(tables);
		if (selects.length === 0) return { entries: [], total: 0 };
		const pattern = likePattern(options.query);
		const params = selects.map(() => pattern);
		const union = selects.join(" UNION ALL ");
		const { total } = CountRow.parse(db.prepare(`SELECT COUNT(*) AS total FROM (${union})`).get(...params));
		const limit = Math.max(0, options.limit ?? DEFAULT_LIST_LIMIT);
		const offset = Math.max(0, options.offset ?? 0);
		const rows = z
			.array(ListRow)
			.parse(
				db
					.prepare(`SELECT * FROM (${union}) ORDER BY julianday(ts) DESC NULLS LAST, id LIMIT ? OFFSET ?`)
					.all(...params, limit, offset),
			);
		const annotations = annotationTags(db, tables, rows.map(row => row.id));
		const entries = rows.map(
			(row): MemoryEntrySummary => ({
				...summaryFields(key, path, row.store, row.id),
				title: title(row.store, row.memory_type),
				preview: preview(row.head),
				length: row.len,
				createdAt: parseTimestamp(row.ts),
				updatedAt: null,
				tags: [...baseTags(row), ...(annotations.get(row.id) ?? [])],
			}),
		);
		return { entries, total };
	});
}

/** SQLite TIMESTAMP columns hold text in practice but have NUMERIC affinity. */
const Nullish = {
	string: z.string().nullish(),
	number: z.number().nullish(),
	time: z.union([z.string(), z.number()]).nullish(),
};
const MemoryRow = z.object({
	id: z.string(),
	content: z.string(),
	source: Nullish.string,
	timestamp: Nullish.string,
	session_id: Nullish.string,
	importance: Nullish.number,
	metadata_json: Nullish.string,
	veracity: Nullish.string,
	memory_type: Nullish.string,
	created_at: Nullish.time,
	scope: Nullish.string,
	recall_count: Nullish.number,
	last_recalled: Nullish.time,
	valid_until: Nullish.time,
	superseded_by: Nullish.string,
	trust_tier: Nullish.string,
	consolidated_at: Nullish.time,
	temporal_tags: Nullish.string,
	summary_of: Nullish.string,
	tier: Nullish.number,
	event_date: Nullish.time,
});
const FactRow = z.object({
	fact_id: z.string(),
	session_id: Nullish.string,
	subject: z.string(),
	predicate: z.string(),
	object: z.string(),
	timestamp: Nullish.string,
	source_msg_id: Nullish.string,
	confidence: Nullish.number,
	created_at: Nullish.time,
	scope: Nullish.string,
});

/** Non-null scalar columns copied into `metadata`, in display order. */
const MEMORY_METADATA_COLUMNS = [
	"source",
	"session_id",
	"importance",
	"veracity",
	"memory_type",
	"scope",
	"trust_tier",
	"recall_count",
	"last_recalled",
	"valid_until",
	"superseded_by",
	"consolidated_at",
	"summary_of",
	"tier",
	"event_date",
] as const;

function readRow(db: DatabaseSync, store: MnemopiStore, id: string): unknown {
	const table = store === "working" ? "working_memory" : store === "episodic" ? "episodic_memory" : "facts";
	const column = store === "fact" ? "fact_id" : "id";
	if (!tableNames(db).has(table)) return undefined;
	return db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(id);
}

/** Full row of one working/episodic memory or fact. */
export function readMnemopiEntry(path: string, ref: EntryRef): MemoryEntry {
	const store = z.enum(["working", "episodic", "fact"]).parse(ref.kind);
	return withDb(openReadOnly(path), db => {
		const raw = readRow(db, store, ref.item);
		if (raw === undefined) throw new Error("Memory not found");
		const tables = tableNames(db);
		const annotations = annotationTags(db, tables, [ref.item]).get(ref.item) ?? [];
		const fields = summaryFields(ref.key, path, store, ref.item);
		if (store === "fact") {
			const row = FactRow.parse(raw);
			const text = [row.subject, row.predicate, row.object].filter(Boolean).join(" ");
			const metadata: Record<string, JsonValue> = { subject: row.subject, predicate: row.predicate, object: row.object };
			if (row.confidence != null) metadata.confidence = row.confidence;
			if (row.session_id) metadata.session_id = row.session_id;
			if (row.source_msg_id) metadata.source_memory_id = row.source_msg_id;
			if (row.scope) metadata.scope = row.scope;
			return {
				...fields,
				title: "Fact",
				text,
				preview: preview(text),
				length: text.length,
				createdAt: parseTimestamp(row.timestamp ?? row.created_at),
				updatedAt: null,
				tags: ["fact", ...annotations],
				metadata,
			};
		}
		const row = MemoryRow.parse(raw);
		const metadata: Record<string, JsonValue> = {};
		for (const column of MEMORY_METADATA_COLUMNS) {
			const value = row[column];
			if (value !== null && value !== undefined) metadata[column] = value;
		}
		const parsedMetadata = parseJsonColumn(row.metadata_json, z.json());
		if (parsedMetadata !== undefined) metadata.metadata = parsedMetadata;
		return {
			...fields,
			title: title(store, row.memory_type),
			text: row.content,
			preview: preview(row.content),
			length: row.content.length,
			createdAt: parseTimestamp(row.timestamp ?? row.created_at),
			updatedAt: null,
			tags: [...baseTags(row), ...annotations],
			metadata,
		};
	});
}

/**
 * Forget one working-memory row and its derived artifacts in one transaction — facts extracted from
 * it, annotations, embeddings, memoria projections, episodic gists and graph edges — mirroring
 * mnemopi's `forgetWorking` + `purgeWorkingMemoryArtifacts`. FTS rows go through the table's triggers.
 */
export function deleteMnemopiEntry(path: string, ref: EntryRef): void {
	if (ref.kind !== "working") {
		throw new Error(`mnemopi ${ref.kind} rows have no forget path in omp and are read-only`);
	}
	const id = ref.item;
	withDb(new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS }), db => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const { changes } = db.prepare("DELETE FROM working_memory WHERE id = ?").run(id);
			if (Number(changes) === 0) throw new Error("Memory not found");
			const tables = tableNames(db);
			const graphRefs = [id, `gist_${id}`];
			if (tables.has("facts")) {
				const factIds = z.array(z.object({ fact_id: z.string() })).parse(
					db.prepare("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id),
				);
				graphRefs.push(...factIds.map(row => row.fact_id));
				db.prepare("DELETE FROM facts WHERE source_msg_id = ?").run(id);
			}
			if (tables.has("annotations")) db.prepare("DELETE FROM annotations WHERE memory_id = ?").run(id);
			if (tables.has("memory_embeddings")) db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
			for (const table of MEMORIA_SOURCE_TABLES) {
				if (tables.has(table)) db.prepare(`DELETE FROM ${table} WHERE source_memory_id = ?`).run(id);
			}
			if (tables.has("gists")) db.prepare("DELETE FROM gists WHERE memory_id = ?").run(id);
			if (tables.has("graph_edges")) {
				const placeholders = graphRefs.map(() => "?").join(", ");
				db.prepare(`DELETE FROM graph_edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`).run(
					...graphRefs,
					...graphRefs,
				);
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

interface BankSummary {
	entryCount: number;
	updatedAt: number | null;
	/** Distinct `metadata_json.$.cwd` values of the bank's working/episodic rows. */
	cwds: string[];
}

const CwdRow = z.object({ cwd: z.string().nullable() });
/** `latest` is a Julian day number (SQLite `julianday`). */
const BankStatsRow = z.object({ total: z.number(), latest: z.number().nullable() });
const JULIAN_UNIX_EPOCH = 2440587.5;

function summarizeBank(path: string): BankSummary {
	return withDb(openReadOnly(path), db => {
		const tables = tableNames(db);
		const selects = storeSelects(tables);
		if (selects.length === 0) return { entryCount: 0, updatedAt: null, cwds: [] };
		const union = selects.join(" UNION ALL ");
		const stats = BankStatsRow.parse(
			db
				.prepare(`SELECT COUNT(*) AS total, MAX(julianday(ts)) AS latest FROM (${union})`)
				.get(...selects.map(() => "%")),
		);
		const cwdSelects = ["working_memory", "episodic_memory"]
			.filter(table => tables.has(table))
			.map(table => `SELECT json_extract(metadata_json, '$.cwd') AS cwd FROM ${table}`);
		const cwds =
			cwdSelects.length === 0
				? []
				: z
						.array(CwdRow)
						.parse(db.prepare(`SELECT DISTINCT cwd FROM (${cwdSelects.join(" UNION ALL ")})`).all())
						.map(row => row.cwd);
		return {
			entryCount: stats.total,
			updatedAt: stats.latest === null ? null : Math.round((stats.latest - JULIAN_UNIX_EPOCH) * 86_400_000),
			cwds: cwds.includes(null) ? [] : cwds.filter(cwd => cwd !== null),
		};
	});
}

export interface MnemopiScopeOptions {
	/** Resolved `mnemopi.dbPath`. */
	dbPath: string;
	/** `mnemopi.bank` base name. */
	bank: string | null;
	knownCwds: readonly string[];
	active: boolean;
}

/** Every bank database: the shared one at `dbPath` and each `banks/<name>/mnemopi.db` beside it. */
export async function mnemopiScopes(options: MnemopiScopeOptions): Promise<MemoryScope[]> {
	const { dbPath, bank, knownCwds, active } = options;
	const byBank = new Map(knownCwds.map(cwd => [mnemopiProjectBank(bank, cwd), cwd]));
	const keys: string[] = [];
	if (await pathExists(dbPath)) keys.push(MNEMOPI_SHARED_KEY);
	const banksDir = join(dirname(dbPath), "banks");
	for (const entry of await readdir(banksDir, { withFileTypes: true }).catch(() => [])) {
		if (entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)) {
			if (await pathExists(mnemopiBankPath(dbPath, entry.name))) keys.push(entry.name);
		}
	}
	const scopes: MemoryScope[] = [];
	for (const key of keys) {
		const path = mnemopiBankPath(dbPath, key);
		const summary = summarizeBank(path);
		const global = key === MNEMOPI_SHARED_KEY;
		// A bank belongs to a project when its name is that project's derived bank, or when every row
		// was retained from the same cwd (banks from older, differently derived bank names).
		const cwd = global ? null : (byBank.get(key) ?? (summary.cwds.length === 1 ? (summary.cwds[0] ?? null) : null));
		scopes.push({
			id: scopeId({ backend: "mnemopi", key }),
			backend: "mnemopi",
			active,
			name: global ? "Shared bank" : cwd ? basename(cwd) || cwd : key,
			cwd,
			global,
			path,
			exists: true,
			entryCount: summary.entryCount,
			updatedAt: summary.updatedAt ?? (await mtimeMs(path)),
		});
	}
	return scopes;
}
