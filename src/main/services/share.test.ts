import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultExportPlan, exportFileName, parseAnonymizeOutput, parseExportOutput, parseShareOutput, parseTransferOutput } from "./share";

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
	it("preserves a Windows drive and spaces with CRLF", () => {
		expect(parseExportOutput("Exported to: C:\\Users\\A User\\chat.html\r\n")).toBe("C:\\Users\\A User\\chat.html");
	});
	it.each(["", "Exported to:\nnot a path", "Exported to: \r\n", "Failed to export session: EEXIST"])("rejects missing completion paths: %j", stdout => {
		expect(parseExportOutput(stdout)).toBeNull();
	});
});

describe("defaultExportPlan", () => {
	it.each([
		["darwin", "/sessions/2026-11-05_id.jsonl", "/project/sub/..", "/project/omp-session-2026-11-05_id.html"],
		["linux", "/sessions/session.jsonl", "/project", "/project/omp-session-session.html"],
		["win32", "C:\\sessions\\2026-11-05_id.jsonl", "C:\\project\\sub\\..", "C:\\project\\omp-session-2026-11-05_id.html"],
		["win32", "\\\\server\\share\\sessions\\chat.jsonl", "\\\\server\\share\\project", "\\\\server\\share\\project\\omp-session-chat.html"],
	] as const)("uses an absolute default path on %s", (platform, file, cwd, path) => {
		expect(defaultExportPlan(file, cwd, false, platform)).toEqual({ path, command: `/export ${path}` });
		expect(defaultExportPlan(file, cwd, true, platform)).toEqual({ path, command: `/export --themes ${path}` });
	});

	it.each([
		["darwin", "/sessions/chat.jsonl", "/project folder", "/project folder/omp-session-chat.html"],
		["win32", "C:\\sessions\\chat.jsonl", "C:\\Users\\A User", "C:\\Users\\A User\\omp-session-chat.html"],
		["darwin", "/sessions/chat name.jsonl", "/project", "/project/omp-session-chat name.html"],
		["win32", "C:\\sessions\\chat name.jsonl", "C:\\project", "C:\\project\\omp-session-chat name.html"],
		["linux", "/sessions/chat.jsonl", "/project\tfolder", "/project\tfolder/omp-session-chat.html"],
	] as const)("chooses CLI export for whitespace on %s", (platform, file, cwd, path) => {
		for (const themes of [false, true]) expect(defaultExportPlan(file, cwd, themes, platform)).toEqual({ path, command: null });
	});
});

describe("exportFileName", () => {
	it("sanitizes titles and falls back to the session id", () => {
		expect(exportFileName("Fix: CI / lint?", "0123456789")).toBe("Fix CI lint.html");
		expect(exportFileName(null, "0123456789")).toBe("omp-session-01234567.html");
		expect(exportFileName(" ... ", "abcdef12xyz")).toBe("omp-session-abcdef12.html");
	});
});

describe("parseTransferOutput", () => {
	it("accepts the CLI's single absolute path with spaces and CRLF", () => {
		const path = resolve("out dir/chat.tar");
		expect(parseTransferOutput(`${path}\r\n`)).toBe(path);
	});

	it.each(["", "Done", "relative.tar", "/tmp/one.tar\n/tmp/two.tar"])("rejects missing or unexpected output %j", stdout => {
		expect(parseTransferOutput(stdout)).toBeNull();
	});
});

describe("parseAnonymizeOutput", () => {
	it("reads singular and plural completion lines without dropping the destination's spaces", () => {
		const path = resolve("review copy");
		expect(parseAnonymizeOutput(`Anonymized 1 transcript → ${path}\nReview before sharing.\n`)).toEqual({ path, transcriptCount: 1 });
		expect(parseAnonymizeOutput(`Anonymized 12 transcripts → ${path}\r\n`)).toEqual({ path, transcriptCount: 12 });
	});

	it.each(["", "Anonymized 0 transcripts → /tmp/out", "Anonymized 2 transcripts → relative", "Review before sharing."])("does not fabricate export completion for %j", stdout => {
		expect(parseAnonymizeOutput(stdout)).toBeNull();
	});
});
