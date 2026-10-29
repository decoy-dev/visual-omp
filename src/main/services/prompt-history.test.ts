import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readPromptHistory } from "./prompt-history";

const SESSION = "019a0000-0000-7000-8000-000000000001";
const OTHER = "019a0000-0000-7000-8000-000000000002";
const folders: string[] = [];
function fixture(schema = "CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT, created_at INTEGER, session_id TEXT)") {
	const folder = mkdtempSync(join(tmpdir(), "vomp-prompt-history-"));
	folders.push(folder);
	const file = join(folder, "history.db");
	const db = new DatabaseSync(file);
	db.exec(schema);
	return { file, db };
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe("read-only omp prompt history", () => {
	it("filters strictly by session, caps to newest 100 and returns chronological milliseconds", () => {
		const { file, db } = fixture();
		const insert = db.prepare("INSERT INTO history (prompt, created_at, session_id) VALUES (?, ?, ?)");
		for (let i = 0; i < 105; i++) insert.run(`prompt ${i}`, 1000 + i, SESSION);
		insert.run("another chat", 9999, OTHER);
		db.close();
		const before = readFileSync(file);
		const result = readPromptHistory(file, SESSION);
		expect(result).toHaveLength(100);
		expect(result[0]).toEqual({ text: "prompt 5", timestamp: 1005000 });
		expect(result.at(-1)?.text).toBe("prompt 104");
		expect(readFileSync(file)).toEqual(before);
	});

	it("rejects paths, SQL and non-UUID arguments without opening a file", () => {
		for (const id of ["../history.db", "' OR 1=1", "short", null, {}]) expect(readPromptHistory("missing.db", id)).toEqual([]);
	});

	it("tolerates missing files, old schemas and unexpected column types without migration", () => {
		expect(readPromptHistory(join(tmpdir(), "vomp-history-does-not-exist.db"), SESSION)).toEqual([]);
		for (const schema of ["CREATE TABLE old_history (prompt TEXT)", "CREATE TABLE history (id INTEGER, prompt TEXT, created_at INTEGER)", "CREATE TABLE history (id INTEGER, prompt TEXT, created_at TEXT, session_id TEXT)"]) {
			const { file, db } = fixture(schema);
			db.close();
			const before = readFileSync(file);
			expect(readPromptHistory(file, SESSION)).toEqual([]);
			expect(readFileSync(file)).toEqual(before);
		}
	});
});
