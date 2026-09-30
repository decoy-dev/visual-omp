import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteMnemopiEntry, listMnemopiEntries, readMnemopiEntry } from "./mnemopi";
import { entryId, parseEntryId } from "./paths";

/** Schema + rows of a real mnemopi project bank (see the fixture header). */
const BANK_SQL = readFileSync(join(__dirname, "fixtures", "mnemopi-bank.sql"), "utf8");
const KEY = "proj-alpha-lrqk5knk4ojc";
const TRANSCRIPT_ID = "07d6a5e06020ddfe";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vomp-mnemopi-"));
	dbPath = join(dir, "mnemopi.db");
	const db = new DatabaseSync(dbPath);
	db.exec(BANK_SQL);
	db.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const count = (table: string, where = "1"): number => {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get();
		return Number(row?.n);
	} finally {
		db.close();
	}
};

const ref = (kind: "working" | "episodic" | "fact", item: string) =>
	parseEntryId(entryId({ backend: "mnemopi", key: KEY, kind, item }));

describe("listMnemopiEntries", () => {
	it("lists working, episodic and fact rows newest first with tags", () => {
		const { entries, total } = listMnemopiEntries(dbPath, KEY, {});
		expect(total).toBe(4);
		expect(entries.map(entry => entry.kind)).toEqual(["working", "working", "fact", "episodic"]);
		expect(entries.map(entry => entry.deletable)).toEqual([true, true, false, false]);
		const transcript = entries.find(entry => entry.id.endsWith(TRANSCRIPT_ID));
		expect(transcript).toMatchObject({ title: "Episode", createdAt: Date.parse("2026-09-30T17:43:34.496Z") });
		expect(transcript?.tags).toEqual(["episode", "coding-agent-transcript", "occurred_on:2026-09-30"]);
		expect(entries.at(-1)?.tags).toEqual(["summary", "consolidation", "2026-09"]);
	});

	it("filters case-insensitively across stores and paginates", () => {
		const filtered = listMnemopiEntries(dbPath, KEY, { query: "VITEST" });
		expect(filtered.total).toBe(3);
		const page = listMnemopiEntries(dbPath, KEY, { query: "vitest", limit: 1, offset: 1 });
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]?.kind).toBe("fact");
		expect(listMnemopiEntries(dbPath, KEY, { query: "100%_" }).total).toBe(0);
	});
});

describe("readMnemopiEntry", () => {
	it("returns the full row with parsed metadata_json", () => {
		const entry = readMnemopiEntry(dbPath, ref("working", TRANSCRIPT_ID));
		expect(entry.text).toContain("[user] Please always run vitest on parser files.");
		expect(entry.metadata).toMatchObject({
			importance: 0.65,
			session_id: "sess-alpha",
			metadata: { cwd: "/tmp/vomp-mem/proj-alpha", message_count: 2, source_id: "a1" },
		});
	});

	it("renders facts as their triple", () => {
		const fact = readMnemopiEntry(dbPath, ref("fact", "fact_0001"));
		expect(fact.text).toBe("user prefers vitest for parser changes");
		expect(fact.metadata.source_memory_id).toBe(TRANSCRIPT_ID);
	});

	it("rejects missing rows", () => {
		expect(() => readMnemopiEntry(dbPath, ref("episodic", "nope"))).toThrow("Memory not found");
	});
});

describe("deleteMnemopiEntry", () => {
	it("forgets a working row with every derived artifact, like memory_edit forget", () => {
		deleteMnemopiEntry(dbPath, ref("working", TRANSCRIPT_ID));
		expect(count("working_memory", `id = '${TRANSCRIPT_ID}'`)).toBe(0);
		expect(count("fts_working", `id = '${TRANSCRIPT_ID}'`)).toBe(0);
		expect(count("facts")).toBe(0);
		expect(count("annotations", `memory_id = '${TRANSCRIPT_ID}'`)).toBe(0);
		expect(count("gists")).toBe(0);
		expect(count("graph_edges")).toBe(0);
		// Unrelated rows stay.
		expect(count("working_memory")).toBe(1);
		expect(count("annotations")).toBe(2);
		expect(count("episodic_memory")).toBe(1);
	});

	it("refuses read-only stores and missing rows without changing anything", () => {
		expect(() => deleteMnemopiEntry(dbPath, ref("episodic", "ep7a1c0ffee00001"))).toThrow();
		expect(() => deleteMnemopiEntry(dbPath, ref("fact", "fact_0001"))).toThrow();
		expect(() => deleteMnemopiEntry(dbPath, ref("working", "missing"))).toThrow("Memory not found");
		expect(count("working_memory")).toBe(2);
		expect(count("facts")).toBe(1);
	});
});
