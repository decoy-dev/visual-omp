import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { brewSwitchCommand, scoopRoots, scoopSwitchScript } from "./install-switch";

it("uses adoption and quotes the binary and destination literally", () => {
	expect(brewSwitchCommand("/Users/Chris's tools/bin/brew", "/Users/Chris's Apps/visual-omp.app")).toBe(
		"HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ASK=1 '/Users/Chris'\\''s tools/bin/brew' install --cask --adopt '--appdir=/Users/Chris'\\''s Apps' decoy-dev/tap/visual-omp",
	);
});
it("never generates a forced replacement", () => {
	const command = brewSwitchCommand("/opt/homebrew/bin/brew", "/Applications/visual-omp.app");
	expect(command).toContain("install --cask --adopt");
	expect(command).not.toContain("--force");
});

const options = {
	scoop: "D:\\Chris's tools\\scoop\\shims\\scoop.ps1",
	roots: ["D:\\Chris's tools\\scoop", "C:\\ProgramData\\scoop"],
	executable: "C:\\Users\\Chris's account\\Apps\\visual-omp\\visual-omp.exe",
	profile: "C:\\Users\\Chris's account\\AppData\\Roaming\\visual-omp",
	pendingFile: "C:\\profile\\update-pending.json",
	resultFile: "C:\\profile\\scoop-switch-result.json",
	from: "0.7.7", pid: 1234,
};
const script = scoopSwitchScript(options);

it("discovers configured, default, global and PATH roots with case-insensitive deduplication", () => {
	expect(scoopRoots({
		SCOOP: "D:\\Tools\\scoop", USERPROFILE: "C:\\Users\\chris",
		SCOOP_GLOBAL: "E:\\Shared scoop", ProgramData: "C:\\ProgramData",
		Path: '"d:\\tools\\Scoop\\shims";F:\\Other\\shims;C:\\Windows',
	}, "C:\\Users\\unused")).toEqual(["D:\\Tools\\scoop", "C:\\Users\\chris\\scoop", "E:\\Shared scoop", "C:\\ProgramData\\scoop", "F:\\Other"]);
});
it("includes the configured global_path even when it is absent from the environment and PATH", () => {
	expect(scoopRoots({ SCOOP: "C:\\User scoop", USERPROFILE: "C:\\Users\\chris" }, "C:\\Users\\chris", "E:\\Configured scoop")).toContain("E:\\Configured scoop");
});
it("rechecks global_path using Scoop's XDG or default config location before finding an existing copy", () => {
	expect(script).toContain("$configHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $env:USERPROFILE '.config' }");
	expect(script).toContain("Join-Path $configHome 'scoop\\config.json'");
	expect(script).toContain("$roots += $config.global_path");
	expect(script.indexOf("$roots += $config.global_path")).toBeLessThan(script.indexOf("$existingRoot ="));
});
it("quotes PowerShell paths literally, without an encoded-command size limit", () => {
	expect(script).toContain("$scoop = 'D:\\Chris''s tools\\scoop\\shims\\scoop.ps1'");
	expect(script).toContain("$installDir = 'C:\\Users\\Chris''s account\\Apps\\visual-omp'");
	expect(script).toContain("param([switch]$DryLaunch)");
	expect(script).toContain("$_.Id -eq 1234");
});
it("checks all roots again and verifies receipt, manifest, executable version and resolved app path before uninstall", () => {
	const verification = script.indexOf("Set-Phase 'verifying'");
	const removal = script.indexOf("Set-Phase 'removing'");
	for (const check of ["scoop-install.json", "install.json", "scoop-manifest.json", "manifest.json", "VersionInfo.ProductVersion", "Resolve-Path -LiteralPath $target"]) {
		expect(script.indexOf(check)).toBeGreaterThan(verification);
		expect(script.indexOf(check)).toBeLessThan(removal);
	}
	expect(script).toContain("$env:SCOOP_GLOBAL");
	expect(script).toContain("Join-Path $env:USERPROFILE 'scoop'");
	expect(script).toContain("Join-Path $env:ProgramData 'scoop'");
	expect(script.indexOf("$existingRoot =")).toBeLessThan(script.indexOf("Invoke-Scoop -Arguments @('install'"));
	expect(script).toContain("$actualVersion -ne $version");
	expect(script).toContain("$version -ne $expected");
});
it("uses electron-builder's temp-copy update uninstall and never deletes the install directory", () => {
	expect(script).toContain("[Guid]::NewGuid()");
	expect(script).toContain("Copy-Item -LiteralPath $uninstaller -Destination $temporaryUninstaller");
	expect(script).toContain("Start-Process -FilePath $temporaryUninstaller");
	expect(script).toContain("'/S /KEEP_APP_DATA ' + $mode + ' --updated _?=' + $installDir");
	expect(script).toContain("Remove-Item -LiteralPath $temporaryUninstaller");
	expect(script).not.toContain("--delete-app-data");
	expect(script).not.toContain("-Recurse");
	expect(script).not.toContain("Start-Process -FilePath $uninstaller");
});
it("reopens the original on installation failure and the verified Scoop copy on cleanup failure", () => {
	expect(script).toContain("$record.failureKind = if ($record.verified) { 'cleanup' } else { 'install' }");
	expect(script).toContain("$launch = if ($record.verified) { $target } else { $original }");
	expect(script).toContain("Could not write result:");
	expect(script).toContain("Could not write restart outcome:");
	expect(script).toContain("Could not write log:");
	expect(script.indexOf("Save-Result -PendingOutcome")).toBeLessThan(script.indexOf("Start-Process -FilePath $launch"));
	expect(script).toContain("if (-not $DryLaunch) { Read-Host");
	expect(script).toContain("App readiness has not been checked.");
});
it("prints the production script from the standalone generator", () => {
	const profile = "C:\\profile";
	const generated = execFileSync(process.execPath, [
		"scripts/dev/scoop-switch-script.mjs", "--install-dir", "C:\\Apps\\visual-omp",
		"--profile", profile, "--result-file", options.resultFile,
		"--scoop-root", "D:\\scoop", "--global-root", "F:\\Configured global scoop", "--additional-root", "E:\\Global scoop",
	], { encoding: "utf8" });
	expect(generated).toBe(scoopSwitchScript({
		scoop: "D:\\scoop\\shims\\scoop.ps1", roots: ["D:\\scoop", "F:\\Configured global scoop", "E:\\Global scoop"],
		executable: "C:\\Apps\\visual-omp\\visual-omp.exe", uninstaller: "C:\\Apps\\visual-omp\\Uninstall visual-omp.exe",
		profile, pendingFile: "C:\\profile\\update-pending.json", resultFile: options.resultFile,
		from: "0.7.7", pid: -1,
	}));
});
