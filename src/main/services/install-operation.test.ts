import { expect, it, vi } from "vitest";
import { InstallOperation } from "./install-operation";

it.each(["update", "reinstall", "switch"] as const)("excludes every installation while %s runs and permits the next after settlement", owner => {
	const changed = vi.fn();
	const operation = new InstallOperation(changed);
	operation.begin(owner);
	for (const conflict of ["update", "reinstall", "switch"] as const) {
		expect(() => operation.begin(conflict)).toThrow("in progress");
		expect(operation.current).toBe(owner);
	}
	operation.end(owner);
	operation.begin("switch");
	expect(changed.mock.calls).toEqual([[owner], [null], ["switch"]]);
});
it("does not release another operation's ownership", () => {
	const operation = new InstallOperation(() => {});
	operation.begin("switch"); operation.end("update");
	expect(operation.current).toBe("switch");
});
