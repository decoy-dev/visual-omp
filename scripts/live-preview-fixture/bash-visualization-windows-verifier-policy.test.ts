import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const source = fileURLToPath(new URL("./bash-visualization-windows-fixture.cs", import.meta.url));
const inspector = fileURLToPath(new URL("./bash-visualization-windows-inspector.ps1", import.meta.url));

// This host-independent check exercises source/wire contracts only. It cannot compile C#,
// establish Windows handle rights, or reproduce a native query/exit race on macOS.
it("preserves the verifier deadline wire contract and fail-closed retained-handle recovery", async () => {
	const [cs, ps] = await Promise.all([readFile(source, "utf8"), readFile(inspector, "utf8")]);
	expect(cs).toContain('public static object Snapshot(string key) { return Snapshot(key, ""); }');
	expect(cs).toContain("public static object Snapshot(string key, string exitDeadline)");
	expect(ps).toContain("::Snapshot([string]$request.key, [string]$request.exitDeadline)");
	expect(ps.indexOf("::VerifierPolicySelfTest()")).toBeLessThan(ps.indexOf("event='ready'"));
	for (const field of ["nativeApi", "nativeError", "exitRechecked", "exitConfirmedAt"]) {
		expect(ps).toContain(`$response.${field} =`);
	}
	const recovery = cs.slice(cs.indexOf("static long ConfirmQueryFailureExit("), cs.indexOf("static void SelfTestAssert("));
	expect(recovery).toContain("WaitForSingleObject(item.handle, 0)");
	expect(recovery).toContain("WaitForSingleObject(item.handle, remaining)");
	expect(recovery).toContain("if (state != 0 || (deadline != 0 && confirmedAt > deadline)) throw failure;");
	expect(recovery).not.toMatch(/OpenProcess|GetProcessById|held\[|item\.[a-zA-Z]+\s*=/);
	expect(cs).toContain("OpenProcess(0x00101411, false, pid)");
});

// Windows runs the actual preflight using a native child and a synchronize-only duplicate
// of its retained handle. The recovery helper is invoked after deliberate query failure
// and controlled child exit, making the failure/exit ordering deterministic.
it.skipIf(process.platform !== "win32")("runs native verifier policy regressions before inspector readiness", () => {
	const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	expect(root).toBeTruthy();
	const result = spawnSync(join(root!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", inspector, "inspect", source,
	], { input: "", encoding: "utf8", windowsHide: true, timeout: 30_000 });
	expect(result.error, result.stderr).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
	expect(events).toHaveLength(1);
	expect(events[0].event).toBe("ready");
	expect(events[0].verifierPolicySelfTest).toEqual({ passed: true, cases: [
		"stillLiveAccessDeniedFails", "liveDeadlineFails", "metadataQueryFailureThenExitConfirmed",
		"memoryQueryFailureThenExitConfirmed", "deadlineExpiredFails", "pinnedIdentityUnchanged", "identityMismatchFails", "absoluteWaitBudget",
	] });
}, 35_000);
