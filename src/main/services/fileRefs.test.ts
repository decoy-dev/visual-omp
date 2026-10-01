import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplyRefCache, type ReplyRefs } from "../../renderer/src/chat/transcript/fileRefs";
import { FILE_REF_LIMITS, resolveFileRefs } from "./fileRefs";

let dir: string;
beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "vomp-refs-")));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("resolveFileRefs", () => {
	it("resolves names in a folder the reply named earlier before the chat's folder", async () => {
		// The reply that prompted this: "Files are in `~/Downloads/Flyer/`, and `CONTEXT.md` is updated: ... previews/".
		const home = join(dir, "home");
		const flyer = join(home, "Downloads", "Flyer");
		const project = join(dir, "project");
		await mkdir(join(flyer, "previews"), { recursive: true });
		await mkdir(project);
		await writeFile(join(flyer, "CONTEXT.md"), "flyer");
		await writeFile(join(project, "CONTEXT.md"), "project");
		await writeFile(join(flyer, "Flyer-DIGITAL.pdf"), "%PDF-");
		const results = await resolveFileRefs(
			{ refs: ["~/Downloads/Flyer/", "CONTEXT.md", "Flyer-DIGITAL.pdf", "previews/", "missing.pdf"], bases: [project] },
			home,
		);
		expect(results).toEqual([
			{ path: flyer, kind: "folder" },
			{ path: join(flyer, "CONTEXT.md"), kind: "file" },
			{ path: join(flyer, "Flyer-DIGITAL.pdf"), kind: "file" },
			{ path: join(flyer, "previews"), kind: "folder" },
			null,
		]);
	});

	it("tries bases in order, after folders named earlier in the request", async () => {
		const first = join(dir, "first");
		const second = join(dir, "second");
		await mkdir(first);
		await mkdir(second);
		await writeFile(join(second, "a.md"), "");
		await writeFile(join(first, "b.md"), "");
		await writeFile(join(second, "b.md"), "");
		const results = await resolveFileRefs({ refs: ["a.md", "b.md", second, "b.md"], bases: [first, second] }, dir);
		expect(results.map(result => result?.path ?? null)).toEqual([join(second, "a.md"), join(first, "b.md"), second, join(second, "b.md")]);
	});

	it("tries the latest named folder first and keeps only the newest few", async () => {
		const folders = ["f0", "f1", "f2", "f3", "f4", "f5"].map(name => join(dir, name));
		for (const folder of folders) {
			await mkdir(folder);
			await writeFile(join(folder, "x.md"), "");
		}
		const [oldest] = folders;
		await writeFile(join(oldest ?? "", "only-oldest.md"), "");
		const results = await resolveFileRefs({ refs: [...folders, "x.md", "only-oldest.md"], bases: [] }, dir);
		expect(results.at(-2)?.path).toBe(join(folders[5] ?? "", "x.md"));
		expect(results.at(-1)).toBeNull();
	});

	it("resolves symlinks and refuses things that are not regular files or folders", async () => {
		await writeFile(join(dir, "target.md"), "");
		await symlink(join(dir, "target.md"), join(dir, "link.md"));
		await symlink(join(dir, "nowhere"), join(dir, "dangling.md"));
		const results = await resolveFileRefs({ refs: ["link.md", "dangling.md", "/dev/null"], bases: [dir] }, dir);
		expect(results).toEqual([{ path: join(dir, "target.md"), kind: "file" }, null, null]);
	});

	it("rejects requests over the limits or with invalid paths", async () => {
		const tooMany = Array.from({ length: FILE_REF_LIMITS.refs + 1 }, (_, n) => `f${n}.md`);
		await expect(resolveFileRefs({ refs: tooMany, bases: [] }, dir)).rejects.toThrow("Invalid file references");
		await expect(resolveFileRefs({ refs: [], bases: Array.from({ length: FILE_REF_LIMITS.bases + 1 }, () => dir) }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["a.md"], bases: ["relative/base"] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["a\0.md"], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["x".repeat(FILE_REF_LIMITS.length + 1)], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["\\\\server\\share\\a.md"], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: [""], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: [1], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs(null, dir)).rejects.toThrow();
	});

	it("expands ~ in bases", async () => {
		await mkdir(join(dir, "made"));
		await writeFile(join(dir, "made", "out.pdf"), "");
		expect(await resolveFileRefs({ refs: ["out.pdf"], bases: ["~/made"] }, dir)).toEqual([{ path: join(dir, "made", "out.pdf"), kind: "file" }]);
	});
});

describe("ReplyRefCache against the resolver", () => {
	let a: string;
	let b: string;
	let calls: number;
	let cache: ReplyRefCache;
	beforeEach(async () => {
		a = join(dir, "a");
		b = join(dir, "b");
		for (const folder of [a, b]) {
			await mkdir(folder);
			await writeFile(join(folder, "report.pdf"), "%PDF-");
		}
		calls = 0;
		cache = new ReplyRefCache(request => {
			calls++;
			return resolveFileRefs(request, dir);
		});
	});
	const paths = (refs: ReplyRefs | null) => refs?.map(block => block.map(ref => ref?.path ?? null)) ?? null;

	it("gives each occurrence of one name its own result, across text blocks", async () => {
		const blocks = [[`${a}/`, "report.pdf", `${b}/`, "report.pdf"], ["report.pdf"]];
		await cache.load("chat\x001", "text", "", () => ({ blocks, bases: [] }));
		expect(paths(cache.read("chat\x001", "text"))).toEqual([[a, join(a, "report.pdf"), b, join(b, "report.pdf")], [join(b, "report.pdf")]]);
	});

	it("keeps replies with the same text in different chats apart", async () => {
		await cache.load("one\x001", "report.pdf", a, () => ({ blocks: [["report.pdf"]], bases: [a] }));
		await cache.load("two\x001", "report.pdf", b, () => ({ blocks: [["report.pdf"]], bases: [b] }));
		expect(paths(cache.read("one\x001", "report.pdf"))).toEqual([[join(a, "report.pdf")]]);
		expect(paths(cache.read("two\x001", "report.pdf"))).toEqual([[join(b, "report.pdf")]]);
	});

	it("reuses a reply's result for the same text and bases, and re-resolves new bases while showing the old links", async () => {
		const source = (bases: string[]) => () => ({ blocks: [["report.pdf"]], bases });
		await cache.load("chat\x001", "report.pdf", a, source([a]));
		const first = cache.read("chat\x001", "report.pdf");
		// The saved entry that replaces a stream row asks again with the same reply, text and bases.
		expect(cache.load("chat\x001", "report.pdf", a, source([a]))).toBeNull();
		expect(cache.read("chat\x001", "report.pdf")).toBe(first);
		expect(calls).toBe(1);
		const pending = cache.load("chat\x001", "report.pdf", b, source([b]));
		expect(cache.read("chat\x001", "report.pdf")).toBe(first);
		await pending;
		expect(paths(cache.read("chat\x001", "report.pdf"))).toEqual([[join(b, "report.pdf")]]);
		// Other text under the same key links nothing until it resolves.
		void cache.load("chat\x001", "other", b, source([b]));
		expect(cache.read("chat\x001", "other")).toBeNull();
	});
});
