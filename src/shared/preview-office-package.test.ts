import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, zipSync } from "fflate";
import { rewriteOfficePackage } from "./preview-office-package";
import { inflateOffice } from "./preview-office-inflate";
import { OFFICE_LIMITS, validateOfficeZip } from "./preview-office-zip";
import { safeOfficeLink } from "./preview-office-link";

const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function packageOf(parts: Record<string, string | Uint8Array> = {}) {
	return zipSync(Object.fromEntries(Object.entries({
		"[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		"word/document.xml": `<w:document xmlns:w="${word}" xmlns:r="${rel}"><w:body><w:p><w:r><w:t>Saved</w:t></w:r></w:p></w:body></w:document>`, ...parts,
	}).map(([key, value]) => [key, typeof value === "string" ? strToU8(value) : value])), { level: 6 });
}

describe("Office ZIP limits", () => {
	it("accepts complete ordinary ZIPs and distinguishes a truncated save", () => {
		const bytes = packageOf();
		expect(validateOfficeZip(bytes).ok).toBe(true);
		expect(validateOfficeZip(bytes.subarray(0, bytes.length - 8))).toEqual({ ok: false, reason: "incomplete" });
	});
	it.each(["../outside", "/absolute", "C:/absolute", "a\\b", "a/../b", "a/./b"])("rejects path %s", name => {
		expect(validateOfficeZip(packageOf({ [name]: "x" }))).toEqual({ ok: false, reason: "unsafe" });
	});
	it("rejects forged declared sizes before decompression", () => {
		const bytes = packageOf();
		const view = new DataView(bytes.buffer);
		const checked = validateOfficeZip(bytes);
		expect(checked.ok).toBe(true);
		const end = bytes.length - 22, central = view.getUint32(end + 16, true);
		view.setUint32(central + 24, OFFICE_LIMITS.entry + 1, true);
		expect(validateOfficeZip(bytes)).toEqual({ ok: false, reason: "unsafe" });
	});
	it("checks actual inflated output against lying central and local sizes", () => {
		const bytes = packageOf({ "large.txt": "a".repeat(50000) });
		const view = new DataView(bytes.buffer);
		let central = view.getUint32(bytes.length - 6, true);
		while (central < bytes.length - 22) {
			const offset = view.getUint32(central + 42, true);
			view.setUint32(central + 24, 1, true); view.setUint32(offset + 22, 1, true);
			central += 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
		}
		expect(() => inflateOffice(bytes)).toThrow("unsafe");
	});
	it("rejects encryption and ZIP64", () => {
		for (const flag of [1, 64, 8192]) {
			const bytes = packageOf(); const view = new DataView(bytes.buffer);
			view.setUint16(view.getUint32(bytes.length - 6, true) + 8, flag, true);
			view.setUint16(6, flag, true);
			expect(validateOfficeZip(bytes).ok).toBe(false);
		}
		const bytes = packageOf(); new DataView(bytes.buffer).setUint16(bytes.length - 12, 0xffff, true);
		expect(validateOfficeZip(bytes).ok).toBe(false);
	});
	it("rejects over 10000 entries", () => {
		const files = Object.fromEntries(Array.from({ length: 10001 }, (_, index) => [String(index), new Uint8Array()]));
		expect(validateOfficeZip(zipSync(files)).ok).toBe(false);
	});
	it("rejects total inflated declarations over 256 MiB and mismatched CRCs", () => {
		const bytes = packageOf({ a: "a", b: "b", c: "c", d: "d", e: "e" }), view = new DataView(bytes.buffer);
		let central = view.getUint32(bytes.length - 6, true);
		while (central < bytes.length - 22) {
			const offset = view.getUint32(central + 42, true);
			view.setUint32(central + 24, OFFICE_LIMITS.entry, true); view.setUint32(offset + 22, OFFICE_LIMITS.entry, true);
			central += 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
		}
		expect(validateOfficeZip(bytes)).toEqual({ ok: false, reason: "unsafe" });
		const corrupt = zipSync({ entry: strToU8("original") }, { level: 0 });
		corrupt[35] = corrupt[35]! ^ 1;
		expect(() => inflateOffice(corrupt)).toThrow("unsafe");
	});
});

