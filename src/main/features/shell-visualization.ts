import "@shared/contracts/shell-visualization";
import type { WebContents } from "electron";
import { handleWithEvent, onBroadcast } from "../ipc";
import { userEnv } from "../env";
import { ompPath } from "../omp/locate";
import { loadSavedShellTrace } from "../omp/session-tool-output";
import { ShellVisualizationService } from "../omp/shell-visualization";
import { createInstalledShellWorker, ShellWorkerFailure } from "../omp/shell-visualization-worker";
import { getSetting } from "./config";
import { reportedSessionFiles } from "./sessions";

const services = new Map<number, ShellVisualizationService>();
const closing = new Map<number, Promise<void>>();
const disposers = new Map<number, () => void>();
let shutdown: Promise<boolean> | undefined;

/** Called by the approved shutdown coordinator. False means cleanup could not be confirmed. */
export function stopShellVisualizations(): Promise<boolean> {
	if (shutdown) return shutdown;
	const done = Promise.withResolvers<boolean>();
	shutdown = done.promise;
	// Match Office teardown: allow five seconds for process cleanup and one for files.
	const timer = setTimeout(() => done.resolve(false), 6_000);
	void shutdown.then(() => clearTimeout(timer));
	for (const dispose of [...disposers.values()]) dispose();
	void Promise.allSettled([...closing.values()]).then(results => done.resolve(results.every(result => result.status === "fulfilled")));
	return shutdown;
}

/** One local presentation controller per invoking webContents, with no session-host authority. */
export function register(): void {
	function controller(sender: WebContents): ShellVisualizationService {
		if (shutdown || sender.isDestroyed()) throw new ShellWorkerFailure("cancelled");
		const existing = services.get(sender.id);
		if (existing) return existing;
		// Capture the predecessor now. Looking it up during startup can await this service's own close.
		const previousClose = closing.get(sender.id);
		const service = new ShellVisualizationService({
			loadTrace: (file, toolCallId) => loadSavedShellTrace(file, toolCallId, reportedSessionFiles),
			getSetting,
			async createWorker(onLoss, signal) {
				// A reload may deliver a new request before its previous worker finishes exiting.
				await previousClose;
				if (shutdown || signal.aborted) throw new ShellWorkerFailure("cancelled");
				const [executable, env] = await Promise.all([ompPath(), userEnv()]);
				if (shutdown || signal.aborted) throw new ShellWorkerFailure("cancelled");
				return createInstalledShellWorker({ executable, env, onLoss, signal });
			},
			onFrame(frame) { if (!shutdown && !sender.isDestroyed() && services.get(sender.id) === service) sender.send("shellviz:frame", frame); },
			onInvalidated(event) { if (!shutdown && !sender.isDestroyed() && services.get(sender.id) === service) sender.send("shellviz:invalidated", event); },
		});
		services.set(sender.id, service);
		const dispose = (): void => {
			if (services.get(sender.id) !== service) return;
			services.delete(sender.id);
			disposers.delete(sender.id);
			sender.removeListener("did-start-navigation", navigate);
			sender.removeListener("destroyed", dispose);
			sender.removeListener("render-process-gone", dispose);
			// Retain predecessors even if this service never reached worker startup.
			const done = Promise.allSettled([previousClose, service.close()]).then(results => {
				for (const result of results) if (result.status === "rejected") throw result.reason;
			});
			closing.set(sender.id, done);
			void done.then(() => { if (closing.get(sender.id) === done) closing.delete(sender.id); }, () => {
				// A failed tree close retains ownership and blocks every replacement for this sender.
			});
		};
		const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => { if (mainFrame && !inPlace) dispose(); };
		disposers.set(sender.id, dispose);
		sender.on("did-start-navigation", navigate);
		sender.once("destroyed", dispose);
		sender.once("render-process-gone", dispose);
		return service;
	}
	const cancelled = () => ({ status: "unavailable", reason: "cancelled" } as const);
	handleWithEvent("shellviz:open", (event, request) => shutdown ? cancelled() : controller(event.sender).open(request));
	handleWithEvent("shellviz:openSnapshot", (event, request) => shutdown ? cancelled() : controller(event.sender).openSnapshot(request));
	handleWithEvent("shellviz:updateSnapshot", (event, request) => shutdown ? cancelled() : controller(event.sender).updateSnapshot(request));
	handleWithEvent("shellviz:action", (event, handle, value) => shutdown ? cancelled() : controller(event.sender).action(handle, value));
	handleWithEvent("shellviz:release", (event, handle) => { if (!shutdown) services.get(event.sender.id)?.release(handle); });
	handleWithEvent("shellviz:cancel", (event, requestId) => { if (!shutdown) services.get(event.sender.id)?.cancel(requestId); });
	onBroadcast("config:changed", event => {
		if (shutdown) return;
		for (const service of services.values()) void service.settingsChanged(event.cwd).catch(() => {
			console.warn("[visual-omp] Could not update bash visualization settings.");
		});
	});
}
