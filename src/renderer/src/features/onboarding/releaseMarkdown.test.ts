import { describe, expect, it } from "vitest";
import { renderReleaseMarkdown } from "./releaseMarkdown";

describe("release Markdown", () => {
	it("renders the overview, categorized highlights and detailed headings", () => {
		const html = renderReleaseMarkdown("Review changes before installing.\n\n### Highlights\n\n- **New:** Read notes here.\n\n### Detailed changes\n\n#### Fixed\n\n- Preserve old notes.");
		expect(html).toContain("<p>Review changes before installing.</p>");
		expect(html).toContain("<h3>Highlights</h3>");
		expect(html).toContain("<strong>New:</strong>");
		expect(html).toContain("<h3>Detailed changes</h3>");
		expect(html).toContain("<h4>Fixed</h4>");
	});

	it("escapes raw HTML, including details, scripts, frames and event handlers", () => {
		const html = renderReleaseMarkdown('<details><summary>More</summary><script>alert(1)</script><img src=x onerror=alert(1)><iframe src="https://example.com"></iframe></details>');
		expect(html).not.toMatch(/<(?:details|summary|script|img|iframe)\b/);
		expect(html).toContain("&lt;details&gt;");
	});

	it("never emits images or unsafe links", () => {
		const html = renderReleaseMarkdown('![Release diagram](https://example.com/tracker.png)\n\n[Unsafe](javascript:alert%281%29) [Data](data:text/html,test) [Safe](https://github.com/decoy-dev/visual-omp/releases)');
		expect(html).not.toContain("<img");
		expect(html).not.toContain("tracker.png");
		expect(html).not.toContain('href="javascript:');
		expect(html).not.toContain('href="data:');
		expect(html).toContain("Release diagram");
		expect(html).toContain('href="https://github.com/decoy-dev/visual-omp/releases"');
	});

	it("contains wide tables in the existing scrolling frame without generating diagrams or loading images", () => {
		const html = renderReleaseMarkdown([
			"| Setting | Previous behavior | New behavior |",
			"| --- | --- | --- |",
			"| ![Reference](https://example.com/tracker.png) | A long previous behavior. | A long new behavior. |",
			"",
			"```mermaid",
			"graph TD; A-->B;",
			"```",
		].join("\n"));
		expect(html).toContain('<div class="tr-table"><table>');
		expect(html).toContain("</table>\n</div>");
		expect(html).toContain("<th>Previous behavior</th>");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("tracker.png");
		expect(html).not.toContain("vomp-chart");
		expect(html).not.toContain("vomp-diagram");
		expect(html).toContain('class="language-mermaid"');
	});
});