describe("Office package rewrite before rendering", () => {
	it("removes external loads, altChunk, fields, OLE and ActiveX while retaining safe links", () => {
		const bytes = packageOf({
			"word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Type="${rel}/image" Target="https://example.test/leak.png" TargetMode="&#69;xternal"/><Relationship Id="link" Type="${rel}/hyperlink" Target="https://example.test/page" TargetMode="External"/><Relationship Id="bad" Type="${rel}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`,
			"word/document.xml": `<q:document xmlns:q="${word}" xmlns:r="${rel}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><q:body><q:p><q:r><q:drawing><a:blip r:link="image"/></q:drawing><q:instrText>INCLUDEPICTURE https://bad.test</q:instrText></q:r><q:hyperlink r:id="link"><q:r><q:t>Website</q:t></q:r></q:hyperlink><q:hyperlink r:id="bad"><q:r><q:t>Bad</q:t></q:r></q:hyperlink></q:p><q:altChunk r:id="alt"/><q:object/><q:control/></q:body></q:document>`,
			"word/activeX/activeX1.xml": "<x/>", "word/embeddings/object.bin": "payload", "word/afchunk.mht": "remote",
		});
		const rewritten = rewriteOfficePackage(bytes, "docx");
		const files = inflateOffice(rewritten.bytes);
		const xml = strFromU8(files["word/document.xml"]!);
		expect(xml).toContain("External image not loaded");
		expect(xml).not.toMatch(/INCLUDEPICTURE|altChunk|<q:object|<q:control|r:id=/);
		expect(xml).toContain("vomp-office-link-0");
		expect(rewritten.links).toEqual({ "vomp-office-link-0": "https://example.test/page" });
		expect(strFromU8(files["word/_rels/document.xml.rels"]!)).not.toMatch(/https:|javascript:|External/);
		expect(Object.keys(files)).not.toContain("word/embeddings/object.bin");
	});
	it("rejects DTDs, invalid XML, huge document XML and macros", () => {
		const cases: Record<string, string | Uint8Array>[] = [
			{ "word/document.xml": '<!DOCTYPE x [<!ENTITY e SYSTEM "https://bad.test">]><x/>' },
			{ "word/document.xml": "<x><broken></x>" },
			{ "word/vbaProject.bin": "macro" },
			{ "[Content_Types].xml": '<Types><Override ContentType="application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"/></Types>' },
			{ "word/document.xml": new Uint8Array(OFFICE_LIMITS.document + 1) },
		];
		for (const parts of cases) expect(() => rewriteOfficePackage(packageOf(parts), "docx")).toThrow("unsafe");
	});
	it("drops custom-named active parts by relationship and content type", () => {
		const bytes = packageOf({
			"word/_rels/document.xml.rels": `<Relationships><Relationship Id="html" Type="${rel}/aFChunk" Target="../custom/part.dat"/><Relationship Id="ole" Type="${rel}/oleObject" Target="../custom/object.dat"/></Relationships>`,
			"custom/part.dat": "<script>remote()</script>", "custom/object.dat": "OLE", "word/afchunk1.html": "active",
			"custom/control.xml": "<control/>",
			"[Content_Types].xml": '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/custom/control.xml" ContentType="application/vnd.ms-office.activeX+xml"/></Types>',
		});
		const files = inflateOffice(rewriteOfficePackage(bytes, "docx").bytes);
		for (const name of ["custom/part.dat", "custom/object.dat", "custom/control.xml", "word/afchunk1.html"]) expect(Object.hasOwn(files, name)).toBe(false);
	});
	it("makes PPTX external relationships empty internal targets", () => {
		const output = rewriteOfficePackage(packageOf({ "ppt/presentation.xml": "<presentation/>", "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="x" TargetMode="External" Target="http://127.0.0.1/leak" Type="image"/></Relationships>' }), "pptx");
		expect(strFromU8(inflateOffice(output.bytes)["ppt/_rels/presentation.xml.rels"]!)).toContain('Target=""');
		expect(strFromU8(inflateOffice(output.bytes)["ppt/_rels/presentation.xml.rels"]!)).not.toMatch(/External|127\.0/);
	});
	it.each(["javascript:alert(1)", "data:text/html,x", "file:///tmp/x", "//example.test", "https://example.test/\nfoo"])("rejects unsafe hyperlink %s", value => expect(safeOfficeLink(value)).toBe(false));
});

describe("Office XML and relationship boundary regressions", () => {
	it.each(["ppt/slides/slide1.xml", "custom/data.dat"])("rejects DTDs in retained XML part %s", name => {
		const bytes = packageOf({
			"ppt/presentation.xml": "<presentation/>",
			[name]: '<!DOCTYPE x [<!ENTITY remote SYSTEM "https://bad.test/entity">]><x/>',
			"[Content_Types].xml": `<Types><Override PartName="/${name}" ContentType="application/custom+xml"/></Types>`,
		});
		expect(() => rewriteOfficePackage(bytes, "pptx")).toThrow("unsafe");
	});
	it.each(["UTF-16", "ISO-8859-1"])("rejects unsupported declared XML encoding %s", encoding => {
		expect(() => rewriteOfficePackage(packageOf({ "ppt/presentation.xml": `<?xml version="1.0" encoding="${encoding}"?><presentation/>` }), "pptx")).toThrow("unsafe");
	});
	it("rejects UTF-16 and malformed UTF-8 bytes before declaration checks", () => {
		for (const bytes of [new Uint8Array(Array.from("<!DOCTYPE x><x/>").flatMap(char => [char.charCodeAt(0), 0])), new Uint8Array([0xff, 0xfe, 60, 0])]) {
			expect(() => rewriteOfficePackage(packageOf({ "ppt/presentation.xml": bytes }), "pptx")).toThrow("unsafe");
		}
	});
	it.each(["../../outside.xml", "%2e%2e/outside.xml", "../%2e%2e/outside.xml", "../media%2fimage.png", "../media%5cimage.png", "../%252e%252e/x", "..\\outside.xml", "../media/%00image.png", "file:///etc/passwd", "//example.test/image.png", "../media/image.png?remote=1"])("rejects internal target %s", target => {
		const escaped = target.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
		const bytes = packageOf({ "word/_rels/document.xml.rels": `<Relationships><Relationship Id="resource" Type="${rel}/image" Target="${escaped}"/></Relationships>` });
		expect(() => rewriteOfficePackage(bytes, "docx")).toThrow("unsafe");
	});
	it("preserves legitimate parent-relative references and rejects absent resources", () => {
		const parts = {
			"ppt/presentation.xml": "<presentation/>", "ppt/slides/slide1.xml": "<slide/>", "ppt/media/image.png": new Uint8Array([1]),
			"ppt/slides/_rels/slide1.xml.rels": `<Relationships><Relationship Id="image" Type="${rel}/image" Target="../media/image.png"/></Relationships>`,
		};
		const output = inflateOffice(rewriteOfficePackage(packageOf(parts), "pptx").bytes);
		expect(strFromU8(output["ppt/slides/_rels/slide1.xml.rels"]!)).toContain('Target="/ppt/media/image.png"');
		delete (parts as Record<string, unknown>)["ppt/media/image.png"];
		expect(() => rewriteOfficePackage(packageOf(parts), "pptx")).toThrow("unsafe");
	});
});

it.each(["../media/%C2%85image.png", "../media/%zz", "../media/%c0%ae.png"])("rejects Unicode controls or malformed escapes in internal target %s", target => {
	const bytes = packageOf({ "word/_rels/document.xml.rels": `<Relationships><Relationship Id="x" Type="${rel}/image" Target="${target}"/></Relationships>` });
	expect(() => rewriteOfficePackage(bytes, "docx")).toThrow("unsafe");
});
