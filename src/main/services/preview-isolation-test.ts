import { lstatSync, realpathSync, statSync } from "node:fs";
import { open as openInspector } from "node:inspector";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { app } from "electron";

// Captured in main at startup. Neither IPC nor page content can enable this exception.
export const previewIsolationTest = process.env.VOMP_PREVIEW_ISOLATION_TEST === "1";
const fixtureFile = process.env.VOMP_PREVIEW_ISOLATION_FILE;
const configuredPath = previewIsolationTest && fixtureFile && isAbsolute(fixtureFile) ? resolve(fixtureFile) : null;
// The parent already exists when the fixture provider starts; the HTML file may be written later.
const pinned = (() => {
	if (!configuredPath) return null;
	try {
		const parent = realpathSync.native(dirname(configuredPath));
		const info = statSync(parent);
		if (!info.isDirectory()) return null;
		return { parent, path: join(parent, basename(configuredPath)), dev: info.dev, ino: info.ino };
	} catch { return null; }
})();

export interface IsolationReadIdentity { path: string; dev: number; ino: number }

/** Check both the startup pin and, after reading, the identity of the opened document. */
export function isIsolationTestDocument(path: string, saved: boolean, read?: IsolationReadIdentity): boolean {
	if (!saved || !configuredPath || !pinned || path !== pinned.path) return false;
	try {
		if (realpathSync.native(dirname(configuredPath)) !== pinned.parent || realpathSync.native(configuredPath) !== pinned.path) return false;
		const parent = statSync(pinned.parent);
		const file = lstatSync(configuredPath);
		if (parent.dev !== pinned.dev || parent.ino !== pinned.ino || !file.isFile() || file.isSymbolicLink()) return false;
		return !read || (read.path === pinned.path && read.dev === file.dev && read.ino === file.ino);
	} catch { return false; }
}

/** Programmatic inspector startup works with the packaged app's CLI-inspector fuse disabled. */
export function startPreviewIsolationInspector(): void {
	if (!previewIsolationTest) return;
	if (!pinned || !process.env.VOMP_DEV_PROFILE || !isAbsolute(process.env.VOMP_DEV_PROFILE)) throw new Error("Isolation testing requires an absolute fixture file with an existing parent and scratch app profile.");
	openInspector(9229, "127.0.0.1", false);
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
	app.commandLine.appendSwitch("remote-debugging-port", "9333");
}
