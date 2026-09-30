import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	entryId,
	localScopeKey,
	MNEMOPI_SHARED_KEY,
	mnemopiProjectBank,
	parseEntryId,
	parseScopeId,
	projectBankSegment,
	sanitizeBankName,
	scopeId,
} from "./paths";
import { wyhash } from "./wyhash";

describe("wyhash", () => {
	// Reference values from `Bun.hash(input)` (bun 1.3), covering every length branch of the algorithm.
	it.each([
		["", 290873116282709081n],
		["abc", 190542993387777138n],
		["0123456789abcdef", 14052610914415071785n],
		["0123456789abcdefg", 13012861896001323413n],
		["x".repeat(48), 10889483319867276750n],
		["x".repeat(49), 17550346204783977301n],
		["/Users/someone/projects/visual-omp/é", 5173748932852155531n],
		["q".repeat(97), 3084932900201445351n],
	])("matches Bun.hash for %j", (input, expected) => {
		expect(wyhash(input)).toBe(expected);
	});
});

describe("project bank ids", () => {
	it("derives each bank id from the canonical absolute path", () => {
		const cwd = resolve("tmp", "vomp-mem", "proj-alpha");
		const expected = `proj-alpha-${wyhash(cwd).toString(36)}`;
		expect(projectBankSegment(cwd)).toBe(expected);
		expect(mnemopiProjectBank(" team ", cwd)).toBe(`team-${expected}`);
		expect(mnemopiProjectBank(null, cwd)).toBe(expected);
	});

	it("clamps long names to 64 chars with a hash suffix", () => {
		const cwd = resolve("src", "a-very-long-directory-name-that-keeps-going-and-going-beyond-limits");
		const base = sanitizeBankName(basename(cwd)) ?? "default";
		const projectInput = `${base}-${wyhash(cwd).toString(36)}`;
		const project = projectBankSegment(cwd);
		const bankInput = `team-${project}`;
		const bank = mnemopiProjectBank("team", cwd);
		expect(project).toMatch(new RegExp(`-${wyhash(projectInput).toString(36)}$`));
		expect(project).toHaveLength(64);
		expect(bank).toMatch(new RegExp(`-${wyhash(bankInput).toString(36)}$`));
		expect(bank).toHaveLength(64);
	});

});
describe("localScopeKey", () => {
	it("encodes the cwd like omp's local memory root", () => {
		expect(localScopeKey("/tmp/vomp-mem/proj-alpha", "darwin")).toBe("--tmp-vomp-mem-proj-alpha--");
		expect(localScopeKey("C:\\Users\\Me\\Proj", "win32")).toBe("--c--users-me-proj--");
	});
});

describe("memory ids", () => {
	it("round-trips entry ids whose item contains separators", () => {
		const ref = { backend: "sharpshooter", key: "proj-alpha-lrqk5knk4ojc", kind: "delta", item: "sess-a/00muodj7sw-k3j9.json" } as const;
		const id = entryId(ref);
		expect(id.split("/")).toHaveLength(4);
		expect(parseEntryId(id)).toEqual(ref);
		expect(parseScopeId(scopeId({ backend: "mnemopi", key: MNEMOPI_SHARED_KEY }))).toEqual({
			backend: "mnemopi",
			key: MNEMOPI_SHARED_KEY,
		});
	});

	it("rejects scope keys that could leave the storage root", () => {
		expect(() => parseScopeId("local/..%2F..%2Fetc")).toThrow();
		expect(() => parseScopeId("mnemopi/..")).toThrow();
		expect(() => parseScopeId("sharpshooter/a%2Fb")).toThrow();
		expect(() => parseEntryId("hindsight/x/working/1")).toThrow();
		expect(() => parseEntryId("local/--p--/lesson")).toThrow();
	});
});
