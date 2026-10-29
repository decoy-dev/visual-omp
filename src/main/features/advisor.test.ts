import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAdvisorDocument, readAdvisorFile, saveAdvisorFile } from "./advisor";
vi.mock("../ipc", () => ({ handle: vi.fn() }));

vi.mock("../omp/config-file", () => ({ ompAgentDir: vi.fn() }));
describe("advisor configuration storage", () => {
	it("retains raw imports, empty tool lists, numeric catch-up and unknown fields", () => {
		expect(parseAdvisorDocument('instructions: "@./baseline.md"\nother: kept\nadvisors:\n  - name: reviewer\n    tools: []\n    reviewMode: agent-end\n    reviewInterval: 7\n    syncBacklog: 3\n    custom: retained\n')).toMatchObject({ instructions: "@./baseline.md", other: "kept", advisors: [{ name: "reviewer", tools: [], reviewMode: "agent-end", reviewInterval: 7, syncBacklog: 3, custom: "retained" }] });
	});
	it("refuses malformed cadence and catch-up instead of rewriting a broken entry", () => {
		expect(() => parseAdvisorDocument("advisors:\n - name: invalid\n   reviewInterval: 0\n")).toThrow();
		expect(() => parseAdvisorDocument("advisors:\n - name: invalid\n   syncBacklog: 2\n")).toThrow();
	});
	it("persists cadence, preserves top-level comments, refuses concurrent edits and removes an empty roster", async () => {
		const dir = await mkdtemp(join(tmpdir(), "misc-advisor-"));
		const file = join(dir, "WATCHDOG.yaml");
		try {
			await writeFile(file, "# baseline\ninstructions: check changes\nadvisors:\n  - name: reviewer\n");
			const initial = await readAdvisorFile(file);
			const changed = { ...initial.doc, advisors: [{ ...initial.doc.advisors[0]!, reviewMode: "agent-end" as const, reviewInterval: 4, syncBacklog: "strict" as const }] };
			const saved = await saveAdvisorFile(file, initial.content, changed);
			expect(saved.doc.advisors[0]).toMatchObject({ reviewMode: "agent-end", reviewInterval: 4, syncBacklog: "strict" });
			expect(await readFile(file, "utf8")).toContain("# baseline");
			await expect(saveAdvisorFile(file, initial.content, changed)).rejects.toThrow("changed outside");
			expect(await saveAdvisorFile(file, saved.content, { advisors: [] })).toMatchObject({ exists: false, doc: { advisors: [] } });
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
});
