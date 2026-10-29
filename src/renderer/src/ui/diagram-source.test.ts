// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "./diagram-source";

const palette = { fg: "rgb(10, 20, 30)", accent: "rgb(20, 100, 90)", c1: "rgb(20, 100, 90)" };

describe("self-contained SVG figures", () => {
	it("preserves geometry, local definitions and currentColor, and resolves omp theme tokens", () => {
		const svg = sanitizeSvg('<svg viewBox="0 0 200 100"><defs><marker id="arrow"><path d="M0 0L5 5"/></marker></defs><path stroke="var(--accent)" marker-end="url(#arrow)" d="M0 0L50 50"/><text fill="currentColor">A</text><rect fill="var(--c1)"/></svg>', palette);
		expect(svg).toContain('viewBox="0 0 200 100"');
		expect(svg).toContain('marker-end="url(#arrow)"');
		expect(svg).toContain('stroke="rgb(20, 100, 90)"');
		expect(svg).toContain('fill="currentColor"');
		expect(svg).toContain('color="rgb(10, 20, 30)"');
	});

	it("removes script, animation, foreignObject, external references and event handlers", () => {
		const svg = sanitizeSvg('<svg onload="alert(1)"><script>alert(1)</script><foreignObject><div>HTML</div></foreignObject><animate attributeName="x"/><image href="https://example.com/image"/><use href="https://example.com/a.svg#x"/><a href="javascript:alert(1)"><text>link</text></a><rect onclick="alert(1)" fill="url(https://example.com/x)"/></svg>', palette);
		expect(svg).not.toMatch(/script|foreignObject|animate|image|onload|onclick|https:\/\/example|javascript/);
		expect(svg).toContain("<rect");
	});

	it("refuses stylesheet network requests and CSS escape bypasses", () => {
		const svg = sanitizeSvg('<svg><style>@import "https://example.com/font";</style><rect style="fill: u\\72l(https://example.com/x)"/><path style="stroke:var(--accent);fill:none"/></svg>', palette);
		expect(svg).not.toContain("example.com");
		expect(svg).not.toContain("<style");
		expect(svg).toContain("stroke:rgb(20, 100, 90);fill:none");
	});

	it("rejects entity declarations and non-SVG roots", () => {
		expect(sanitizeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>', palette)).toBeNull();
		expect(sanitizeSvg("<html><body>text</body></html>", palette)).toBeNull();
	});

	it("keeps static Mermaid CSS when its stylesheet also contains animation keyframes", () => {
		const svg = sanitizeSvg('<svg><style>@keyframes dash { to { stroke-dashoffset:0 } } .node > rect { fill:var(--accent);stroke:currentColor;animation:dash 1s infinite } .label { fill:var(--fg) }</style><g class="node"><rect/></g><text class="label">Request</text></svg>', palette);
		expect(svg).toContain("<style>");
		expect(svg).toContain("rgb(20, 100, 90)");
		expect(svg).toContain(".label");
		expect(svg).not.toContain("@keyframes");
		expect(svg).not.toContain("animation:");
	});

	it("uses the foreground for unknown theme variables without trusting their fallback", () => {
		expect(sanitizeSvg('<svg><rect fill="var(--unknown, red)"/></svg>', palette)).toContain('fill="rgb(10, 20, 30)"');
	});
});
