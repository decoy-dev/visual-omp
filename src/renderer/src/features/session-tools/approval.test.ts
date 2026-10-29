import { describe, expect, it } from "vitest";
import type { ApprovalState } from "@shared/contracts/config";
import { approvalModes } from "./approval";

const state: ApprovalState = { cwd: null, mode: "always-ask", modeSource: "default", policies: [], unrecognized: [] };

describe("approval picker capabilities", () => {
	it("keeps older snapshots and pending reads on the three original choices", () => {
		expect(approvalModes(null)).toEqual(["always-ask", "write", "yolo"]);
		expect(approvalModes(state)).toEqual(["always-ask", "write", "yolo"]);
	});

	it("offers Ask and remember only when omp advertises it", () => {
		expect(approvalModes({ ...state, supportedModes: ["always-ask", "write", "yolo"] })).not.toContain("always-ask-cached");
		expect(approvalModes({ ...state, supportedModes: ["always-ask", "always-ask-cached", "write", "yolo"] })).toContain("always-ask-cached");
	});
});
