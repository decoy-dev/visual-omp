import { describe, expect, it } from "vitest";
import { leaseMemoryName } from "./lease-name";

// Independently generated with Bun.hash.xxHash64 and pi-natives 18.14's two seeds.
describe("omp native lease names", () => {
	it.each([
		["", "omp-file-lock-dd4458733774f8b02ff557a2e70c6e06"],
		["abc", "omp-file-lock-c0151025cd8a94a413c147b69cf27e28"],
		["/home/alice/.omp/run/session-owners/session-123.lock", "omp-file-lock-5e8710611da0f8357f3d2785df12f071"],
		["C:\\Users\\Alice\\.omp\\run\\session-owners\\session-123.lock", "omp-file-lock-288a9acdd390f1f9748872543f63bcef"],
	])("matches native hashing for %j", (path, expected) => {
		expect(leaseMemoryName(path)).toBe(expected);
	});
});
