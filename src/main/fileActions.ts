import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { BrowserWindow, dialog, shell } from "electron";
import fileLabels from "../shared/i18n/en/fileActions.json";
import { previewablePath } from "./services/panes";

/** Refuse network/device namespaces before any filesystem access or shell invocation. */
export function localFilePath(value: unknown, platform: NodeJS.Platform = process.platform): string {
	if (typeof value !== "string" || !value || value.includes("\0") || /^[\\/]{2}|^[\\/]\?\?[\\/]/.test(value)) {
		throw new Error("Expected an absolute local path");
	}
	const absolute = platform === "win32" ? /^[a-z]:[\\/]/i.test(value) : isAbsolute(value);
	if (!absolute) throw new Error("Expected an absolute local path");
	return value;
}

export function showItem(value: unknown): void {
	shell.showItemInFolder(localFilePath(value));
}

export async function openFile(value: unknown): Promise<void> {
	const path = localFilePath(value);
	const resolved = localFilePath(await realpath(path));
	if (!(await stat(resolved)).isFile()) throw new Error("Not a file");
	try {
		await previewablePath(resolved);
	} catch {
		// A file association can run code. Ask before handing other files to the operating system.
		const win = BrowserWindow.getFocusedWindow();
		const options: Electron.MessageBoxOptions = {
			type: "warning", title: fileLabels.openTitle, message: fileLabels.openMessage.replace("{{name}}", basename(resolved)),
			detail: `${resolved}\n\n${fileLabels.openWarning}`,
			buttons: [fileLabels.cancel, fileLabels.open], defaultId: 0, cancelId: 0, noLink: true,
		};
		const decision = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
		if (decision.response !== 1) return;
	}
	const failure = await shell.openPath(resolved);
	if (failure) throw new Error(failure);
}
