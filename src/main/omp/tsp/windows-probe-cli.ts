import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exitWindowsProbe, runWindowsProbe, runWindowsProbes, windowsProbeFailed } from "./windows-probe";

// Keep executable startup separate from the importable probe helpers. A bundled import otherwise
// makes import.meta.url refer to its consumer, which can accidentally activate a main-file guard.
if (process.platform !== "win32") throw new Error("The Windows TSP probe requires Windows.");
const bin = process.env.OMP_BIN;
const destination = process.env.VOMP_TSP_WINDOWS_REPORT;
if (!bin || !destination) throw new Error("OMP_BIN and VOMP_TSP_WINDOWS_REPORT are required.");
const system = process.argv.includes("--system");
const probeArg = process.argv.indexOf("--probe");
if (probeArg !== -1) {
	const framing = process.argv[probeArg + 1];
	if (framing !== "apc" && framing !== "osc877") throw new Error(`Invalid probe framing: ${framing}`);
	const result = await runWindowsProbe(resolve(bin), !system, framing, destination);
	result.activeResourcesAtExit = process.getActiveResourcesInfo();
	writeFileSync(destination, JSON.stringify(result));
	exitWindowsProbe(result, system);
} else {
	const report = await runWindowsProbes({ bin: resolve(bin), system, destination, entry: fileURLToPath(import.meta.url) });
	console.log(JSON.stringify(report.results.map(({ traffic, ...result }) => ({ ...result, trafficChunks: traffic.length }))));
	if (report.results.some(result => windowsProbeFailed(result, system))) process.exitCode = 1;
}
