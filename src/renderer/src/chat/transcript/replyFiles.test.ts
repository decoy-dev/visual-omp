// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../transcript/render";
import { linkHtml, occurrences, parse } from "./fileLinkMarkup";

const directory = "ReadyCloud Files/ReadyReturns Chat Demos/Videos/";
const names = ["FootLocker Return Chat v2.mp4", "Dicks Sporting Goods Return Chat.mp4"];
const source = `I've rendered both videos. They're in \`${directory}\`:\n\n- \`${names[0]}\`\n- \`${names[1]}\``;
const labels = { home: null, row: (name: string, folder: string) => `Open ${name} in ${folder}` };

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
