import { appendFile, mkdtemp, open, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionTail } from "./tail";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
/** A physical title slot: exactly 256 bytes including the newline, like omp's `serializeTitleSlot`. */
const slot = (title: string) => {
	const bare = JSON.stringify({ type: "title", v: 1, title, updatedAt: "2026-01-01T00:00:00Z", pad: "" });
	return `${bare.slice(0, -2)}${" ".repeat(255 - Buffer.byteLength(bare))}"}\n`;
};

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vomp-tail-"));
	file = join(dir, "s.jsonl");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("SessionTail", () => {
	it("returns only complete new lines and keeps a partial line (even mid-UTF-8) for the next read", async () => {
		const first = line({ type: "session", id: "s1" });
		await writeFile(file, first);
		const tail = new SessionTail(file);
		expect(await tail.read()).toEqual({ text: first, reset: true });

		const entry = line({ type: "message", id: "a", text: "naïve ✓" });
		const bytes = Buffer.from(entry);
		const cut = bytes.indexOf(Buffer.from("✓")) + 1; // inside the 3-byte check mark
		await appendFile(file, bytes.subarray(0, cut));
		expect(await tail.read()).toBeNull();
		await appendFile(file, bytes.subarray(cut));
		expect(await tail.read()).toEqual({ text: entry, reset: false });
		expect(await tail.read()).toBeNull();
	});

	it("reads the whole file again after truncation, replacement or an in-place rewrite", async () => {
		const a = line({ type: "message", id: "a" });
		const b = line({ type: "message", id: "b" });
		await writeFile(file, a + b);
		const tail = new SessionTail(file);
		await tail.read();

		await truncate(file, 0);
		await appendFile(file, a);
		expect(await tail.read()).toEqual({ text: a, reset: true });

		const replacement = join(dir, "next.jsonl");
		await writeFile(replacement, b);
		await rename(replacement, file);
		expect(await tail.read()).toEqual({ text: b, reset: true });

		// Same inode, longer, different bytes before the old offset: not an append.
		const rewritten = line({ type: "message", id: "B" }) + a;
		await writeFile(file, rewritten);
		expect(await tail.read()).toEqual({ text: rewritten, reset: true });
	});

	it("throws while the file is unreadable (unlike an unchanged file) and resumes when it is back", async () => {
		const a = line({ type: "message", id: "a" });
		await writeFile(file, a);
		const tail = new SessionTail(file);
		await tail.read();
		expect(await tail.read()).toBeNull();

		await rm(file);
		await expect(tail.read()).rejects.toMatchObject({ code: "ENOENT" });

		const b = line({ type: "message", id: "b" });
		await writeFile(file, b + a);
		expect(await tail.read()).toEqual({ text: b + a, reset: true });
	});

	it("resends the title slot when omp renames the chat in place", async () => {
		const header = line({ type: "session", id: "s1" });
		await writeFile(file, slot("Old") + header + line({ type: "message", id: "a" }));
		const tail = new SessionTail(file);
		await tail.read();

		const handle = await open(file, "r+");
		await handle.write(slot("New"), 0);
		await handle.close();
		const entry = line({ type: "message", id: "b" });
		await appendFile(file, entry);
		expect(await tail.read()).toEqual({ text: slot("New") + entry, reset: false });
	});
});
