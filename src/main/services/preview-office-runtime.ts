import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { userEnv } from "../env";
import { resolveExecutable } from "./executable";
import createOfficeWorker from "./preview-office.worker?nodeWorker";
import { OfficeTeardownError, terminateOfficeTree } from "./preview-office-process";

let treeUncertain = false;

export interface OfficeConversionRuntime {
	detect(): Promise<string | null>;
	rewrite(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
	convert(executable: string, input: string, output: string, profile: string, signal: AbortSignal): Promise<boolean>;
}

/** Confirmed against LibreOffice's Common.xcs and Inet.xcs schemas; the profile never inherits user settings. */
export function officeProfile(proxyPort: number): string {
	const item = (path: string, name: string, value: string | number | boolean) => `<item oor:path="${path}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`;
	const security = "/org.openoffice.Office.Common/Security/Scripting", inet = "/org.openoffice.Inet/Settings";
	return `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">${[
		item(security, "MacroSecurityLevel", 3), item(security, "DisableMacrosExecution", true), item(security, "DisableActiveContent", true), item(security, "BlockUntrustedRefererLinks", true),
		item(inet, "ooInetProxyType", 2), item(inet, "ooInetHTTPProxyName", "127.0.0.1"), item(inet, "ooInetHTTPSProxyName", "127.0.0.1"),
		item(inet, "ooInetHTTPProxyPort", proxyPort), item(inet, "ooInetHTTPSProxyPort", proxyPort), item(inet, "ooInetNoProxy", ""),
	].join("")}</oor:items>`;
}

export function officeEnvironment(source: NodeJS.ProcessEnv, proxyPort: number): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "LANG", "LC_ALL"]) {
		const sourceKey = Object.keys(source).find(value => value.toUpperCase() === key.toUpperCase());
		if (sourceKey && source[sourceKey] !== undefined) env[key] = source[sourceKey];
	}
	const proxy = `http://127.0.0.1:${proxyPort}`;
	return { ...env, http_proxy: proxy, https_proxy: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, all_proxy: proxy, no_proxy: "", NO_PROXY: "", SAL_USE_VCLPLUGIN: "svp" };
}

export async function detectLibreOffice(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string | null> {
	const found = await resolveExecutable("soffice", env, platform);
	if (found) return found;
	const programFiles = Object.entries(env).find(([key]) => key.toLowerCase() === "programfiles")?.[1] ?? "C:\\Program Files";
	const candidates = platform === "darwin" ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
		: platform === "win32" ? [win32.join(programFiles, "LibreOffice", "program", "soffice.exe")] : ["/usr/bin/soffice"];
	for (const path of candidates) {
		const executable = await resolveExecutable(path, env, platform);
		if (executable) return executable;
	}
	return null;
}

/** Process spawning is behind this interface so tests never require an installed LibreOffice. */
export const officeRuntime: OfficeConversionRuntime = {
	async detect() { return detectLibreOffice(await userEnv()); },
	async rewrite(bytes, signal) {
		if (signal.aborted) throw new Error("revoked");
		const worker = createOfficeWorker({ resourceLimits: { maxOldGenerationSizeMb: 256 } });
		const result = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
		const stop = () => result.reject(new Error("revoked"));
		const timer = setTimeout(() => result.reject(new Error("unsafe")), 15_000);
		signal.addEventListener("abort", stop, { once: true });
		worker.once("message", (message: { ok: boolean; bytes: Uint8Array<ArrayBuffer> }) => message.ok ? result.resolve(message.bytes) : result.reject(new Error("unsafe")));
		worker.once("error", () => result.reject(new Error("unsafe")));
		worker.once("exit", () => result.reject(new Error("unsafe")));
		worker.postMessage(bytes, [bytes.buffer]);
		try { return await result.promise; }
		finally { clearTimeout(timer); signal.removeEventListener("abort", stop); await worker.terminate(); }
	},
	async convert(executable, input, output, profile, signal) {
		if (treeUncertain) throw new OfficeTeardownError();
		const source = await userEnv();
		// Reserve and close a random loopback port. It is only a second barrier, not an OS network sandbox.
		const server = createServer();
		const listening = Promise.withResolvers<number>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") listening.reject(new Error("Proxy setup failed."));
			else server.close(error => error ? listening.reject(error) : listening.resolve(address.port));
		});
		const port = await listening.promise;
		await writeFile(join(profile, "user", "registrymodifications.xcu"), officeProfile(port), { mode: 0o600 });
		if (signal.aborted) return false;
		const env = officeEnvironment(source, port);
		const taskkill = process.platform === "win32" ? await resolveExecutable("taskkill.exe", source) : null;
		if (process.platform === "win32" && !taskkill) throw new Error("Process-tree termination is unavailable.");
		const done = Promise.withResolvers<boolean>();
		const child = spawn(executable, ["--headless", "--norestore", "--nolockcheck", "--nodefault", `-env:UserInstallation=${pathToFileURL(profile).href}`, "--convert-to", "pdf", "--outdir", output, input],
			{ cwd: output, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: "ignore" });
		let stopped = false;
		const kill = () => {
			if (stopped) return;
			stopped = true;
			void terminateOfficeTree(child, taskkill).then(() => done.resolve(false), error => {
				treeUncertain = true;
				done.reject(error);
			});
		};
		child.once("error", () => { if (!stopped) done.resolve(false); });
		child.once("close", code => { if (!stopped) done.resolve(code === 0); });
		signal.addEventListener("abort", kill, { once: true });
		if (signal.aborted) kill();
		try { return await done.promise; }
		finally { signal.removeEventListener("abort", kill); }
	},
};
