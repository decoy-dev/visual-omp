import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginAdvisorApply, finishAdvisorApply, readAdvisorFile, saveAdvisorFile } from "./advisor";
vi.mock("../ipc", () => ({ handle: vi.fn() }));
vi.mock("../omp/config-file", () => ({ ompAgentDir: vi.fn() }));

describe("Advisor save and apply preservation", () => {
	it("supports save, omp apply, edit and save in .yaml without losing comments or unknown fields", async () => {
		const dir = await mkdtemp(join(tmpdir(), "misc-apply-"));
		const file = join(dir, "WATCHDOG.yaml");
		try {
			await writeFile(file, '# shared comment\nfuture: retained\nadvisors:\n  - name: Reviewer\n    # cadence comment\n    reviewInterval: 1\n    futureEntry: retained\n');
			const original = await readAdvisorFile(file);
			const saved = await saveAdvisorFile(file, original.content, { ...original.doc, advisors: [{ ...original.doc.advisors[0]!, reviewInterval: 3 }] });
			expect(saved.content).toContain("# cadence comment");
			const token = await beginAdvisorApply(file);
			await expect(saveAdvisorFile(file, saved.content, saved.doc)).rejects.toThrow("finish applying");
			// omp's actual serializer omits comments and unknown keys and orders the known fields this way.
			await writeFile(file, 'advisors:\n  - name: Reviewer\n    reviewInterval: 3\n');
			const applied = await finishAdvisorApply(token);
			expect(applied.content).toBe(saved.content);
			const edited = await saveAdvisorFile(file, applied.content, { ...applied.doc, advisors: [{ ...applied.doc.advisors[0]!, reviewInterval: 5 }] });
			expect(edited.doc.advisors[0]?.reviewInterval).toBe(5);
			expect(edited.content).toContain("# shared comment");
			expect(edited.content).toContain("# cadence comment");
			expect(edited.doc.future).toBe("retained");
			expect(edited.doc.advisors[0]?.futureEntry).toBe("retained");
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	it.each([undefined, true])("preserves a lone explicit default advisor and its turn cadence with enabled=%s", async enabled => {
		const dir = await mkdtemp(join(tmpdir(), "misc-default-")); const file = join(dir, "WATCHDOG.yaml");
		try {
			await writeFile(file, `# original roster\nfuture: retained\nadvisors:\n  - name: default\n    futureEntry: retained\n${enabled === true ? "    enabled: true\n" : ""}`);
			const original = await readAdvisorFile(file);
			const saved = await saveAdvisorFile(file, original.content, { ...original.doc, instructions: "first saved baseline" });
			const token = await beginAdvisorApply(file);
			const prepared = await readAdvisorFile(file);
			// This explicit cadence makes omp's #hasSyntheticDefaultAdvisor predicate false, preserving roster semantics.
			expect(prepared.doc.advisors[0]?.reviewMode).toBe("turn");
			await writeFile(file, `instructions: first saved baseline\nadvisors:\n  - name: default\n    reviewMode: turn\n${enabled === true ? "    enabled: true\n" : ""}`);
			const applied = await finishAdvisorApply(token);
			expect(applied.content).toBe(saved.content);
			expect(applied.doc.advisors[0]?.reviewMode).toBeUndefined();
			const edited = await saveAdvisorFile(file, applied.content, { ...applied.doc, instructions: "second saved baseline" });
			expect(edited.doc.advisors).toEqual(original.doc.advisors);
			expect(edited.content).toContain("# original roster");
			expect(edited.doc.future).toBe("retained");
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	it("recognizes omp's multiline CRLF normalization and restores original instructions before another save", async () => {
		const dir = await mkdtemp(join(tmpdir(), "misc-crlf-")); const file = join(dir, "WATCHDOG.yaml");
		try {
			await writeFile(file, '# original\\n'.replace("\\n", "\n") + 'instructions: "one\\r\\ntwo\\r\\n"\nadvisors:\n  - name: Reviewer\n    instructions: "three\\r\\nfour"\n    futureEntry: retained\n');
			const original = await readAdvisorFile(file);
			const saved = await saveAdvisorFile(file, original.content, { ...original.doc, maxNotesPerUpdate: 3 });
			const token = await beginAdvisorApply(file);
			await writeFile(file, 'instructions: |2\n  one\n  two\nmaxNotesPerUpdate: 3\nadvisors:\n  - name: Reviewer\n    instructions: |2-\n      three\n      four\n');
			const applied = await finishAdvisorApply(token);
			expect(applied.content).toBe(saved.content);
			expect(applied.doc.instructions).toBe("one\r\ntwo\r\n");
			expect(applied.doc.advisors[0]?.instructions).toBe("three\r\nfour");
			const edited = await saveAdvisorFile(file, applied.content, { ...applied.doc, maxNotesPerUpdate: 4 });
			expect(edited.doc.instructions).toBe(original.doc.instructions);
			expect(edited.doc.advisors[0]?.futureEntry).toBe("retained");
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	it.each(['advisors:\n  - name: External edit\n', '# external comment\nadvisors:\n  - name: Reviewer\n'])("retains an unexplained external write during apply", async external => {
		const dir = await mkdtemp(join(tmpdir(), "misc-apply-race-")); const file = join(dir, "WATCHDOG.yaml");
		try {
			await writeFile(file, '# original\nadvisors:\n  - name: Reviewer\n');
			const token = await beginAdvisorApply(file);
			await writeFile(file, external);
			await expect(finishAdvisorApply(token)).rejects.toThrow("current file was retained");
			expect(await readFile(file, "utf8")).toBe(external);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
});
