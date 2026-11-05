import { afterEach, expect, it, vi } from "vitest";
import { flushDiagnostics, initializeDiagnosticsLog } from "./events";

const fake = vi.hoisted(() => ({ flush: vi.fn() }));
vi.mock("./log", () => ({ DiagnosticsLog: class { flush = fake.flush; } }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it("releases shutdown after 1.5 seconds when the log flush never settles", async () => {
	vi.useFakeTimers();
	fake.flush.mockReturnValue(Promise.withResolvers<void>().promise);
	initializeDiagnosticsLog("/unused/diagnostics.log");
	const pending = flushDiagnostics();
	await vi.advanceTimersByTimeAsync(1500);
	await expect(pending).resolves.toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
});
