import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { hookQuestions } from "../../../../shared/tsp/question-match";
import { SessionHost } from "../../host";
import { lifecyclePlatform, nativeTheme } from "./windows-lifecycle-platform";

const WindowsMetrics = z.object({
	threadCount: z.number(), threadIds: z.array(z.number()), handleCount: z.number(),
	children: z.array(z.object({ ProcessId: z.number(), ParentProcessId: z.number(), Name: z.string() })),
});
interface ResourceSample {
	at: number;
	resources: Record<string, number>;
	threadCount: number;
	threadIds: number[];
	handleCount: number;
	children: { ProcessId: number; ParentProcessId: number; Name: string }[];
	appearanceListeners: number;
}
interface Cycle {
	mode: "natural" | "force";
	index: number;
	hostId: string;
	pid?: number;
	before?: ResourceSample;
	live?: ResourceSample;
	stopped?: ResourceSample;
	settled?: ResourceSample;
	confirmations?: number;
	exitCode?: number | null;
	error?: string;
}

async function sample(knownPids: number[]): Promise<ResourceSample> {
	const resources: Record<string, number> = {};
	for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
	const parents = [process.pid, ...knownPids].join(",");
	const script = `$p=Get-Process -Id ${process.pid}; $parents=@(${parents}); $children=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($parents -contains $_.ParentProcessId -or $parents -contains $_.ProcessId) } | Select-Object ProcessId,ParentProcessId,Name); [pscustomobject]@{ threadCount=$p.Threads.Count; threadIds=@($p.Threads | ForEach-Object { $_.Id }); handleCount=$p.HandleCount; children=$children } | ConvertTo-Json -Compress -Depth 4`;
	const done = Promise.withResolvers<string>();
	execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true },
		(error, stdout, stderr) => error ? done.reject(new Error(`Windows resource sample failed: ${error.message}; ${stderr.slice(0, 4096)}`)) : done.resolve(stdout));
	const metrics = WindowsMetrics.parse(JSON.parse((await done.promise).replace(/^\uFEFF/, "")));
	return { at: Date.now(), resources, ...metrics, appearanceListeners: nativeTheme.listenerCount("updated") };
}

async function until(predicate: () => boolean, label: string, timeout = 20_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(label);
		await sleep(30);
	}
}

async function stopWithDeadline(host: SessionHost): Promise<void> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error("SessionHost.stop did not complete within 30 seconds")), 30_000);
	try { await Promise.race([host.stop(), expired.promise]); }
	finally { clearTimeout(timer); }
}

