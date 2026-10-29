import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crashedWithoutExit, parseProgramStatus, readSessionRecaps, startupModelWarning, startupModelWarnings, worktreeConfirmation } from "./host-observations";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vomp-host-observations-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("OSC 7501", () => {
	it("reads root blocked and error messages as UTF-8", () => {
		const msg = Buffer.from("Approve this command? ✓").toString("base64");
		expect(parseProgramStatus(`state=blocked:kind=permission:app=omp:msg=${msg}`)).toEqual({ state: "blocked", kind: "permission", msg: "Approve this command? ✓" });
		expect(parseProgramStatus(`state=error:app=omp:msg=${msg}`)?.state).toBe("error");
		expect(parseProgramStatus("state=clear")).toBeNull();
	});
	it("ignores foreign, child, malformed and control-bearing records", () => {
		for (const body of ["state=blocked:app=omp", "state=idle:app=other", "state=clear:app=other", "state=clear:state=idle", "state=clear:broken", "state=error:app=omp:id=child", "state=error:app=omp:msg=??", `state=error:app=omp:msg=${Buffer.from("unsafe\nline").toString("base64")}`, "state=error:app=omp:msg=/w=="]) {
			expect(parseProgramStatus(body)).toBeUndefined();
		}
	});
});

describe("crash recovery", () => {
	it("offers restore after a later resumed process crashes despite an older exit marker", async () => {
		const file = join(root, "chat.jsonl");
		await writeFile(file, [JSON.stringify({ type: "session", id: "s" }), JSON.stringify({ type: "custom", customType: "session_exit", data: { recordedAt: new Date(1000).toISOString() } }), JSON.stringify({ type: "message" })].join("\n"));
		expect(await crashedWithoutExit(file, 2000)).toBe(true);
		expect(await crashedWithoutExit(file, 500)).toBe(false);
	});
	it("retains crash recovery when a partial final write has no exit record", async () => {
		const file = join(root, "partial.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "session", id: "s" })}\n{\"type\":\"message\",`);
		expect(await crashedWithoutExit(file, 1)).toBe(true);
	});
	it("does not offer restore without a readable session", async () => {
		expect(await crashedWithoutExit(null, 1)).toBe(false);
		expect(await crashedWithoutExit(join(root, "missing"), 1)).toBe(false);
		const file = join(root, "broken"); await writeFile(file, "not json");
		expect(await crashedWithoutExit(file, 1)).toBe(false);
	});
});

it("reads only this session's recap journal without modifying its database", () => {
	const file = join(root, "history.db");
	const db = new DatabaseSync(file);
	db.exec("CREATE TABLE session_recaps(id INTEGER PRIMARY KEY, session_id TEXT, recap TEXT, created_at INTEGER)");
	db.prepare("INSERT INTO session_recaps VALUES(?,?,?,?)").run(1, "s", "Continue with the next change.", 20);
	db.prepare("INSERT INTO session_recaps VALUES(?,?,?,?)").run(2, "other", "Private other session.", 21);
	db.close();
	expect(readSessionRecaps(file, "s")).toEqual([{ id: "recap:s:1", kind: "recap", text: "Continue with the next change.", timestamp: 20000 }]);
	expect(readSessionRecaps(join(root, "missing"), "s")).toBeNull();
});

it("captures startup substitutions, excluding arbitrary text and drafts", () => {
	expect(startupModelWarning("Warning: Default model provider/missing not found. Using provider/available")).toBe("Default model provider/missing not found. Using provider/available");
	expect(startupModelWarning("Warning: Dictation model provider/missing not found; using the built-in local model")).toContain("Dictation model");
	expect(startupModelWarning("│ Default model private draft │")).toBeNull();
	expect(startupModelWarning("ordinary model output")).toBeNull();
});

it("retains omp's worktree risk text and current confirmation selection", () => {
	const lines = ["╭─ Remove worktree? ─────────╮", "│                           │", "│ /work/tree (wt/test): has uncommitted changes │", "│                           │", "│  ❯ Yes                    │", "│    No                     │", "│                           │", "│ ↑/↓ navigate ⏎ select ⎋ cancel │", "╰───────────────────────────╯"];
	expect(worktreeConfirmation(lines)).toEqual({ title: "Remove worktree?", detail: "/work/tree (wt/test): has uncommitted changes", selectedYes: true });
	expect(worktreeConfirmation(lines.map(line => line.replace("Remove worktree?", "Delete file?")))).toBeNull();
});

it("joins painted word-wrapped warning rows without copying editor content", () => {
	expect(startupModelWarnings([" Warning: Default model provider/missing not found. Using ", " provider/available ", "", "╭── π ▶ ⬢ Model ──╮", " Warning: a private draft"])).toEqual(["Default model provider/missing not found. Using provider/available"]);
});
