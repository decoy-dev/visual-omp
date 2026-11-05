import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import { resolveExecutable } from "./executable";

export interface BrowserLaunch { executable: string; args: string[] }

/** Discovery and launch both pass argument arrays directly to the OS, never through a shell. */
export async function runBrowserCommand({ executable, args }: BrowserLaunch): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(executable, args, { timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
		if (error) reject(error);
		else resolve(stdout.trim());
	});
	return promise;
}

/** A browser may remain open indefinitely; do not apply discovery's timeout to its process. */
export async function launchBrowserCommand(launch: BrowserLaunch): Promise<void> {
	if (launch.executable === "/usr/bin/open") { await runBrowserCommand(launch); return; }
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const child = spawn(launch.executable, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
	child.once("error", reject);
	child.once("spawn", () => { child.unref(); resolve(); });
	return promise;
}

/** Windows command-line quoting: backslashes are literal except immediately before a quote. */
function windowsArguments(command: string): string[] | null {
	const args: string[] = [];
	let value = "", quoted = false, started = false;
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (char === "\\") {
			let count = 1;
			while (command[index + 1] === "\\") { count++; index++; }
			if (command[index + 1] === '"') {
				value += "\\".repeat(Math.floor(count / 2));
				if (count % 2) { value += '"'; index++; }
			} else value += "\\".repeat(count);
			started = true;
		} else if (char === '"') {
			quoted = !quoted;
			started = true;
		} else if (/\s/.test(char) && !quoted) {
			if (started) { args.push(value); value = ""; started = false; }
		} else { value += char; started = true; }
	}
	if (quoted) return null;
	if (started) args.push(value);
	return args;
}

/** Desktop Exec fields have their own quoting rules; they are not shell commands. */
function desktopArguments(command: string): string[] | null {
	const args: string[] = [];
	let value = "", quoted = false, started = false;
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (char === "\\") {
			if (++index === command.length) return null;
			value += command[index]; started = true;
		} else if (char === '"') { quoted = !quoted; started = true; }
		else if (/\s/.test(char) && !quoted) {
			if (started) { args.push(value); value = ""; started = false; }
		} else { value += char; started = true; }
	}
	if (quoted) return null;
	if (started) args.push(value);
	return args;
}

const SHELL = /^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|sh|bash|dash|zsh|fish)(?:\.exe)?$/i;

async function windowsBrowser(path: string): Promise<BrowserLaunch | null> {
	const reg = await resolveExecutable("reg.exe");
	if (!reg) return null;
	const association = await runBrowserCommand({ executable: reg, args: ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"] });
	const progId = /^\s*ProgId\s+REG_SZ\s+([\w.-]+)\s*$/im.exec(association)?.[1];
	if (!progId) return null;
	const registration = await runBrowserCommand({ executable: reg, args: ["query", `HKCR\\${progId}\\shell\\open\\command`, "/ve"] });
	const command = /^\s*.+?\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(registration)?.[1];
	if (!command) return null;
	const tokens = windowsArguments(command);
	if (!tokens?.length) return null;
	const expanded = tokens.map(token => token.replace(/%([a-z_][a-z\d_]*)%/gi, (original, name: string) => Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? original));
	const executable = expanded.shift()!;
	if (!win32.isAbsolute(executable) || !/\.exe$/i.test(executable) || SHELL.test(win32.basename(executable)) || executable.includes("%")) return null;
	let replaced = false;
	const args: string[] = [];
	for (const token of expanded) {
		if (/^%(?:1|l|u)$/i.test(token)) { args.push(path); replaced = true; }
		else if (token === "%*") continue;
		else if (/%(?:1|l|u|\*)/i.test(token)) return null;
		else args.push(token);
	}
	if (!replaced) return null;
	return { executable, args };
}

async function linuxBrowser(path: string): Promise<BrowserLaunch | null> {
	const settings = await resolveExecutable("xdg-settings");
	if (!settings) return null;
	const desktop = await runBrowserCommand({ executable: settings, args: ["get", "default-web-browser"] });
	if (!/^[\w.-]+\.desktop$/.test(desktop)) return null;
	const roots = [process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")];
	for (const root of roots) {
		if (!isAbsolute(root)) continue;
		const file = join(root, "applications", desktop);
		let text: string;
		try { text = await readFile(file, "utf8"); } catch { continue; }
		const entry: Record<string, string> = {};
		let active = false;
		for (const line of text.split(/\r?\n/)) {
			if (line.startsWith("[")) { active = line.trim() === "[Desktop Entry]"; continue; }
			if (!active || line.startsWith("#")) continue;
			const property = /^([A-Za-z]+)=(.*)$/.exec(line);
			if (property) entry[property[1]!] = property[2]!;
		}
		if (entry.Hidden === "true" || !entry.Exec) return null;
		const tokens = desktopArguments(entry.Exec);
		if (!tokens?.length) return null;
		const command = tokens.shift()!;
		if (SHELL.test(basename(command)) || tokens.some(token => SHELL.test(basename(token)))) return null;
		const executable = isAbsolute(command) ? command : await resolveExecutable(command);
		if (!executable) return null;
		const args: string[] = [];
		let replaced = false;
		for (const token of tokens) {
			if (/^%[fFuU]$/.test(token)) { args.push(/[uU]/.test(token) ? pathToFileURL(path).href : path); replaced = true; }
			else if (token === "%i") { if (entry.Icon) args.push("--icon", entry.Icon); }
			else if (token === "%c") args.push(entry.Name || desktop);
			else if (token === "%k") args.push(file);
			else if (/%(?!%)/.test(token.replace(/%%/g, ""))) return null;
			else args.push(token.replace(/%%/g, "%"));
		}
		if (!replaced) args.push(pathToFileURL(path).href);
		return { executable, args };
	}
	return null;
}

/** Null keeps the existing association fallback, which the confirmation must explain before launch. */
export async function defaultBrowserLaunch(path: string, platform: NodeJS.Platform = process.platform): Promise<BrowserLaunch | null> {
	try {
		if (platform === "darwin") {
			const browser = await app.getApplicationInfoForProtocol("https://");
			return isAbsolute(browser.path) && /\.app$/i.test(browser.path) ? { executable: "/usr/bin/open", args: ["-a", browser.path, "--", path] } : null;
		}
		if (platform === "win32") return await windowsBrowser(path);
		return await linuxBrowser(path);
	} catch { return null; }
}
