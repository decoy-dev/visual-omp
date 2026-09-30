import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, dialog, nativeImage } from "electron";
import { handle } from "../ipc";
import type { TuiEditorText } from "@shared/contracts/composer";
import { ompAgentDir } from "../omp/config-file";
import { getHost } from "../omp/host";
import { discoverCommands, editorTextFromScreen, ensureSttBinding, findPromptEditor } from "../services/composer";

const THUMB_EDGE = 96;
const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;

/** Content-addressed so pasting the same image twice reuses one file. */
async function saveTemp(bytes: Uint8Array, extension: string): Promise<string> {
	const ext = extension.toLowerCase().replace(/^\./, "");
	if (!SAFE_EXTENSION.test(ext)) throw new Error(`Unsupported file type: ${extension}`);
	const dir = join(tmpdir(), "visual-omp", "pasted");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	const file = join(dir, `pasted-image-${hash}.${ext}`);
	await writeFile(file, bytes, { mode: 0o600 });
	return file;
}

async function pickFiles(cwd: string): Promise<string[]> {
	const options: Electron.OpenDialogOptions = {
		title: "Attach files",
		defaultPath: cwd,
		properties: ["openFile", "multiSelections"],
	};
	const win = BrowserWindow.getFocusedWindow();
	const choice = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	return choice.canceled ? [] : choice.filePaths;
}

async function thumbnail(path: string): Promise<string | null> {
	const image = await nativeImage.createThumbnailFromPath(path, { width: THUMB_EDGE, height: THUMB_EDGE }).catch(() =>
		nativeImage.createFromPath(path),
	);
	if (image.isEmpty()) return null;
	const { width, height } = image.getSize();
	const scale = THUMB_EDGE / Math.max(width, height);
	const sized = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : image;
	return sized.toDataURL();
}

/** omp reads `keybindings.yml`, else `keybindings.yaml` (packages/tui/src/app-keybindings.ts). */
async function voiceKey(): Promise<{ key: string; changed: boolean }> {
	const dir = await ompAgentDir();
	const candidates = [join(dir, "keybindings.yml"), join(dir, "keybindings.yaml")];
	for (const file of candidates) {
		const source = await readFile(file, "utf8").catch(() => null);
		if (source === null) continue;
		const { key, text } = ensureSttBinding(source);
		if (text !== null) await writeFile(file, text);
		return { key, changed: text !== null };
	}
	const { key, text } = ensureSttBinding(null);
	await mkdir(dir, { recursive: true });
	await writeFile(candidates[0] ?? join(dir, "keybindings.yml"), text ?? "");
	return { key, changed: true };
}

async function tuiEditorText(hostId: string): Promise<TuiEditorText | null> {
	const host = getHost(hostId);
	const state = findPromptEditor(await host.debugValues());
	if (!state) return null;
	if (state.placeholderActive || state.textLength === 0) return { text: "", length: 0, complete: true };
	if (!state.previewTruncated) return { text: state.textPreview, length: state.textLength, complete: true };
	const fromScreen = editorTextFromScreen(await host.screenLines(), state);
	const text = fromScreen ?? state.textPreview;
	return { text, length: state.textLength, complete: text.length === state.textLength };
}

/** Deliver omp's image-path attachment syntax without Enter; caller submits message text afterward. */
function paste(hostId: string, text: string): void {
	if (!text.trim()) throw new Error("Image attachment paths are required");
	getHost(hostId).write(`\x1b[200~${text}\x1b[201~`);
}

export function register(): void {
	handle("composer:saveTemp", (bytes, extension) => saveTemp(bytes, extension));
	handle("composer:pickFiles", cwd => pickFiles(cwd));
	handle("composer:thumbnail", path => thumbnail(path));
	handle("composer:commands", async cwd => discoverCommands(cwd, await ompAgentDir()));
	handle("composer:voiceKey", () => voiceKey());
	handle("composer:tuiEditorText", hostId => tuiEditorText(hostId));
	handle("composer:paste", (hostId, text) => paste(hostId, text));
}
