import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPlanFile, openableImagePath, readBlobImage, readPaneFile } from "./panes";

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

describe("readBlobImage", () => {
	const hash = "a".repeat(64);

	it("types extensionless blobs by their leading bytes", async () => {
		await writeFile(join(dir, hash), Buffer.from("RIFF\0\0\0\0WEBPVP8 "));
		expect(await readBlobImage(dir, hash)).toMatch(/^data:image\/webp;base64,/);
	});

	it("returns null for missing blobs and blobs that are not images", async () => {
		expect(await readBlobImage(dir, hash)).toBeNull();
		await writeFile(join(dir, hash), "plain text");
		expect(await readBlobImage(dir, hash)).toBeNull();
	});

	it("rejects ids that are not a sha256 hex digest, so no path can escape the blob folder", async () => {
		await expect(readBlobImage(dir, "../secrets")).rejects.toThrow("Not a blob id");
		await expect(readBlobImage(dir, `${hash}.webp`)).rejects.toThrow("Not a blob id");
	});
});

describe("openableImagePath", () => {
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

	it("returns the real path of a PNG", async () => {
		const file = join(dir, "poster.png");
		await writeFile(file, PNG);
		expect(await openableImagePath(file)).toBe(await realpath(file));
	});

	it("rejects a non-image renamed with an image extension", async () => {
		const file = join(dir, "fake.png");
		await writeFile(file, "#!/bin/sh\necho hi\n");
		await expect(openableImagePath(file)).rejects.toThrow("Not an image");
	});

	it("rejects SVG, which can carry script when another app opens it", async () => {
		const file = join(dir, "logo.svg");
		await writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
		await expect(openableImagePath(file)).rejects.toThrow("Not an image");
	});

	it.skipIf(process.platform === "win32")("checks the symlink target, whose extension decides the app that opens it", async () => {
		const target = join(dir, "launch.command");
		await writeFile(target, "#!/bin/sh\necho hi\n");
		await symlink(target, join(dir, "shot.png"));
		await expect(openableImagePath(join(dir, "shot.png"))).rejects.toThrow("Not an image");
		await writeFile(target, PNG);
		await expect(openableImagePath(join(dir, "shot.png"))).rejects.toThrow("Not an image");
	});

	it("rejects directories with an image name", async () => {
		await mkdir(join(dir, "folder.png"));
		await expect(openableImagePath(join(dir, "folder.png"))).rejects.toThrow("Not a file");
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
