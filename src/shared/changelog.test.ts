import { describe, expect, it } from "vitest";
import { parseChangelog } from "./changelog";

const body = `This update makes release notes available before installation.

### Highlights

- **New:** Read release notes in the app.
- **Fixed:** Older notes remain available offline.

### Detailed changes

#### New

- The update notice opens the release viewer.

#### Fixed

- The installed changelog provides older notes.`;

describe("CHANGELOG release sections", () => {
	it("preserves the overview, highlights and detailed entries exactly", () => {
		const source = `# Changelog\n\n## [Unreleased]\n\nNot published.\n\n## [0.8.0] - 2026-11-01\n\n${body}\n\n## [0.7.0] - 2026-10-29\n\nOlder notes.\n`;
		expect(parseChangelog(source)).toEqual([
			{ version: "0.8.0", date: "2026-11-01", body },
			{ version: "0.7.0", date: "2026-10-29", body: "Older notes." },
		]);
		expect(parseChangelog(source.replaceAll("\n", "\r\n"))[0]?.body).toBe(body);
	});

	it("keeps headings inside fenced code, including longer fences and tilde fences", () => {
		const source = "## [1.0.0]\n\nOverview.\n\n````markdown\n## [9.0.0]\n```\n````\n\n~~~md\n## [8.0.0]\n~~~\n\n## [0.9.0]\n\nEarlier.";
		expect(parseChangelog(source).map(section => section.version)).toEqual(["1.0.0", "0.9.0"]);
		expect(parseChangelog(source)[0]?.body).toContain("## [9.0.0]");
	});

	it("matches exact version headings and retains empty sections for the release script to reject", () => {
		expect(parseChangelog("## [0.8.0-beta.1]\n\nBeta.\n\n## [0.8.0]\n\n")).toEqual([
			{ version: "0.8.0-beta.1", date: null, body: "Beta." },
			{ version: "0.8.0", date: null, body: "" },
		]);
	});
});
