import changelog from "../../CHANGELOG.md?raw";
import { describe, expect, it } from "vitest";
import { parseChangelog } from "./changelog";
import { orderReleaseHighlights, parseReleaseHighlights, RELEASE_HIGHLIGHT_CATEGORIES, releaseHighlightWarnings, sortReleaseHighlights } from "./releaseHighlights";

const sample = `Overview with [a link](https://example.com).

### Highlights

> [!IMPORTANT]
> Update if you run long chats.
> Keep your saved chats available.

- **Fixed:** **Chats recover after disconnects.** Continue sending messages.
- **New:** **Bash execution details.** See command values.
- **Fixed:** Keep queued messages available.
- **Changed:** Require the current omp version.

### Detailed changes

#### Changed

- Keep this authored order.
- **New:** This detailed bullet is unchanged.
`;

const releases = parseChangelog(changelog);

describe("release Highlights", () => {
	it("extracts overview, a multiline notice, headline titles and ordinary category items", () => {
		const parsed = parseReleaseHighlights(sample)!;
		expect(parsed.overview).toBe("Overview with [a link](https://example.com).");
		expect(parsed.notice).toEqual({ kind: "IMPORTANT", body: "Update if you run long chats.\nKeep your saved chats available." });
		expect(parsed.headlines).toEqual([
			{ category: "New", title: "Bash execution details.", body: "See command values." },
			{ category: "Fixed", title: "Chats recover after disconnects.", body: "Continue sending messages." },
		]);
		expect(parsed.groups).toEqual([
			{ category: "Changed", items: [{ category: "Changed", title: null, body: "Require the current omp version." }] },
			{ category: "Fixed", items: [{ category: "Fixed", title: null, body: "Keep queued messages available." }] },
		]);
		expect(parsed.remaining).toBe("");
		expect(parsed.detailed).toBe(sample.slice(sample.indexOf("### Detailed changes")));
		expect(parsed.warnings).toEqual([]);
	});

	it.each(["IMPORTANT", "WARNING", "CAUTION", "NOTE", "TIP"])("recognizes the %s alert", kind => {
		expect(parseReleaseHighlights(sample.replace("[!IMPORTANT]", `[!${kind}]`))?.notice?.kind).toBe(kind);
	});

	it("splits only a bold title ending in a period", () => {
		const parsed = parseReleaseHighlights("### Highlights\n\n- **New:** **A title without punctuation** stays in the body.\n- **Fixed:** **A complete title.**\n");
		expect(parsed?.groups[0]?.items[0]?.body).toBe("**A title without punctuation** stays in the body.");
		expect(parsed?.headlines[0]).toEqual({ category: "Fixed", title: "A complete title.", body: "" });
	});

	it("keeps unknown category labels and authored order after known categories", () => {
		const parsed = parseReleaseHighlights("### Highlights\n\n- **Other:** First.\n- **Fixed:** A repair.\n- **Experimental:** Second.\n- **Other:** Third.\n");
		expect(parsed?.groups.map(group => group.category)).toEqual(["Fixed", "Other", "Experimental", "Other"]);
		expect(parsed?.groups.slice(1).flatMap(group => group.items.map(item => item.body))).toEqual(["First.", "Second.", "Third."]);
		expect(parsed?.warnings).toEqual(["Unknown Highlights category: Other.", "Unknown Highlights category: Experimental."]);
	});

	it("keeps unstructured Highlights content and additional notices readable", () => {
		const parsed = parseReleaseHighlights("### Highlights\n\nA paragraph.\n\n> [!WARNING]\n> First.\n\n- **New:** A feature.\n\n> [!CAUTION]\n> Second.\n\n- Ordinary bullet.\n");
		expect(parsed?.remaining).toContain("A paragraph.");
		expect(parsed?.remaining).toContain("> [!CAUTION]\n> Second.");
		expect(parsed?.remaining).toContain("- Ordinary bullet.");
		expect(parsed?.warnings).toContain("Highlights has 2 notices; use at most 1.");
	});

	it("preserves multiline bullet content", () => {
		expect(parseReleaseHighlights("### Highlights\n\n- **Fixed:** A repair.\n  More context.\n\n  - A nested item.\n")?.groups[0]?.items[0]?.body).toBe("A repair.\nMore context.\n\n- A nested item.");
	});

	it("returns null when Highlights or recognizable category bullets are absent", () => {
		for (const body of ["Legacy body.\n\n## Fixed\n\n- A repair.", "### Highlights\n\n- A repair.", "### Highlights\n\n> [!IMPORTANT]\n> Update now."]) {
			expect(parseReleaseHighlights(body)).toBeNull();
			expect(orderReleaseHighlights(body)).toBe(body);
		}
	});

	it("does not parse fenced examples as section headings or bullets", () => {
		expect(parseReleaseHighlights("````md\n### Highlights\n- **New:** Example.\n```\n````")).toBeNull();
		const parsed = parseReleaseHighlights("### Highlights\n\n~~~md\n- **New:** Example.\n~~~\n\n- **Fixed:** Repair.\n");
		expect(parsed?.groups.map(group => group.category)).toEqual(["Fixed"]);
		expect(parsed?.remaining).toContain("- **New:** Example.");
	});

	it("parses CRLF and preserves original line endings when ordering", () => {
		const windows = sample.replaceAll("\n", "\r\n");
		expect(parseReleaseHighlights(windows)?.headlines).toEqual(parseReleaseHighlights(sample)?.headlines);
		expect(orderReleaseHighlights(windows)).toBe(orderReleaseHighlights(sample).replaceAll("\n", "\r\n"));
	});

	it("uses canonical order while retaining same-category and unknown-item order", () => {
		const categories = ["Other", "Fixed", "New", "Fixed", "Changed", "Removed", "Security", "Improved", "Experimental"];
		const sorted = sortReleaseHighlights(categories.map((category, index) => ({ category, title: null, body: String(index) })));
		expect(sorted.map(item => item.category)).toEqual([...RELEASE_HIGHLIGHT_CATEGORIES.slice(0, 4), "Fixed", "Fixed", "Removed", "Other", "Experimental"]);
		expect(sorted.filter(item => item.category === "Fixed").map(item => item.body)).toEqual(["1", "3"]);
	});

	it("reorders raw bullets and keeps notices first without modifying surrounding Markdown", () => {
		const ordered = orderReleaseHighlights(sample);
		expect(ordered.slice(0, ordered.indexOf("### Highlights"))).toBe(sample.slice(0, sample.indexOf("### Highlights")));
		expect(ordered.slice(ordered.indexOf("### Detailed changes"))).toBe(sample.slice(sample.indexOf("### Detailed changes")));
		expect(ordered.indexOf("> [!IMPORTANT]")).toBeLessThan(ordered.indexOf("- **New:**"));
		expect(ordered.indexOf("- **New:**")).toBeLessThan(ordered.indexOf("- **Changed:**"));
		expect(ordered.indexOf("- **Changed:**")).toBeLessThan(ordered.indexOf("- **Fixed:**"));
		expect(orderReleaseHighlights(ordered)).toBe(ordered);
	});

	it("warns about too many headlines without discarding any", () => {
		const parsed = parseReleaseHighlights(`${sample.replace("### Detailed changes", "- **Improved:** **Another headline title.** More context.\n\n### Detailed changes")}`);
		expect(parsed?.headlines).toHaveLength(3);
		expect(parsed?.warnings).toContain("Highlights has 3 headlines; use at most 2.");
	});

	it.each(["0.7.10", "0.7.9", "0.7.0", "0.6.8"])("parses the published-format %s section", version => {
		const body = releases.find(release => release.version === version)!.body;
		const parsed = parseReleaseHighlights(body)!;
		expect(parsed).not.toBeNull();
		expect(parsed.groups.length).toBeGreaterThan(0);
		expect(parsed.warnings).toEqual([]);
		if (["0.7.0", "0.6.8"].includes(version)) expect(parsed.groups.some(group => group.category === "Changed")).toBe(true);
	});

	it("keeps a published legacy body on the ordinary Markdown path", () => {
		expect(parseReleaseHighlights(releases.find(release => release.version === "0.6.7")!.body)).toBeNull();
	});

	it("validates notice limits even without category bullets", () => {
		const source = "### Highlights\n\n> [!WARNING]\n> First.\n\n> [!CAUTION]\n> Second.";
		expect(parseReleaseHighlights(source)).toBeNull();
		expect(releaseHighlightWarnings(source)).toEqual(["Highlights has 2 notices; use at most 1."]);
	});

	it("validates categories and marker limits in the newest released and Unreleased sections", () => {
		const newest = releases[0]!;
		const unreleased = parseChangelog(changelog.replace(/^## \[Unreleased\]/m, "## [0.0.0-unreleased]"))[0]!;
		for (const section of [newest, unreleased]) {
			expect(releaseHighlightWarnings(section.body), section.version).toEqual([]);
		}
	});
});
