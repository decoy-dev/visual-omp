import { describe, expect, it } from "vitest";
import { exportFileName, parseExportOutput, parseShareOutput } from "./share";

describe("parseShareOutput", () => {
	it("reads the share URL, gist and truncation note", () => {
		const stdout =
			"Share URL: https://share.omp.sh/s/abc#key\nGist: https://gist.github.com/u/123\nNote: large content was trimmed to fit the share size limit.\n";
		expect(parseShareOutput(stdout)).toEqual({
			url: "https://share.omp.sh/s/abc#key",
			gistUrl: "https://gist.github.com/u/123",
			truncated: true,
		});
	});

	it("returns null when omp printed no link", () => {
		expect(parseShareOutput("")).toBeNull();
	});
});

describe("parseExportOutput", () => {
	it("keeps spaces in the exported path (real omp 18.4.4 output)", () => {
		expect(parseExportOutput("Exported to: /tmp/vomp-test/out dir/x.html\n")).toBe("/tmp/vomp-test/out dir/x.html");
	});
});

describe("exportFileName", () => {
	it("sanitizes titles and falls back to the session id", () => {
		expect(exportFileName("Fix: CI / lint?", "0123456789")).toBe("Fix CI lint.html");
		expect(exportFileName(null, "0123456789")).toBe("omp-session-01234567.html");
		expect(exportFileName(" ... ", "abcdef12xyz")).toBe("omp-session-abcdef12.html");
	});
});
