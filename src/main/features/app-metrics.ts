import "@shared/contracts/app-metrics";
import { cpus } from "node:os";
import { app, BrowserWindow } from "electron";
import { handle } from "../ipc";
import { AppMetricsSampler } from "../services/app-metrics";

export function register(): void {
	const sampler = new AppMetricsSampler(() => app.getAppMetrics(), cpus().length);
	handle("app:metrics", reset => {
		if (typeof reset !== "boolean") throw new Error("Invalid app metrics request");
		// Electron also updates document.visibilityState on hide/minimize. Refuse native
		// sampling here as well, including the brief interval before that DOM event arrives.
		if (!BrowserWindow.getAllWindows().some(window => !window.isDestroyed() && window.isVisible() && !window.isMinimized())) {
			sampler.reset();
			return { cpuPercent: null, memoryBytes: null };
		}
		return sampler.sample(reset);
	});
}
