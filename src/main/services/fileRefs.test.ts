import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
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
	it("resolves decoded reply-link paths inside a chat folder containing spaces and an at sign", async () => {
		const cwd = join(dir, "Drive-example@example.test", "Drive Files", "Ads");
		const card = join(cwd, "Folder Name", "08-card.png");
		await mkdir(join(cwd, "Folder Name"), { recursive: true });
		for (const file of [card, join(cwd, "notes.md"), join(cwd, "literal%20name.md")]) await writeFile(file, "fixture");
		expect(await resolveFileRefs({
			refs: ["Folder Name/08-card.png", "./notes.md", card, "literal%20name.md", "missing card.png", "Folder%20Name/08-card.png"],
			bases: [cwd],
		}, dir)).toEqual([
			{ path: card, kind: "file" },
			{ path: join(cwd, "notes.md"), kind: "file" },
			{ path: card, kind: "file" },
			{ path: join(cwd, "literal%20name.md"), kind: "file" },
			null,
			null,
		]);
	});

	it("never resolves out reply URLs as local files", async () => {
		if (process.platform !== "win32") {
			await mkdir(join(dir, "out:"), { recursive: true });
			await writeFile(join(dir, "out:", "report.md"), "A file with a coincidental name.");
		}
		expect(await resolveFileRefs({ refs: ["out://report.md", "OUT://report.md"], bases: [dir] }, dir)).toEqual([null, null]);
	});

	it("supplies canonical project identity and file targets when the opened folder is a symlink", async () => {
		const real = join(dir, "real-project");
		const opened = join(dir, "opened-project");
		await mkdir(join(real, "Large Media Files"), { recursive: true });
		await writeFile(join(real, "Large Media Files", "Large video.mp4"), "fixture");
		await symlink(real, opened, process.platform === "win32" ? "junction" : "dir");
		expect(await resolveFileRefs({ refs: [opened], bases: [] }, dir)).toEqual([{ path: real, kind: "folder" }]);
		expect(await resolveFileRefs({ refs: ["Large Media Files/Large video.mp4"], bases: [opened] }, dir)).toEqual([{ path: join(real, "Large Media Files", "Large video.mp4"), kind: "file" }]);
	});

	it.skipIf(process.platform !== "darwin")("resolves a /var project and its /private/var canonical identity consistently", async () => {
		const opened = dir.replace(/^\/private(?=\/var\/)/, "");
		expect(await resolveFileRefs({ refs: [opened], bases: [] }, dir)).toEqual([{ path: dir, kind: "folder" }]);
	});

	it("resolves the owner's spaced directory and bare video names without guessing missing files", async () => {
		const folder = join(dir, "ReadyCloud Files", "ReadyReturns Chat Demos", "Videos");
		await mkdir(folder, { recursive: true });
		const names = ["FootLocker Return Chat v2.mp4", "Dicks Sporting Goods Return Chat.mp4"];
		for (const name of names) await writeFile(join(folder, name), "fixture");
		expect(await resolveFileRefs({ refs: ["ReadyCloud Files/ReadyReturns Chat Demos/Videos/", ...names, "Missing video.mp4"], bases: [dir] }, dir)).toEqual([
			{ path: folder, kind: "folder" }, ...names.map(name => ({ path: join(folder, name), kind: "file" })), null,
		]);
		expect(await resolveFileRefs({ refs: [...names, "ReadyCloud Files/ReadyReturns Chat Demos/Videos/"], bases: [dir] }, dir)).toEqual([
			...names.map(name => ({ path: join(folder, name), kind: "file" })), { path: folder, kind: "folder" },
		]);
	});

	it("uses uniquely matching known turn Outputs even when the chat is in another folder", async () => {
		const folder = join(dir, "outputs", "ReadyCloud Files", "ReadyReturns Chat Demos", "Videos");
		const chat = join(dir, "chat");
		await mkdir(folder, { recursive: true }); await mkdir(chat);
		const file = join(folder, "FootLocker Return Chat v2.mp4");
		await writeFile(file, "fixture");
		expect(await resolveFileRefs({ refs: ["ReadyCloud Files/ReadyReturns Chat Demos/Videos/", "FootLocker Return Chat v2.mp4", "Missing video.mp4"], bases: [chat], files: [file] }, dir)).toEqual([
			{ path: folder, kind: "folder" }, { path: file, kind: "file" }, null,
		]);
		expect(await resolveFileRefs({ refs: ["FootLocker Return Chat v2.mp4"], bases: [folder], files: [file, file] }, dir)).toEqual([{ path: file, kind: "file" }]);
	});

	it("resolves a relative path below a folder reached by an earlier tool call", async () => {
		const chat = join(dir, "chat");
		const laptop = join(dir, "My Laptop");
		const folder = join(laptop, "ReadyCloud Files", "Asset Retrieval Return Email");
		const file = join(folder, "asset-retrieval-return-email.zip");
		await mkdir(chat);
		await mkdir(folder, { recursive: true });
		await writeFile(file, "fixture");
		expect(await resolveFileRefs({
			refs: ["ReadyCloud Files/Asset Retrieval Return Email/asset-retrieval-return-email.zip"],
			bases: [chat],
			toolBases: [laptop],
		}, dir)).toEqual([{ path: file, kind: "file" }]);
	});

	it("keeps earlier tool folders ambiguous and gives chat matches precedence", async () => {
		const name = "ReadyCloud Files/Asset Retrieval Return Email/asset-retrieval-return-email.zip";
		const [first, second] = [join(dir, "first"), join(dir, "second")];
		for (const base of [first, second]) {
			const folder = join(base, "ReadyCloud Files", "Asset Retrieval Return Email");
			await mkdir(folder, { recursive: true });
			await writeFile(join(folder, "asset-retrieval-return-email.zip"), "fixture");
		}
		const chat = join(dir, "chat");
		await mkdir(chat);
		expect(await resolveFileRefs({ refs: [name], bases: [chat], toolBases: [first, second] }, dir)).toEqual([null]);

		const chatFile = join(chat, name);
		await mkdir(dirname(chatFile), { recursive: true });
		await writeFile(chatFile, "chat");
		expect(await resolveFileRefs({ refs: [name], bases: [chat], toolBases: [first, second] }, dir)).toEqual([{ path: chatFile, kind: "file" }]);
	});

	it("does not use the home folder alone as a tool base", async () => {
		await writeFile(join(dir, "at-home.md"), "fixture");
		expect(await resolveFileRefs({ refs: ["at-home.md"], bases: [], toolBases: [dir] }, dir)).toEqual([null]);
	});

	it("keeps tool fallbacks inside their lexical and canonical folders", async () => {
		const tool = join(dir, "tool");
		const outside = join(dir, "outside");
		await mkdir(tool);
		await mkdir(outside);
		await writeFile(join(dir, "outside.md"), "outside");
		await writeFile(join(outside, "secret.md"), "secret");
		await writeFile(join(outside, "report_secret.png"), "secret");
		await symlink(outside, join(tool, "escape"), process.platform === "win32" ? "junction" : "dir");
		expect(await resolveFileRefs({ refs: ["../outside.md"], bases: [], toolBases: [tool] }, dir)).toEqual([null]);
		expect(await resolveFileRefs({ refs: ["escape/secret.md"], bases: [], toolBases: [tool] }, dir)).toEqual([null]);
		expect(await resolveFileRefs({ refs: ["escape/report_….png"], bases: [], toolBases: [tool] }, dir)).toEqual([null]);
	});

	it("keeps a promoted tool folder inside its original boundary", async () => {
		const tool = join(dir, "tool");
		const subdir = join(tool, "subdir");
		const outside = join(dir, "outside");
		await mkdir(subdir, { recursive: true });
		await mkdir(outside);
		await writeFile(join(dir, "outside.md"), "outside");
		await writeFile(join(outside, "secret.md"), "secret");
		await writeFile(join(outside, "report_secret.png"), "secret");
		await symlink(outside, join(subdir, "escape"), process.platform === "win32" ? "junction" : "dir");
		expect(await resolveFileRefs({
			refs: ["subdir/", "../../outside.md", "escape/secret.md", "escape/report_….png"],
			bases: [],
			toolBases: [tool],
		}, dir)).toEqual([
			{ path: subdir, kind: "folder" },
			null,
			null,
			null,
		]);
	});

	it("keeps explicit absolute reply directories unrestricted", async () => {
		const explicit = join(dir, "explicit");
		const tool = join(dir, "tool");
		const outside = join(dir, "outside.md");
		await mkdir(explicit);
		await mkdir(tool);
		await writeFile(outside, "fixture");
		expect(await resolveFileRefs({ refs: [`${explicit}/`, "../outside.md"], bases: [], toolBases: [tool] }, dir)).toEqual([
			{ path: explicit, kind: "folder" },
			{ path: outside, kind: "file" },
		]);
	});

	it("rejects a tool base whose symlink target is the home folder", async () => {
		const alias = join(dir, "home-alias");
		await writeFile(join(dir, "at-home.md"), "fixture");
		await symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
		expect(await resolveFileRefs({ refs: ["at-home.md"], bases: [], toolBases: [alias] }, dir)).toEqual([null]);
	});

	it.skipIf(process.platform === "win32")("rejects a tool base whose symlink target is the filesystem root", async () => {
		const alias = join(dir, "root-alias");
		await symlink(parse(dir).root, alias, "dir");
		expect(await resolveFileRefs({ refs: ["etc/passwd"], bases: [], toolBases: [alias] }, dir)).toEqual([null]);
	});

	it.skipIf(process.platform !== "win32")("ignores drive relative references and keeps absolute paths working", async () => {
		const file = join(dir, "notes.md");
		await writeFile(file, "fixture");
		const drive = parse(dir).root[0];
		expect(await resolveFileRefs({ refs: [`${drive}:notes.md`], bases: [dir] }, dir)).toEqual([null]);
		expect(await resolveFileRefs({ refs: [file], bases: [] }, dir)).toEqual([{ path: file, kind: "file" }]);
	});

	it("keeps reply directories and Outputs ahead of tool folders", async () => {
		const chat = join(dir, "chat");
		const firstTool = join(dir, "first-tool");
		const secondTool = join(dir, "second-tool");
		const named = join(firstTool, "Docs");
		await mkdir(chat);
		await mkdir(named, { recursive: true });
		await mkdir(secondTool);
		await writeFile(join(named, "report.md"), "reply directory");
		await writeFile(join(secondTool, "report.md"), "tool folder");
		expect(await resolveFileRefs({ refs: ["Docs/", "report.md"], bases: [chat], toolBases: [firstTool, secondTool] }, dir)).toEqual([
			{ path: named, kind: "folder" },
			{ path: join(named, "report.md"), kind: "file" },
		]);

		const output = join(dir, "outputs", "report.md");
		const tool = join(dir, "other-tool");
		await mkdir(dirname(output), { recursive: true });
		await mkdir(tool);
		await writeFile(output, "output");
		await writeFile(join(tool, "report.md"), "tool");
		expect(await resolveFileRefs({ refs: ["report.md"], bases: [], files: [output], toolBases: [tool] }, dir)).toEqual([{ path: output, kind: "file" }]);
	});

	it("does not use tool folders to resolve an ambiguous primary candidate set", async () => {
		const [first, second, tool] = [join(dir, "first"), join(dir, "second"), join(dir, "tool")];
		for (const folder of [first, second, tool]) {
			await mkdir(folder);
			await writeFile(join(folder, "report.md"), folder);
		}
		expect(await resolveFileRefs({ refs: ["report.md"], bases: [first, second], toolBases: [tool] }, dir)).toEqual([null]);
	});

	it("counts aliases of one canonical tool target once", async () => {
		const real = join(dir, "real-tool");
		const aliases = [join(dir, "tool-one"), join(dir, "tool-two")];
		await mkdir(real);
		const file = join(real, "report.md");
		await writeFile(file, "fixture");
		for (const alias of aliases) await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
		expect(await resolveFileRefs({ refs: ["report.md"], bases: [], toolBases: aliases }, dir)).toEqual([{ path: file, kind: "file" }]);
	});

	it("resolves exact and abbreviated children after promoting a symlinked tool folder", async () => {
		const real = join(dir, "real-tool");
		const alias = join(dir, "tool-alias");
		const subdir = join(real, "subdir");
		const exact = join(subdir, "report.md");
		const abbreviated = join(subdir, "report_notes.png");
		await mkdir(subdir, { recursive: true });
		await writeFile(exact, "fixture");
		await writeFile(abbreviated, "fixture");
		await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
		expect(await resolveFileRefs({ refs: ["subdir/", "report.md"], bases: [], toolBases: [alias] }, dir)).toEqual([
			{ path: subdir, kind: "folder" },
			{ path: exact, kind: "file" },
		]);
		expect(await resolveFileRefs({ refs: ["subdir/", "report_….png"], bases: [], toolBases: [alias] }, dir)).toEqual([
			{ path: subdir, kind: "folder" },
			{ path: abbreviated, kind: "file" },
		]);
	});

	it("leaves ambiguous spaced names unresolved across named folders and known Outputs", async () => {
		const name = "FootLocker Return Chat v2.mp4";
		const folders = [join(dir, "one"), join(dir, "two")];
		for (const folder of folders) { await mkdir(folder); await writeFile(join(folder, name), "fixture"); }
		expect(await resolveFileRefs({ refs: [name], bases: folders }, dir)).toEqual([null]);
		expect(await resolveFileRefs({ refs: [name], bases: [], files: folders.map(folder => join(folder, name)) }, dir)).toEqual([null]);
		expect(await resolveFileRefs({ refs: [name], bases: [], files: [join(folders[0]!, "missing.mp4")] }, dir)).toEqual([null]);
	});

	it("uses named directories but leaves duplicate exact names ambiguous", async () => {
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
			null,
			{ path: join(flyer, "Flyer-DIGITAL.pdf"), kind: "file" },
			{ path: join(flyer, "previews"), kind: "folder" },
			null,
		]);
	});

	it("checks all eligible bases and rejects duplicate canonical targets", async () => {
		const first = join(dir, "first");
		const second = join(dir, "second");
		await mkdir(first);
		await mkdir(second);
		await writeFile(join(second, "a.md"), "");
		await writeFile(join(first, "b.md"), "");
		await writeFile(join(second, "b.md"), "");
		const results = await resolveFileRefs({ refs: ["a.md", "b.md", second, "b.md"], bases: [first, second] }, dir);
		expect(results.map(result => result?.path ?? null)).toEqual([join(second, "a.md"), null, second, null]);
	});

	it("resolves a path that starts with the chat folder's own name, without reaching sibling folders", async () => {
		// The reply that prompted this, from a chat in `.../Testimonials/DEEL Two Sheeter`:
		// "The Deel two-pager is done: `DEEL Two Sheeter/ReadyCloud + Deel Partnership Overview.pdf`."
		const chat = join(dir, "Testimonials", "DEEL Two Sheeter");
		const other = join(dir, "Testimonials", "Other");
		await mkdir(chat, { recursive: true });
		await mkdir(other);
		await writeFile(join(chat, "ReadyCloud + Deel Partnership Overview.pdf"), "%PDF-");
		await writeFile(join(other, "sibling.md"), "");
		const refs = ["DEEL Two Sheeter/ReadyCloud + Deel Partnership Overview.pdf", "Other/sibling.md", "DEEL Two Sheeter/../Other/sibling.md"];
		expect(await resolveFileRefs({ refs, bases: [chat] }, dir)).toEqual([{ path: join(chat, "ReadyCloud + Deel Partnership Overview.pdf"), kind: "file" }, null, null]);
	});

	it("tries primary repeated names before exact tool folder candidates", async () => {
		const chat = join(dir, "Chat");
		const tool = join(dir, "tool");
		await mkdir(chat);
		await mkdir(join(tool, "Chat"), { recursive: true });
		const primary = join(chat, "inner.md");
		await writeFile(primary, "repeated primary");
		await writeFile(join(tool, "Chat", "inner.md"), "exact tool path");
		expect(await resolveFileRefs({ refs: ["Chat/inner.md"], bases: [chat], toolBases: [tool] }, dir)).toEqual([
			{ path: primary, kind: "file" },
		]);
	});

	it("prefers every exact candidate over dropping a repeated folder name", async () => {
		const chat = join(dir, "Chat");
		await mkdir(join(chat, "Chat"), { recursive: true });
		await writeFile(join(chat, "Chat", "inner.md"), "nested");
		await writeFile(join(chat, "inner.md"), "shortened");
		// A named folder whose name repeats, then a later base that holds the exact path.
		const named = join(dir, "one", "Proj");
		const later = join(dir, "two");
		await mkdir(named, { recursive: true });
		await mkdir(join(later, "Proj"), { recursive: true });
		await writeFile(join(named, "x.md"), "shortened");
		await writeFile(join(later, "Proj", "x.md"), "exact");
		expect(await resolveFileRefs({ refs: ["Chat/inner.md"], bases: [chat] }, dir)).toEqual([{ path: join(chat, "Chat", "inner.md"), kind: "file" }]);
		const results = await resolveFileRefs({ refs: [`${named}/`, "Proj/x.md"], bases: [later] }, dir);
		expect(results[1]).toEqual({ path: join(later, "Proj", "x.md"), kind: "file" });
	});

	it("drops a repeated name through a folder the reply named", async () => {
		const assets = join(dir, "site", "Assets");
		const project = join(dir, "project");
		await mkdir(assets, { recursive: true });
		await mkdir(project);
		await writeFile(join(assets, "logo.png"), "");
		const results = await resolveFileRefs({ refs: [`${assets}/`, "Assets/logo.png"], bases: [project] }, dir);
		expect(results[1]).toEqual({ path: join(assets, "logo.png"), kind: "file" });
	});

	it("matches abbreviations after a repeated name, and an ambiguous exact candidate still stops the search", async () => {
		const chat = join(dir, "Chat");
		await mkdir(chat);
		await writeFile(join(chat, "report_one.png"), "");
		expect(await resolveFileRefs({ refs: ["Chat/report_….png"], bases: [chat] }, dir)).toEqual([{ path: join(chat, "report_one.png"), kind: "file" }]);
		await mkdir(join(chat, "Chat"));
		for (const name of ["report_a.png", "report_b.png"]) await writeFile(join(chat, "Chat", name), "");
		expect(await resolveFileRefs({ refs: ["Chat/report_….png"], bases: [chat] }, dir)).toEqual([null]);
	});

	it.skipIf(process.platform === "win32")("keeps a backslash literal when dropping a repeated name outside Windows", async () => {
		const chat = join(dir, "Chat");
		await mkdir(join(chat, "sub"), { recursive: true });
		await writeFile(join(chat, "sub", "report.pdf"), "");
		expect(await resolveFileRefs({ refs: ["Chat/sub\\report.pdf"], bases: [chat] }, dir)).toEqual([null]);
	});

	it("bounds named directories and leaves duplicated names unresolved", async () => {
		const folders = ["f0", "f1", "f2", "f3", "f4", "f5"].map(name => join(dir, name));
		for (const folder of folders) {
			await mkdir(folder);
			await writeFile(join(folder, "x.md"), "");
		}
		const [oldest] = folders;
		await writeFile(join(oldest ?? "", "only-oldest.md"), "");
		const results = await resolveFileRefs({ refs: [...folders, "x.md", "only-oldest.md"], bases: [] }, dir);
		expect(results.at(-2)).toBeNull();
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
		await expect(resolveFileRefs({ refs: [], bases: [dir], toolBases: Array.from({ length: FILE_REF_LIMITS.bases }, () => dir) }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["a.md"], bases: ["relative/base"] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["a\0.md"], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["x".repeat(FILE_REF_LIMITS.length + 1)], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["\\\\server\\share\\a.md"], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: [""], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: [1], bases: [] }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["a.md"], bases: [], files: Array.from({ length: FILE_REF_LIMITS.files + 1 }, () => join(dir, "a.md")) }, dir)).rejects.toThrow();
		await expect(resolveFileRefs({ refs: ["a.md"], bases: [], files: ["relative/a.md"] }, dir)).rejects.toThrow();
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

	it("uses same-reply directory context for abbreviations and stops at an ambiguous folder", async () => {
		const [first, second, earlier, latest] = ["first", "second", "earlier", "latest"].map(name => join(dir, name));
		for (const folder of [first!, second!, earlier!, latest!]) {
			await mkdir(folder);
			await writeFile(join(folder, "report_one.png"), "");
		}
		const request = { refs: ["report_….png", earlier!, latest!, "report_….png"], bases: [first!, second!] };
		const results = await resolveFileRefs(request, dir);
		expect(results[0]?.path).toBe(join(latest!, "report_one.png"));
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

	it("preserves explicit targets across text blocks without guessing an ambiguous bare name", async () => {
		const blocks = [[`${a}/`, join(a, "report.pdf"), `${b}/`, join(b, "report.pdf")], ["report.pdf"]];
		await cache.load("chat\x001", "text", "", () => ({ blocks, bases: [] }));
		expect(paths(cache.read("chat\x001", "text", ""))).toEqual([[a, join(a, "report.pdf"), b, join(b, "report.pdf")], [null]]);
	});

	it("keeps replies with the same text in different chats apart", async () => {
		await cache.load("one\x001", "report.pdf", a, () => ({ blocks: [["report.pdf"]], bases: [a] }));
		await cache.load("two\x001", "report.pdf", b, () => ({ blocks: [["report.pdf"]], bases: [b] }));
		expect(paths(cache.read("one\x001", "report.pdf", a))).toEqual([[join(a, "report.pdf")]]);
		expect(paths(cache.read("two\x001", "report.pdf", b))).toEqual([[join(b, "report.pdf")]]);
	});

	it("reuses matching results and hides links immediately while changed candidates resolve", async () => {
		const source = (bases: string[]) => () => ({ blocks: [["report.pdf"]], bases });
		await cache.load("chat\x001", "report.pdf", a, source([a]));
		const first = cache.read("chat\x001", "report.pdf", a);
		// The saved entry that replaces a stream row asks again with the same reply, text and bases.
		expect(cache.load("chat\x001", "report.pdf", a, source([a]))).toBeNull();
		expect(cache.read("chat\x001", "report.pdf", a)).toBe(first);
		expect(calls).toBe(1);
		const pending = cache.load("chat\x001", "report.pdf", b, source([b]));
		expect(cache.read("chat\x001", "report.pdf", b)).toBeNull();
		await pending;
		expect(paths(cache.read("chat\x001", "report.pdf", b))).toEqual([[join(b, "report.pdf")]]);
		// Other text under the same key links nothing until it resolves.
		void cache.load("chat\x001", "other", b, source([b]));
		expect(cache.read("chat\x001", "other", b)).toBeNull();
	});

	it("reuses a stream result for its saved reply and invalidates changed tool bases", async () => {
		const source = (toolBases: string[]) => () => ({ blocks: [["report.pdf"]], bases: [], toolBases });
		await cache.load("chat\x00stream", "report.pdf", a, source([a]));
		const streamed = cache.read("chat\x00stream", "report.pdf", a);
		expect(paths(streamed)).toEqual([[join(a, "report.pdf")]]);
		expect(cache.load("chat\x00stream", "report.pdf", a, source([a]))).toBeNull();
		expect(cache.read("chat\x00stream", "report.pdf", a)).toBe(streamed);

		const changed = cache.load("chat\x00stream", "report.pdf", b, source([b]));
		expect(cache.read("chat\x00stream", "report.pdf", b)).toBeNull();
		expect(cache.read("chat\x00stream", "report.pdf", a)).toBeNull();
		await changed;
		expect(paths(cache.read("chat\x00stream", "report.pdf", b))).toEqual([[join(b, "report.pdf")]]);
	});

	it("removes a unique link before a deferred new candidate set is found ambiguous", async () => {
		const pending = Promise.withResolvers<({ path: string; kind: "file" } | null)[]>();
		let initial = true;
		const checked = new ReplyRefCache(async () => {
			if (initial) { initial = false; return [{ path: join(a, "report.pdf"), kind: "file" }]; }
			return pending.promise;
		});
		await checked.load("reply", "report.pdf", "one", () => ({ blocks: [["report.pdf"]], bases: [a] }));
		expect(checked.read("reply", "report.pdf", "one")?.[0]?.[0]?.path).toBe(join(a, "report.pdf"));
		const next = checked.load("reply", "report.pdf", "two", () => ({ blocks: [["report.pdf"]], bases: [a, b] }));
		expect(checked.read("reply", "report.pdf", "two")).toBeNull();
		expect(checked.read("reply", "report.pdf", "one")).toBeNull();
		pending.resolve([null]); await next;
		expect(checked.read("reply", "report.pdf", "two")).toEqual([[null]]);
	});
});
