import { writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { parseArgs } from "node:util";
import { scoopSwitchScript } from "../../src/main/services/install-switch.ts";

const { values } = parseArgs({ options: {
	"install-dir": { type: "string" },
	uninstaller: { type: "string", default: "Uninstall visual-omp.exe" },
	profile: { type: "string" },
	"result-file": { type: "string" },
	"scoop-root": { type: "string" },
	"global-root": { type: "string" },
	"additional-root": { type: "string", multiple: true, default: [] },
	from: { type: "string", default: "0.7.7" },
	pid: { type: "string", default: "-1" },
	output: { type: "string" },
} });
for (const key of ["install-dir", "profile", "result-file", "scoop-root"]) {
	if (!values[key] || !win32.isAbsolute(values[key])) throw new Error(`--${key} must be an absolute Windows path.`);
}
if (values["global-root"] && !win32.isAbsolute(values["global-root"])) throw new Error("--global-root must be an absolute Windows path.");
const pid = Number(values.pid);
if (!Number.isSafeInteger(pid) || pid < -1) throw new Error("--pid must be a process id, or -1 to skip that id check.");
const script = scoopSwitchScript({
	scoop: win32.join(values["scoop-root"], "shims", "scoop.ps1"),
	roots: [values["scoop-root"], ...(values["global-root"] ? [values["global-root"]] : []), ...values["additional-root"]],
	executable: win32.join(values["install-dir"], "visual-omp.exe"),
	uninstaller: win32.join(values["install-dir"], values.uninstaller),
	profile: values.profile,
	pendingFile: win32.join(values.profile, "update-pending.json"),
	resultFile: values["result-file"], from: values.from, pid,
});
if (values.output) await writeFile(values.output, script, "utf8");
else process.stdout.write(script);
