import { execFile, spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { app, shell } from "electron";
import { z } from "zod";
import type { AppInstallInfo, AppInstallSwitchInfo, AppInstallSwitchRun, AppInstallOperation } from "@shared/contracts/updates";
import { userEnv } from "../../env";
import { writeText } from "../../files";
import { handle } from "../../ipc";
import { BREW_CASK, PACKAGE_REPOSITORY, brewSwitchCommand } from "../../services/install-switch";
import { appBundlePath, brewCandidates, plistVersion } from "../../services/updates";
import { resolveExecutable } from "../../services/executable";

const CaskInfo = z.object({ casks: z.array(z.object({ version: z.string() })) });
const exists = (path: string) => access(path).then(() => true, () => false);
const canonical = (path: string) => realpath(path).catch(() => path);

interface SwitchProbe extends AppInstallSwitchInfo {
	binary: string | null;
}
interface Prepared extends AppInstallSwitchRun {
	manager: "brew";
	binary: string;
}

/** All switch probes run on demand in About, outside the startup path. */
export function registerInstallSwitch(deps: {
	installInfo(): Promise<AppInstallInfo>;
	caskApps(brew: string): Promise<string[]>;
	beginOperation(kind: AppInstallOperation): void;
	endOperation(kind: AppInstallOperation): void;
}): void {
	let prepared: Prepared | null = null;
	let starting = false;
	const pendingFile = join(app.getPath("userData"), "update-pending.json");

	async function probe(): Promise<SwitchProbe | null> {
		if (!app.isPackaged) return null;
		const { method } = await deps.installInfo();
		const env = await userEnv();
		if (method === "dmg") {
			let first: string | null = null;
			for (const candidate of brewCandidates(env.PATH ?? "", homedir())) {
				if (!await resolveExecutable(candidate, env)) continue;
				first ??= candidate;
				for (const target of await deps.caskApps(candidate)) {
					if (await exists(join(target, "Contents", "MacOS", "visual-omp"))) return { manager: "brew", available: true, binary: candidate, existing: true, target };
				}
			}
			return { manager: "brew", available: first !== null, binary: first, existing: false, target: null };
		}
		return null;
	}

	async function brewRun(binary: string, args: string[]): Promise<string> {
		const env = await userEnv();
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		execFile(binary, args, { env: { ...env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ASK: "1" }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message));
			else resolve(stdout.trim());
		});
		return promise;
	}

	async function start(): Promise<AppInstallSwitchRun> {
		if (starting) throw new Error("An install switch is already being prepared.");
		deps.beginOperation("switch");
		starting = true;
		prepared = null;
		try {
			const info = await probe();
			if (!info?.available || !info.binary) throw new Error("The package manager could not be found. Install it, then try again.");
			let target = info.target;
			let version: string | null = null;
			if (!info.existing) {
				await brewRun(info.binary, ["tap", "decoy-dev/tap", PACKAGE_REPOSITORY]);
				await brewRun(info.binary, ["update"]);
				const data = CaskInfo.parse(JSON.parse(await brewRun(info.binary, ["info", "--json=v2", "--cask", BREW_CASK])));
				version = data.casks[0]?.version ?? null;
				if (!version) throw new Error("Homebrew did not report a cask version.");
				// Homebrew's default appdir, with the same explicit environment option honored by the install command.
				const env = await userEnv();
				const opts = env.HOMEBREW_CASK_OPTS ?? "";
				const match = /(?:^|\s)--appdir=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(opts);
				let appdir = match?.[1] ?? match?.[2] ?? match?.[3] ?? "/Applications";
				if (appdir.startsWith("~/")) appdir = posix.join(homedir(), appdir.slice(2));
				if (!posix.isAbsolute(appdir)) throw new Error("Homebrew's app directory must be an absolute path.");
				target = posix.join(appdir, "visual-omp.app");
			}
			if (!target) throw new Error("The Homebrew copy could not be located.");
			const running = appBundlePath(process.execPath);
			const samePath = running !== null && await canonical(running) === await canonical(target);
			if (info.existing) version = plistVersion(await readFile(join(target, "Contents", "Info.plist"), "utf8"));
			const onDisk = await exists(target) ? plistVersion(await readFile(join(target, "Contents", "Info.plist"), "utf8")) : null;
			if (!info.existing && await exists(target) && onDisk !== version) {
				throw new Error("The app at Homebrew's destination has a different version. Update that copy first using its existing update flow, then try Switch to Homebrew again. No app files were changed.");
			}
			prepared = {
				manager: "brew", binary: info.binary, target, version, existing: info.existing,
				command: info.existing ? null : brewSwitchCommand(info.binary, target),
				canTrash: running !== null && !samePath,
			};
			if (!prepared.command) deps.endOperation("switch");
			return prepared;
		} catch (error) {
			deps.endOperation("switch");
			throw error;
		} finally { starting = false; }
	}

	async function complete(trashOld: boolean): Promise<void> {
		if (!app.isPackaged || !prepared) throw new Error("Prepare the install switch before restarting.");
		const run = prepared;
		deps.beginOperation("switch");
		try {
			const targets = await deps.caskApps(run.binary);
			const target = await canonical(run.target);
			if (!targets.includes(target)) throw new Error("Homebrew has not registered the new copy. Review the install output and try again.");
			const version = plistVersion(await readFile(join(target, "Contents", "Info.plist"), "utf8"));
			if (!version || version !== run.version || !await exists(join(target, "Contents", "MacOS", "visual-omp"))) throw new Error("The Homebrew copy could not be verified.");
			await writeText(pendingFile, JSON.stringify({ method: "brew", operation: "switch", from: app.getVersion(), to: version, at: Date.now() }));
			if (trashOld && run.canTrash) {
				const old = appBundlePath(process.execPath);
				if (old && await canonical(old) !== target) await shell.trashItem(old);
			}
			app.once("will-quit", () => {
				const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$0"';
				spawn("/bin/sh", ["-c", script, target, String(process.pid)], { detached: true, stdio: "ignore" }).unref();
			});
			app.quit();
		} catch (error) {
			deps.endOperation("switch");
			throw error;
		}
	}

	handle("updates:app:switchInfo", async () => {
		const info = await probe();
		return info ? { manager: info.manager, available: info.available, existing: info.existing, target: info.target } : null;
	});
	handle("updates:app:switchStart", start);
	handle("updates:app:switchComplete", complete);
	handle("updates:app:switchSettled", () => deps.endOperation("switch"));
}
