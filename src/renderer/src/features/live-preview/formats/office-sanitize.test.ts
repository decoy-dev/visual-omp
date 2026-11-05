// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { sanitizeOfficeCss, sanitizeOfficeDom } from "./office-sanitize";

describe("DOCX post-render sanitizer", () => {
	it("removes active content and namespace-based escapes before attachment", () => {
		const body = document.createElement("div"), styles = document.createElement("div");
		body.innerHTML = '<script>alert(1)</script><iframe></iframe><object></object><embed><link href="https://bad.test"><meta><base><form><input></form><svg><image href="https://bad.test"/></svg><math><mtext>bad</mtext></math><style>body{color:red}</style><p onclick="bad()" onmouseover="bad()" data-remote="x">Safe</p>';
		styles.innerHTML = '<style>@import "https://bad.test/s.css";p{background:url(https://bad.test/leak);color:red}</style>';
		sanitizeOfficeDom(body, styles);
		expect(body.innerHTML).toBe("<p>Safe</p>");
		expect(styles.textContent).not.toContain("https:");
		expect(styles.querySelector("style")).not.toBeNull();
	});
	it("allows raster data images and safe hyperlinks only", () => {
		const body = document.createElement("div"), styles = document.createElement("div");
		body.innerHTML = '<img src="https://bad.test/image" srcset="https://bad.test/2x 2x" onerror="bad()"><img src="data:image/svg+xml;base64,PHN2Zy8+"><img src="data:image/png;base64,iVBORw0KGgo="><a href="javascript:bad()">Bad</a><a href="#vomp-office-link-0">Web</a><a href="mailto:person@example.test">Mail</a><a href="#bookmark">Local</a>';
		sanitizeOfficeDom(body, styles, { "vomp-office-link-0": "https://example.test/page" });
		expect(Array.from(body.querySelectorAll("img")).map(image => image.getAttribute("src"))).toEqual([null, null, "data:image/png;base64,iVBORw0KGgo="]);
		expect(body.querySelector("[srcset],[onerror]")).toBeNull();
		expect(Array.from(body.querySelectorAll("a")).map(link => link.getAttribute("href"))).toEqual([null, "https://example.test/page", "mailto:person@example.test", "#bookmark"]);
	});
	it.each([
		'p{background:u\\72l(https://bad.test)}',
		'p{background:u/**/rl(https://bad.test)}',
		'p{background:image-set("https://bad.test/a" 1x)}',
		'@import url("https://bad.test");p{color:red}',
		'p{--load:url(https://bad.test);background:var(--load)}',
	])("neutralizes CSS resource encodings: %s", css => expect(sanitizeOfficeCss(css)).not.toContain("https:"));
	it("retains inline raster data and ordinary layout declarations", () => {
		expect(sanitizeOfficeCss('p{background:url("data:image/png;base64,YQ==");color:red}')).toContain("data:image/png");
		expect(sanitizeOfficeCss("font-size:12pt;text-align:center")).toBe("font-size:12pt;text-align:center");
	});
	it("does not resolve inherited object properties as hyperlink targets", () => {
		const body = document.createElement("div");
		body.innerHTML = '<a href="#constructor">Bookmark</a><a href="#__proto__">Other bookmark</a>';
		sanitizeOfficeDom(body, document.createElement("div"), {});
		expect(Array.from(body.querySelectorAll("a")).map(link => link.getAttribute("href"))).toEqual(["#constructor", "#__proto__"]);
	});
});
