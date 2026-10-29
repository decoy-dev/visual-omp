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
	it("never resolves out reply URLs as local files", async () => {
		if (process.platform !== "win32") {
			await mkdir(join(dir, "out:"), { recursive: true });
			await writeFile(join(dir, "out:", "report.md"), "A file with a coincidental name.");
		}
		expect(await resolveFileRefs({ refs: ["out://report.md", "OUT://report.md"], bases: [dir] }, dir)).toEqual([null, null]);
	});

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

	it("resolves the owner's shortened comparison after its folder and full filenames", async () => {
		const folder = join(dir, "Downloads", "desynth-test");
		await mkdir(folder, { recursive: true });
		const names = ["portrait_desynth.png", "portrait_source.png", "comparison_portrait_desynth_s32_d0.156_p1_r2.4_bw12.png"];
		for (const name of names) await writeFile(join(folder, name), "");
		const results = await resolveFileRefs(
			{ refs: ["~/Downloads/desynth-test/", names[0], names[1], "comparison_portrait_desynth_….png"], bases: [dir] },
			dir,
		);
		expect(results.at(-1)).toEqual({ path: join(folder, names[2]!), kind: "file" });
	});

	it("matches prefix-only, suffix-only and ordered middle parts, including folders", async () => {
		await writeFile(join(dir, "report_alpha_middle_beta.png"), "");
		await mkdir(join(dir, "exports_ready"));
		const refs = ["report_…", "….png", "report_…middle…beta.png", "report_…beta…middle.png", "exports_…/"];
		expect(await resolveFileRefs({ refs, bases: [dir] }, dir)).toEqual([
			{ path: join(dir, "report_alpha_middle_beta.png"), kind: "file" },
			{ path: join(dir, "report_alpha_middle_beta.png"), kind: "file" },
			{ path: join(dir, "report_alpha_middle_beta.png"), kind: "file" },
			null,
			{ path: join(dir, "exports_ready"), kind: "folder" },
		]);
	});

	it("leaves zero matches, multiple matches and overlapping visible parts unresolved", async () => {
		for (const name of ["report_a.png", "report_b.png", "aba"]) await writeFile(join(dir, name), "");
		expect(await resolveFileRefs({ refs: ["missing_….png", "report_….png", "ab…ba", "…"], bases: [dir] }, dir)).toEqual([null, null, null, null]);
	});

	it("uses the latest named folder, then ordered bases, and stops at an ambiguous folder", async () => {
		const [first, second, earlier, latest] = ["first", "second", "earlier", "latest"].map(name => join(dir, name));
		for (const folder of [first!, second!, earlier!, latest!]) {
			await mkdir(folder);
			await writeFile(join(folder, "report_one.png"), "");
		}
		const request = { refs: ["report_….png", earlier!, latest!, "report_….png"], bases: [first!, second!] };
		const results = await resolveFileRefs(request, dir);
		expect(results[0]?.path).toBe(join(first!, "report_one.png"));
		expect(results.at(-1)?.path).toBe(join(latest!, "report_one.png"));
		await writeFile(join(latest!, "report_two.png"), "");
		expect((await resolveFileRefs(request, dir)).at(-1)).toBeNull();
		await writeFile(join(second!, "only_here.png"), "");
		expect((await resolveFileRefs({ refs: ["only_….png"], bases: [first!, second!] }, dir))[0]?.path).toBe(join(second!, "only_here.png"));
	});

	it("searches absolute and home references only in their own parent, without recursion", async () => {
		const folder = join(dir, "named");
		await mkdir(join(folder, "nested"), { recursive: true });
		await writeFile(join(dir, "report_elsewhere.png"), "");
		await writeFile(join(folder, "nested", "report_nested.png"), "");
		const refs = [join(folder, "report_….png"), "~/named/report_….png"];
		expect(await resolveFileRefs({ refs, bases: [dir] }, dir)).toEqual([null, null]);
		await writeFile(join(folder, "report_local.png"), "");
		expect((await resolveFileRefs({ refs, bases: [dir] }, dir)).map(ref => ref?.path)).toEqual([join(folder, "report_local.png"), join(folder, "report_local.png")]);
	});

	it("skips hidden entries, hidden folders and symlinks during pattern matching", async () => {
		await writeFile(join(dir, ".secret.png"), "");
		await writeFile(join(dir, "visible.png"), "");
		await mkdir(join(dir, ".hidden"));
		await writeFile(join(dir, ".hidden", "report.png"), "");
		await symlink(join(dir, "visible.png"), join(dir, "linked.png"));
		expect(await resolveFileRefs({ refs: ["….png", ".sec….png", ".hidden/rep….png", "link….png"], bases: [dir] }, dir)).toEqual([
			{ path: join(dir, "visible.png"), kind: "file" }, null, null, null,
		]);
	});

	it("prefers an exact literal ellipsis name, including in a later base, and keeps ASCII dots literal", async () => {
		const later = join(dir, "later");
		await mkdir(later);
		for (const name of ["report_one.png", "report_two.png", "literal...png"]) await writeFile(join(dir, name), "");
		await writeFile(join(later, "report_….png"), "");
		expect(await resolveFileRefs({ refs: ["report_….png", "report_...png", "literal...png"], bases: [dir, later] }, dir)).toEqual([
			{ path: join(later, "report_….png"), kind: "file" }, null, { path: join(dir, "literal...png"), kind: "file" },
		]);
	});

	it("discards partial matches in oversized folders and accepts folders at the entry cap", async () => {
		const large = join(dir, "large");
		const small = join(dir, "small");
		await mkdir(large);
		await mkdir(small);
		for (const name of ["report_one.png", "other-a", "other-b"]) await writeFile(join(large, name), "");
		for (const name of ["report_two.png", "other"]) await writeFile(join(small, name), "");
		const limits = { ...FILE_REF_LIMITS, folderEntries: 2 };
		expect(await resolveFileRefs({ refs: ["report_….png"], bases: [large] }, dir, limits)).toEqual([null]);
		expect(await resolveFileRefs({ refs: ["report_….png"], bases: [large, small] }, dir, limits)).toEqual([{ path: join(small, "report_two.png"), kind: "file" }]);
	});

	it("shares the total scan cap across references, counts hidden entries, and still resolves exact paths", async () => {
		await writeFile(join(dir, "report_one.png"), "");
		await writeFile(join(dir, ".hidden"), "");
		const limits = { ...FILE_REF_LIMITS, totalEntries: 3 };
		expect(await resolveFileRefs({ refs: ["report_….png", "report_….png", "report_one.png"], bases: [dir] }, dir, limits)).toEqual([
			{ path: join(dir, "report_one.png"), kind: "file" }, null, { path: join(dir, "report_one.png"), kind: "file" },
		]);
		expect(await resolveFileRefs({ refs: ["report_….png"], bases: [dir] }, dir, { ...limits, totalEntries: 1 })).toEqual([null]);
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
