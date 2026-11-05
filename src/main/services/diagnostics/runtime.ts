import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, crashReporter, type BrowserWindow } from "electron";
import { onBroadcast } from "../../ipc";
import { getPrefs } from "../../prefs";
import { initializeDiagnosticsLog, setDiagnosticReporter, writeDiagnostic } from "./events";
import { diagnosticProcessType, diagnosticReason, exceptionDetails, RendererRecovery } from "./log";
import { PendingHang } from "./hang";
import { diagnosticInstallId, SENTRY_DSN, SentrySender } from "./sentry";
import { settleWithin } from "./deadline";

const folder = join(app.getPath("userData"), "logs");
const log = initializeDiagnosticsLog(join(folder, "diagnostics.log"));
const recovery = new RendererRecovery();
const hang = new PendingHang(join(folder, "pending-hang.json"));
const initialPrefs = getPrefs();
const transport = (classic: boolean) => process.env.VOMP_TSP === "1" || (process.env.VOMP_TSP !== "0" && !classic) ? "tsp" as const : "classic" as const;
const override = !app.isPackaged ? process.env.VOMP_SENTRY_DSN : undefined;
// Handle storage failure without creating an unhandled rejection or substituting a machine identity.
const installId = diagnosticInstallId(join(app.getPath("userData"), "diagnostics-install-id")).catch(() => "");
const sender = new SentrySender({
	dsn: override ?? SENTRY_DSN, packaged: app.isPackaged, developmentOverride: !!override,
	enabled: initialPrefs.sendCrashReports !== false, version: app.getVersion(), platform: process.platform, arch: process.arch,
	transport: transport(initialPrefs.classicPresentation), classic: initialPrefs.classicPresentation, home: homedir(), installId, log,
});
setDiagnosticReporter(event => sender.capture(event));
let countHosts = () => 0;
let reporterStarted = false;

// Imported immediately after profile identity, before feature modules and app readiness.
export const crashReportingReady = settleWithin(mkdir(join(folder, "crashes"), { recursive: true }), 1500).then(result => {
	if (!result.completed) {
		writeDiagnostic({ event: "crash-reporter", started: false });
		return;
	}
	app.setPath("crashDumps", join(folder, "crashes"));
	crashReporter.start({
		...(sender.endpoints ? { submitURL: sender.endpoints.minidump } : {}), uploadToServer: sender.enabled, compress: true, rateLimit: true,
		globalExtra: {
			"sentry[release]": `visual-omp@${app.getVersion()}`,
			"sentry[environment]": app.isPackaged ? "production" : "development",
			"sentry[tags][platform]": process.platform,
			"sentry[tags][arch]": process.arch,
			"sentry[tags][transport]": sender.options.transport,
			"sentry[tags][classic]": String(sender.options.classic),
		},
	});
	reporterStarted = true;
	writeDiagnostic({ event: "crash-reporter", started: true });
}).catch(() => writeDiagnostic({ event: "crash-reporter", started: false }));

onBroadcast("app:prefs", prefs => {
	sender.setEnabled(prefs.sendCrashReports !== false);
	sender.options.classic = prefs.classicPresentation;
	sender.options.transport = transport(prefs.classicPresentation);
	if (reporterStarted) crashReporter.setUploadToServer(sender.enabled);
});

// Observation only: preserve Electron's exception behavior and never turn a rejected promise into an app exit.
process.on("uncaughtExceptionMonitor", error => {
	writeDiagnostic({ event: "main-exception", kind: "uncaughtException", ...exceptionDetails(error) });
});
process.on("unhandledRejection", error => {
	writeDiagnostic({ event: "main-exception", kind: "unhandledRejection", ...exceptionDetails(error) });
	// Registering a listener replaces Node's default warning, so retain a warning in development output.
	console.warn("[visual-omp] Unhandled promise rejection:", error);
});
app.on("child-process-gone", (_event, details) => {
	writeDiagnostic({
		event: "child-gone", type: diagnosticProcessType(details.type), reason: diagnosticReason(details.reason), exitCode: details.exitCode,
		// Chromium service identifiers only. Display names may contain user-controlled text.
		serviceName: /^[a-zA-Z0-9_.-]{0,100}$/.test(details.serviceName ?? "") ? details.serviceName ?? "" : "unknown",
	});
});

export function startDiagnostics(options: { classic: boolean; hosts(): number }): void {
	countHosts = options.hosts;
	writeDiagnostic({
		event: "app-start", version: app.getVersion(), platform: process.platform, arch: process.arch,
		electron: process.versions.electron, classic: options.classic, transport: transport(options.classic),
	});
	void hang.recover().then(event => { if (event) writeDiagnostic(event); });
	const timer = setInterval(() => sampleMemory("interval"), 5 * 60_000);
	timer.unref();
	app.once("will-quit", () => clearInterval(timer));
}

function sampleMemory(trigger: "interval" | "unresponsive"): void {
	try {
		writeDiagnostic({
			event: "memory", trigger, hosts: countHosts(),
			processes: app.getAppMetrics().slice(0, 256).map(metric => ({ pid: metric.pid, type: diagnosticProcessType(metric.type), workingSetKiB: metric.memory.workingSetSize })),
		});
	} catch { /* Native metrics can be unavailable while processes exit. */ }
}

export function attachWindowDiagnostics(window: BrowserWindow): void {
	let unresponsiveAt: number | null = null;
	let hangTimer: NodeJS.Timeout | null = null;
	window.on("unresponsive", () => {
		unresponsiveAt ??= performance.now();
		writeDiagnostic({ event: "window-unresponsive", windowId: window.id });
		sampleMemory("unresponsive");
		hangTimer ??= setTimeout(() => {
			if (unresponsiveAt !== null) hang.save(window.id, Math.max(10_000, Math.round(performance.now() - unresponsiveAt)));
		}, 10_000);
	});
	window.on("responsive", () => {
		writeDiagnostic({ event: "window-responsive", windowId: window.id, durationMs: unresponsiveAt === null ? null : Math.max(0, Math.round(performance.now() - unresponsiveAt)) });
		unresponsiveAt = null;
		clearTimeout(hangTimer ?? undefined);
		hangTimer = null;
		hang.clear();
	});
	window.once("closed", () => clearTimeout(hangTimer ?? undefined));
	window.webContents.on("render-process-gone", (_event, details) => {
		const reload = recovery.shouldReload(details.reason) && !window.isDestroyed();
		writeDiagnostic({ event: "renderer-gone", windowId: window.id, reason: diagnosticReason(details.reason), exitCode: details.exitCode, reload });
		if (reload) setImmediate(() => {
			if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.reload();
		});
	});
}
