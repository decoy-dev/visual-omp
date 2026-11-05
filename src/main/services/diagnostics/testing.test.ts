import { afterEach, expect, it, vi } from "vitest";
import { setDiagnosticReporter } from "./events";
import { runDiagnosticTest, type DiagnosticTestOptions } from "./testing";

const report = vi.fn();
const crashRenderer = vi.fn();
const allowed: DiagnosticTestOptions = { packaged: false, explicitTest: true, dsn: "https://public@example.com/1", enabled: true, crashRenderer };
afterEach(() => { vi.clearAllMocks(); setDiagnosticReporter(() => {}); });

it.each([{ packaged: true }, { explicitTest: false }, { dsn: "" }, { dsn: undefined }, { enabled: false }])("blocks test events and crashes without all development opt-ins: %j", changes => {
	setDiagnosticReporter(report);
	for (const kind of ["event", "renderer-crash"] as const) expect(() => runDiagnosticTest(kind, { ...allowed, ...changes })).toThrow("development build");
	expect(report).not.toHaveBeenCalled();
	expect(crashRenderer).not.toHaveBeenCalled();
});
it("records and sends a labeled test event without crashing", () => {
	setDiagnosticReporter(report);
	runDiagnosticTest("event", allowed);
	expect(report).toHaveBeenCalledWith({ event: "diagnostics-test", kind: "event" });
	expect(crashRenderer).not.toHaveBeenCalled();
});
it("crashes only the requesting test renderer on explicit command", () => {
	runDiagnosticTest("renderer-crash", allowed);
	expect(crashRenderer).toHaveBeenCalledOnce();
});
it("rejects unknown runtime input", () => {
	expect(() => runDiagnosticTest("unknown" as "event", allowed)).toThrow("Unknown diagnostics test");
	expect(crashRenderer).not.toHaveBeenCalled();
});
