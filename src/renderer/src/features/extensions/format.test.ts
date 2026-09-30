import { describe, expect, it } from "vitest";
import { compareVersions, errorText, formatCount, formatDuration, formatUsd, joinCommandLine, splitCommandLine, toCsv } from "./format";

describe("formatters", () => {
	it("formats money, counts and durations at their boundaries", () => {
		expect([formatUsd(0), formatUsd(0.004), formatUsd(1.235), formatUsd(1234.5)]).toEqual(["$0.00", "<$0.01", "$1.24", "$1,235"]);
		expect([formatCount(950), formatCount(12_400), formatCount(1_200_000), formatCount(345_600_000)]).toEqual(["950", "12.4K", "1.2M", "346M"]);
		expect([formatDuration(45_000), formatDuration(3_600_000), formatDuration(4_320_000), formatDuration(-5)]).toEqual(["45s", "1h", "1h 12m", "0s"]);
	});

	it("quotes CSV fields that contain separators, quotes or line breaks", () => {
		expect(toCsv(["title", "cost"], [['Fix "checkout", again', 1.5], ["two\nlines", 0]])).toBe(
			'title,cost\r\n"Fix ""checkout"", again",1.5\r\n"two\nlines",0\r\n',
		);
	});

	it("strips Electron's remote-method wrapper from errors", () => {
		expect(errorText(new Error("Error invoking remote method 'mcp:add': Error: Server \"x\" already exists"))).toBe('Server "x" already exists');
	});
});

describe("command lines", () => {
	it("splits quotes and escapes, and joins back to an equivalent line", () => {
		const argv = splitCommandLine(`docker run -e 'A=b c' "x\\"y" My\\ Files ""`);
		expect(argv).toEqual(["docker", "run", "-e", "A=b c", 'x"y', "My Files", ""]);
		expect(splitCommandLine(joinCommandLine(argv))).toEqual(argv);
	});
});

describe("compareVersions", () => {
	it("compares numerically and ranks pre-releases below their release", () => {
		expect(compareVersions("1.10.0", "1.9.2")).toBeGreaterThan(0);
		expect(compareVersions("v1.2", "1.2.0")).toBe(0);
		expect(compareVersions("1.2.0-beta.1", "1.2.0")).toBeLessThan(0);
		expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
	});
});
