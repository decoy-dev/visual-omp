import type { OmpUpdateRun } from "@shared/contracts/updates";
import { describe, expect, it } from "vitest";
import { ompUpdateState } from "./updates";

const run: OmpUpdateRun = {
	runId: "update", args: ["update"], startedAt: 1, finishedAt: 2,
	exitCode: 0, output: "Update complete", versionAfter: "18.14.0",
};

describe("omp update outcome", () => {
	it("remains running until the updater finishes", () => {
		expect(ompUpdateState(null, null, "18.14.0")).toBe("running");
		expect(ompUpdateState({ ...run, finishedAt: null, versionAfter: null }, null, "18.14.0")).toBe("running");
	});

	it("reports a refused start and nonzero exit as failures", () => {
		expect(ompUpdateState(null, "Permission denied", "18.14.0")).toBe("failed");
		expect(ompUpdateState({ ...run, exitCode: 1 }, null, "18.14.0")).toBe("failed");
	});

	it.each(["18.13.3", "18.14.0-beta.1", null])("keeps setup blocked after a clean exit with unsupported or unknown version %s", versionAfter => {
		expect(ompUpdateState({ ...run, versionAfter }, null, "18.14.0")).toBe("unsupported");
	});

	it.each(["18.14.0", "18.14.1", "19.0.0"])("finishes only after installing supported %s", versionAfter => {
		expect(ompUpdateState({ ...run, versionAfter }, null, "18.14.0")).toBe("done");
	});
});
