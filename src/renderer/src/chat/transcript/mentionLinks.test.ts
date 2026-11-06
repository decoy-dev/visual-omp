// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { linkHtml, occurrences, parse } from "./fileLinkMarkup";
import { MentionText } from "./MentionText";
import { ComposerMirror } from "../composer/ComposerTags";

const labels = { home: null, row: (name: string, folder: string) => `${name} in ${folder}` };

describe("quoted transcript mentions", () => {
	it("paints a quoted spaced path as one complete composer chip", () => {
		const text = 'Read @"/tmp/Claude Design projects.zip" please';
		const mirror = parse(renderToStaticMarkup(createElement(ComposerMirror, { text, keywords: [] })));
		expect(mirror.querySelectorAll(".bg-accent-muted")).toHaveLength(1);
		expect(mirror.querySelector(".bg-accent-muted")?.textContent).toBe('@"/tmp/Claude Design projects.zip"');
		expect(mirror.textContent).toBe(text);
	});

	it.each(["/tmp/Claude Design projects.zip", "C:\\Users\\Jules\\My Files\\a.pdf", '/tmp/My "design".pdf'])("links %s as one file", path => {
		const quote = path.includes('"') ? "'" : '"';
		const text = `Read @${quote}${path}${quote} please.`;
		const html = `<p>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>`;
		expect(occurrences(parse(html)).map(found => found.ref)).toEqual([path]);
		const linked = parse(linkHtml(html, [{ kind: "file", path }], labels));
		const chips = linked.querySelectorAll(".tr-file-chip");
		expect(chips).toHaveLength(1);
		expect((chips[0] as HTMLElement).dataset.filePath).toBe(path);
		expect(chips[0]?.textContent).toBe(`@${quote}${path}${quote}`);
		expect(linked.textContent).toBe(text);
	});

	it("renders a mention-only paragraph as one row without quote delimiters in its target or name", () => {
		const path = "/tmp/Claude Design projects.zip";
		const linked = parse(linkHtml(`<p>@"${path}"</p>`, [{ kind: "file", path }], labels));
		expect(linked.querySelectorAll(".tr-file-row")).toHaveLength(1);
		expect(linked.querySelector(".tr-file-name")?.textContent).toBe("Claude Design projects.zip");
		expect((linked.querySelector(".tr-file-row") as HTMLElement).dataset.filePath).toBe(path);
	});

	it("groups the sent user bubble mention into one chip while preserving the full sent text", () => {
		const text = 'Read @"/tmp/Claude Design projects.zip" and me@example.com';
		const root = parse(renderToStaticMarkup(createElement(MentionText, { text })));
		expect(root.querySelectorAll(".bg-accent-muted")).toHaveLength(1);
		expect(root.querySelector(".bg-accent-muted")?.textContent).toBe('@"/tmp/Claude Design projects.zip"');
		expect(root.textContent).toBe(text);
	});

	it.each(["@file", '@"My Files/a.pdf"'])("keeps %s literal inside a fenced block without decorating its colors", mention => {
		const text = `@outside.ts\n\`\`\`text\n${mention}\n#abcdef\n\`\`\``;
		const root = parse(renderToStaticMarkup(createElement(MentionText, { text })));
		expect(root.querySelectorAll(".bg-accent-muted")).toHaveLength(1);
		expect(root.querySelector(".bg-accent-muted")?.textContent).toBe("@outside.ts");
		expect(root.querySelectorAll(".vomp-color-swatch")).toHaveLength(0);
		expect(root.textContent).toBe(text);
	});

	it.each(["@file", '@"My Files/a.pdf"'])("keeps %s literal inside inline code and retains short-form color handling", mention => {
		const text = `@outside.ts \`${mention} #abc #abcdef\``;
		const root = parse(renderToStaticMarkup(createElement(MentionText, { text })));
		expect(root.querySelectorAll(".bg-accent-muted")).toHaveLength(1);
		expect(root.querySelector(".bg-accent-muted")?.textContent).toBe("@outside.ts");
		expect(root.querySelectorAll(".vomp-color-swatch")).toHaveLength(2);
		expect(root.textContent).toBe(text);
	});
});
