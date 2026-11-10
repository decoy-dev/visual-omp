// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../../transcript/render";
import { linkHtml, occurrences, parse } from "./fileLinkMarkup";

const directory = "ReadyCloud Files/ReadyReturns Chat Demos/Videos/";
const names = ["FootLocker Return Chat v2.mp4", "Dicks Sporting Goods Return Chat.mp4"];
const source = `I've rendered both videos. They're in \`${directory}\`:\n\n- \`${names[0]}\`\n- \`${names[1]}\``;
const labels = { projectPath: "/project", row: (name: string, path: string) => `Open ${name}, ${path}` };
afterEach(() => vi.unstubAllGlobals());

describe("reply file markup", () => {
	it("keeps the owner's exact spaced directory and bare names as whole references and file rows", () => {
		const html = renderMarkdown(source);
		expect(occurrences(parse(html)).map(item => item.ref)).toEqual([directory, ...names]);
		const folder = `/project/${directory.slice(0, -1)}`;
		const linked = parse(linkHtml(html, [{ path: folder, kind: "folder" }, ...names.map(name => ({ path: `${folder}/${name}`, kind: "file" as const }))], labels));
		expect(linked.querySelector(".tr-file-chip")?.getAttribute("data-file-kind")).toBe("folder");
		expect([...linked.querySelectorAll(".tr-file-row")].map(row => row.getAttribute("data-file-path"))).toEqual(names.map(name => `${folder}/${name}`));
		expect([...linked.querySelectorAll(".tr-file-name")].slice(1).map(node => node.textContent)).toEqual(names);
		expect(linked.querySelector("ul")?.classList.contains("tr-file-list")).toBe(true);
		expect([...linked.querySelectorAll(".tr-file-folder")].map(node => node.textContent)).toEqual(names.map(name => `${directory}${name}`));
		expect([...linked.querySelectorAll(".tr-file-row")].map(node => node.getAttribute("title"))).toEqual(names.map(name => `${folder}/${name}`));
	});

	it.each([
		["/project", "/project/Large Media Files/Large video.mp4", "Large Media Files/Large video.mp4"],
		["/project/", "/project/notes.txt", "notes.txt"],
		["/project", "/project-other/Large video.mp4", "/project-other/Large video.mp4"],
		["/project", "/home/user/Large video.mp4", "/home/user/Large video.mp4"],
		["C:\\Project", "C:\\Project\\Large Media Files\\Large video.mp4", "Large Media Files/Large video.mp4"],
		["C:\\Project", "D:\\Media\\Large video.mp4", "D:\\Media\\Large video.mp4"],
	] as const)("shows %s-relative labels without changing the target %s", (projectPath, path, shown) => {
		const html = renderMarkdown("- `Large video.mp4`");
		const linked = parse(linkHtml(html, [{ path, kind: "file" }], { ...labels, projectPath }));
		const row = linked.querySelector<HTMLElement>(".tr-file-row")!;
		expect(row.querySelector(".tr-file-folder")?.textContent).toBe(shown);
		expect(row.getAttribute("aria-label")).toContain(shown);
		expect(row.title).toBe(path);
		expect(row.dataset.filePath).toBe(path);
	});

	it.each([
		["/var/folders/tour/project", "/private/var/folders/tour/project/Large video.mp4", null, "Large video.mp4"],
		["/opened/project", "/real/project/Media/Large video.mp4", "/real/project", "Media/Large video.mp4"],
		["/opened/project", "/real/project-other/Large video.mp4", "/real/project", "/real/project-other/Large video.mp4"],
		["/opened/project", "/real/project/Large video.mp4", null, "/real/project/Large video.mp4"],
	] as const)("uses verified project identity for %s while keeping absolute targets", (projectPath, path, canonicalProjectPath, shown) => {
		vi.stubGlobal("vomp", { platform: "darwin" });
		const linked = parse(linkHtml(renderMarkdown("- `Large video.mp4`"), [{ path, kind: "file" }], { ...labels, projectPath, canonicalProjectPath }));
		const row = linked.querySelector<HTMLElement>(".tr-file-row")!;
		expect(row.querySelector(".tr-file-folder")?.textContent).toBe(shown);
		expect(row.title).toBe(path); expect(row.dataset.filePath).toBe(path);
	});

	it("leaves ambiguous and missing names as literal code when main returns no target", () => {
		const html = renderMarkdown("- `Shared Return Chat.mp4`\n- `Missing Return Chat.mp4`");
		const linked = parse(linkHtml(html, [null, null], labels));
		expect(linked.querySelector(".tr-file")).toBeNull();
		expect([...linked.querySelectorAll("code")].map(code => code.textContent)).toEqual(["Shared Return Chat.mp4", "Missing Return Chat.mp4"]);
	});

	it("resolves a decorated inline code name once without dropping its full text or row presentation", () => {
		const html = renderMarkdown("- `Video #fff.mp4`");
		const root = parse(html);
		expect(root.querySelector(".vomp-color-swatch")).not.toBeNull();
		expect(occurrences(root).map(item => item.ref)).toEqual(["Video #fff.mp4"]);
		const linked = parse(linkHtml(html, [{ path: "/project/Video #fff.mp4", kind: "file" }], labels));
		expect(linked.querySelector(".tr-file-row")?.getAttribute("data-file-path")).toBe("/project/Video #fff.mp4");
		expect(linked.querySelector(".tr-file-name")?.textContent).toBe("Video #fff.mp4");
	});
});
