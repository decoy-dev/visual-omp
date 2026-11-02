import { TSP_PREVIEW_UNAVAILABLE } from "@shared/tsp-host";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import { applyAdvisorConfig } from "./advisorApply";

vi.mock("./drive", () => ({ press: vi.fn(), readScreen: vi.fn(), runCommand: vi.fn(), sleep: vi.fn(), waitForScreen: vi.fn() }));
const invoke = vi.fn();
beforeEach(() => {
	invoke.mockReset();
	vi.stubGlobal("window", { vomp: { invoke } });
});

it("refuses TSP advisor application before starting the file-preservation transaction", async () => {
	const session = { getSnapshot: () => ({ host: { transport: "tsp" } }) } as unknown as SessionController;
	await expect(applyAdvisorConfig(session, "project")).rejects.toThrow(TSP_PREVIEW_UNAVAILABLE);
	expect(invoke).not.toHaveBeenCalled();
});

it("checks presentation after starting a saved chat and before preparing advisor files", async () => {
	let started = false;
	const session = {
		getSnapshot: () => ({ host: started ? { transport: "tsp" } : null }),
		whenLive: async () => { started = true; },
	} as unknown as SessionController;
	await expect(applyAdvisorConfig(session, "project")).rejects.toThrow(TSP_PREVIEW_UNAVAILABLE);
	expect(invoke).not.toHaveBeenCalled();
});
