import { describe, expect, it } from "vitest";
import { fileRefOf, textRefs } from "./fileRefs";

const refs = (text: string) => textRefs(text).map(found => found.ref);

describe("fileRefOf", () => {
	it("accepts path forms and bare names with an extension", () => {
		for (const ref of [
			"~/Downloads/OffboardingHappens-Flyer-2026/",
			"/Users/me/notes.txt",
			"./build/out.pdf",
			"../shared/ipc.ts",
			"src/main/index.ts",
			"previews/",
			"CONTEXT.md",
			"OffboardingHappens-Flyer-2026-PRINT-18x6-bifold-bleed.pdf",
			"clip.mp4",
			"main.c",
			".env",
			"C:\\Users\\me\\report.docx",
			"C:/Users/me/",
			"src\\renderer\\App.tsx",
		]) {
			expect(fileRefOf(ref, false), ref).toBe(ref);
		}
	});

	it("refuses words, numbers, abbreviations and non-path syntax", () => {
		for (const word of ["1.2.3", "v0.3.1", "0.4s", "1.25", "e.g", "i.e", "U.S", "README", "~", "~/", "/", "./", "24/7", "1/2", "a//b", "C:"]) {
			expect(fileRefOf(word, false), word).toBeNull();
		}
		for (const code of ["app:openExternal", "https://example.com/a.md", "xd://generate_image", "\\\\server\\share\\a.md", "//cdn/a.js"]) {
			expect(fileRefOf(code, true), code).toBeNull();
		}
	});

	it("drops a line citation from the path", () => {
		expect(fileRefOf("src/app.ts:12", true)).toBe("src/app.ts");
		expect(fileRefOf("src/app.ts:12:5", true)).toBe("src/app.ts");
		expect(fileRefOf("notes.md:50-100", true)).toBe("notes.md");
		expect(fileRefOf("C:\\x\\a.ts:3", true)).toBe("C:\\x\\a.ts");
	});

	it("allows spaces in code spans but refuses commands, globs and padding", () => {
		expect(fileRefOf("~/Downloads/My Flyer.pdf", true)).toBe("~/Downloads/My Flyer.pdf");
		expect(fileRefOf("Report (final).pdf", true)).toBe("Report (final).pdf");
		for (const code of ["npm run dev", "src/**/*.ts", "cd ~/x && ls", "a.md | wc", "$HOME/x.md", " a.md", "a  b.md", "x = a.md", "obj.method()"]) {
			expect(fileRefOf(code, true), code).toBeNull();
		}
	});
});

describe("textRefs", () => {
	it("finds the references in the reply that prompted links", () => {
		expect(refs("Files are in ~/Downloads/OffboardingHappens-Flyer-2026/, and CONTEXT.md is updated:")).toEqual([
			"~/Downloads/OffboardingHappens-Flyer-2026/",
			"CONTEXT.md",
		]);
		expect(refs("OffboardingHappens-Flyer-2026-DIGITAL.pdf")).toEqual(["OffboardingHappens-Flyer-2026-DIGITAL.pdf"]);
		expect(refs("previews/")).toEqual(["previews/"]);
	});

	it("keeps sentence punctuation outside the link and ignores ordinary prose", () => {
		const text = "See notes.md. Also (src/a.ts:4), e.g. version 1.2.3 at 0.4s, Python 3 and/or more.";
		expect(textRefs(text).map(found => text.slice(found.start, found.end))).toEqual(["notes.md", "src/a.ts:4", "and/or"]);
		expect(refs("The PDFs are fully vector, 18×6 inches, and the QR code scans: it works!")).toEqual([]);
		expect(refs("Open \"report.pdf\" or 'deck.key'?")).toEqual(["report.pdf", "deck.key"]);
	});

	it("refuses URL-like and colon words in prose", () => {
		expect(refs("Note:CONTEXT.md mailto:a@b.co http://x.com/a.md")).toEqual([]);
	});
});
