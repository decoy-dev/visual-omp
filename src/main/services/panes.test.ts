import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPlanFile, readPaneFile } from "./panes";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vomp-panes-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("readPaneFile", () => {
	it("reads UTF-8 text, including multi-byte characters", async () => {
		const file = join(dir, "a.ts");
		await writeFile(file, "const π = '✓';\n");
		expect(await readPaneFile(file)).toEqual({ kind: "text", text: "const π = '✓';\n", size: 18 });
	});

	it("reports binary content instead of decoding it", async () => {
		const file = join(dir, "blob.dat");
		await writeFile(file, Buffer.from([0x48, 0x00, 0xff, 0x10]));
		expect(await readPaneFile(file)).toEqual({ kind: "binary", size: 4 });
	});

	it("returns images as data URLs typed by extension", async () => {
		const file = join(dir, "dot.png");
		await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const result = await readPaneFile(file);
		expect(result).toEqual({ kind: "image", dataUrl: "data:image/png;base64,iVBORw==", size: 4 });
	});

	it("refuses text over the size limit without reading it", async () => {
		const file = join(dir, "big.txt");
		await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
		expect(await readPaneFile(file)).toMatchObject({ kind: "tooLarge", limit: 2 * 1024 * 1024 });
	});

	it("rejects directories", async () => {
		await expect(readPaneFile(dir)).rejects.toThrow("Not a file");
	});
});

describe("findPlanFile", () => {
	it("returns null when the session has no local folder", async () => {
		expect(await findPlanFile(join(dir, "session.jsonl"))).toBeNull();
	});

	it("picks the newest *plan*.md in <session>/local and ignores other files", async () => {
		const local = join(dir, "session", "local");
		await mkdir(local, { recursive: true });
		await writeFile(join(local, "PLAN.md"), "# old");
		await writeFile(join(local, "checkout-fix-plan.md"), "# new");
		await writeFile(join(local, "notes.md"), "# not a plan");
		const past = new Date(Date.now() - 60_000);
		await utimes(join(local, "PLAN.md"), past, past);
		const plan = await findPlanFile(join(dir, "session.jsonl"));
		expect(plan?.path).toBe(join(local, "checkout-fix-plan.md"));
		expect(plan?.text).toBe("# new");
	});
});
