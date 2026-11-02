import { describe, expect, it } from "vitest";
import { StartupDiagnosticCapture, startupDiagnostic } from "./startup-diagnostics";

function capture(parts: Uint8Array[], resumeFile?: string) {
	const capture = new StartupDiagnosticCapture();
	for (const part of parts) capture.push(part);
	capture.end();
	return capture.diagnostic(resumeFile);
}

describe("raw startup diagnostics", () => {
	it("strips split CSI, OSC, APC, DCS and character-set sequences without retaining their payloads", () => {
		const bytes = Buffer.from('\x1b]0;Error: private title\x07\x1bPError: private DCS\x1b\\\x1b_Error: private APC\x1b\\\x1b(B\x1b[31mError: café ✓\x1b[0m\r\n');
		for (let split = 0; split <= bytes.length; split++) {
			expect(capture([bytes.subarray(0, split), bytes.subarray(split)])).toEqual({ text: "Error: café ✓", resumeFileMissing: false });
		}
	});

	it("recognizes both missing-file formats and matches the exact requested path", () => {
		for (const line of ['Session file not found: /tmp/chat.jsonl', 'Error: Session "/tmp/chat.jsonl" not found.']) {
			expect(capture([Buffer.from(line)], "/tmp/chat.jsonl")).toEqual({ text: line, resumeFileMissing: true });
			expect(capture([Buffer.from(line)], "/tmp/other.jsonl")?.resumeFileMissing).toBe(false);
		}
	});

	it("ignores unrecognized output and unfinished escape payloads", () => {
		expect(capture([Buffer.from("private startup output\r\n\x1b]0;Error: private unfinished title")])).toBeNull();
	});

	it("keeps accepting later errors after oversized diagnostics and escape payloads", () => {
		const result = capture([Buffer.from(`Error: ${"x".repeat(20_000)}\r\n\x1b]0;${"hidden".repeat(10_000)}\x07Error: final failure\r\n`)]);
		expect(result).toEqual({ text: "Error: final failure", resumeFileMissing: false });
	});

	it("uses the classic bounds for a combination of long diagnostic lines", () => {
		const lines = Array.from({ length: 8 }, (_, index) => `Error: ${index} ${"detail ".repeat(30)}`);
		expect(startupDiagnostic(lines)?.text).toHaveLength(1200);
		const result = capture([Buffer.from(lines.join("\r\n"))]);
		expect(result!.text.length).toBeLessThanOrEqual(1200);
		expect(result!.text.split("\n").length).toBeLessThanOrEqual(8);
		expect(result!.text).toContain("Error: 7");
	});
});
