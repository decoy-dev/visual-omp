import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { recordingDestination } from "./recording-destination";

let root: string;
let baseline: string;
beforeEach(async () => {
	root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "vomp-recording-destination-"));
	baseline = join(root, "fixtures", "18.15.0");
	await mkdir(baseline, { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("retains the baseline release's default destination", async () => {
	expect(await recordingDestination("18.15.0", undefined, baseline)).toBe(baseline);
});
it("refuses the default destination for another release", async () => {
	await expect(recordingDestination("18.16.0", undefined, baseline)).rejects.toThrow("separate VOMP_TSP_FIXTURE_DIR");
});
it("refuses the explicit baseline destination for another release", async () => {
	await expect(recordingDestination("18.16.0", baseline, baseline)).rejects.toThrow("separate VOMP_TSP_FIXTURE_DIR");
});
it("refuses a normalized spelling of the baseline destination", async () => {
	await expect(recordingDestination("18.16.0", `${baseline}/../18.15.0/.`, baseline)).rejects.toThrow("separate VOMP_TSP_FIXTURE_DIR");
});
it("refuses a symlink alias of the baseline destination", async () => {
	const alias = join(root, "baseline-alias");
	await symlink(baseline, alias, process.platform === "win32" ? "junction" : "dir");
	await expect(recordingDestination("18.16.0", alias, baseline)).rejects.toThrow("separate VOMP_TSP_FIXTURE_DIR");
});
it("refuses a nonexistent descendant through a symlinked baseline parent", async () => {
	const alias = join(root, "fixtures-alias");
	await symlink(join(root, "fixtures"), alias, process.platform === "win32" ? "junction" : "dir");
	await expect(recordingDestination("18.16.0", join(alias, "18.15.0", "new", "capture"), baseline)).rejects.toThrow("separate VOMP_TSP_FIXTURE_DIR");
});
it.skipIf(process.platform !== "darwin")("refuses the macOS private tmp alias of the baseline", async () => {
	await expect(recordingDestination("18.16.0", `/private${baseline}`, baseline)).rejects.toThrow("separate VOMP_TSP_FIXTURE_DIR");
});
it("allows and canonicalizes a separate nonexistent scratch destination", async () => {
	const alias = join(root, "scratch-alias");
	const scratch = join(root, "scratch");
	await mkdir(scratch);
	await symlink(scratch, alias, process.platform === "win32" ? "junction" : "dir");
	expect(await recordingDestination("18.16.0", join(alias, "new", "captures"), baseline)).toBe(join(await realpath(scratch), "new", "captures"));
});