// This program deliberately does not call process.exit(), unref(), or private node-pty disposal.
// A referenced worker can therefore keep it alive; the CI parent's timeout records that failure.
if (process.platform !== "win32") throw new Error("The SessionHost lifecycle recorder requires Windows");
const destination = process.env.VOMP_TSP_LIFECYCLE_REPORT;
const extension = process.env.VOMP_TSP_LIFECYCLE_EXTENSION;
if (!destination || !extension || !process.env.OMP_BIN) throw new Error("Lifecycle report, extension and OMP_BIN are required");
await mkdir(dirname(resolve(destination)), { recursive: true });
const report = {
	status: "running", pid: process.pid, node: process.versions,
	boundary: "Production SessionHost, node-pty, native bridge, relay, debug client and CLI; headless Electron UI/IPC/preferences and isolated launch environment",
	baseline: undefined as ResourceSample | undefined,
	cycles: [] as Cycle[],
	final: undefined as ResourceSample | undefined,
	growth: undefined as { threads: number; handles: number; resources: Record<string, number> } | undefined,
	error: undefined as string | undefined,
};
const persist = () => writeFileSync(destination, JSON.stringify(report, null, 2));
persist();
const root = await mkdtemp(join(tmpdir(), "vomp-host-lifecycle-"));
const knownPids: number[] = [];
let current: SessionHost | undefined;
try {
	const home = join(root, "home");
	const agent = join(home, ".omp", "agent");
	await mkdir(agent, { recursive: true });
	await writeFile(join(agent, "config.yml"), JSON.stringify({
		startup: { setupWizard: false, checkUpdate: false, changelogMode: "hidden", quiet: true },
		marketplace: { autoUpdate: "off" }, worktree: { onStart: "off", onExit: "keep" },
		autocomplete: { enabled: false }, recap: { enabled: false }, composer: { predictions: false },
	}));
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)) lifecyclePlatform.env[key] = value;
	}
	Object.assign(lifecyclePlatform.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") });
	// Production path readers use os.homedir(); keep this isolated recorder's own home aligned.
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.VOMP_TSP = "1";
	report.baseline = await sample(knownPids);
	persist();
	for (let index = 1; index <= 3; index++) for (const mode of ["natural", "force"] as const) {
		current = new SessionHost({ cwd: root, extraArgs: ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--extension", extension] });
		const host = current;
		const cycle: Cycle = { mode, index, hostId: host.id };
		report.cycles.push(cycle);
		cycle.before = await sample(knownPids);
		persist();
		try {
			await host.start();
			await until(() => host.state.phase === "exited" || (host.state.phase === "live" && !!host.tspSnapshot()?.availability.available), "Host did not reach a live TSP editor");
			if (host.state.phase === "exited") throw new Error(`omp exited during startup: ${host.state.error ?? host.state.exitReason ?? host.state.exitCode}`);
			cycle.pid = host.state.pid ?? undefined;
			if (cycle.pid) knownPids.push(cycle.pid);
			cycle.live = await sample(knownPids);
			persist();
			if (mode === "force") {
				await host.submit("/vomp-fixture-select");
				await until(() => hookQuestions(host.tspSnapshot()?.surfaces ?? [], host.state.generation).length > 0, "Force-stop fixture did not open its hook");
			}
			const before = lifecyclePlatform.confirmations.length;
			await stopWithDeadline(host);
			await until(() => host.state.phase === "exited", "Stopped host did not publish exit");
			cycle.confirmations = lifecyclePlatform.confirmations.length - before;
			cycle.exitCode = host.state.exitCode;
			cycle.stopped = await sample(knownPids);
			persist();
			// Real integration settling: SessionHost's force-stop timer lasts 4s; node-pty's flush lasts 1s.
			await sleep(5500);
			cycle.settled = await sample(knownPids);
			if (mode === "natural" && (cycle.confirmations !== 0 || cycle.exitCode !== 0)) throw new Error("Natural /exit required force confirmation or exited nonzero");
			if (mode === "force" && cycle.confirmations !== 1) throw new Error("Force-stop did not use exactly one confirmed production shutdown decision");
		} catch (error) {
			cycle.error = error instanceof Error ? error.message : String(error);
			persist();
			throw error;
		}
		persist();
		current = undefined;
	}
	report.final = await sample(knownPids);
	const names = new Set([...Object.keys(report.baseline.resources), ...Object.keys(report.final.resources)]);
	report.growth = { threads: report.final.threadCount - report.baseline.threadCount, handles: report.final.handleCount - report.baseline.handleCount,
		resources: Object.fromEntries([...names].map(name => [name, (report.final!.resources[name] ?? 0) - (report.baseline!.resources[name] ?? 0)])) };
	report.status = "complete";
	console.log(`SessionHost lifecycle growth (evidence only): ${JSON.stringify(report.growth)}`);
} catch (error) {
	report.status = "failed";
	report.error = error instanceof Error ? error.message : String(error);
	console.error(report.error);
	process.exitCode = 1;
	try { report.final = await sample(knownPids); } catch { /* Preserve the original lifecycle failure. */ }
} finally {
	persist();
	// Do not bypass SessionHost to dispose a retained native worker or kill an unconfirmed process.
	if (!current || current.state.phase === "exited") {
		try { await rm(root, { recursive: true, force: true }); }
		catch (error) { report.error = [report.error, `Scratch cleanup: ${String(error)}`].filter(Boolean).join("\n"); process.exitCode = 1; persist(); }
	}
}
