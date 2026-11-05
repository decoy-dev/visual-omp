import { execFile, type ChildProcess } from "node:child_process";

export class OfficeTeardownError extends Error {
	constructor() { super("The Office process tree could not be confirmed stopped."); this.name = "OfficeTeardownError"; }
}

/** Success confirms tree termination, independently of whether the launcher ever emits close. */
export async function terminateOfficeTree(child: ChildProcess, taskkill: string | null, platform: NodeJS.Platform = process.platform): Promise<void> {
	if (!child.pid) return;
	const stopped = Promise.withResolvers<void>();
	const deadline = setTimeout(() => stopped.reject(new OfficeTeardownError()), 5000);
	let poll: NodeJS.Timeout | undefined;
	try {
		if (platform === "win32") {
			if (!taskkill) throw new OfficeTeardownError();
			execFile(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000, killSignal: "SIGKILL" }, error => error ? stopped.reject(new OfficeTeardownError()) : stopped.resolve());
		} else {
			try { process.kill(-child.pid, "SIGKILL"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw new OfficeTeardownError(); }
			const check = () => {
				try { process.kill(-child.pid!, 0); poll = setTimeout(check, 25); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") stopped.resolve(); else stopped.reject(new OfficeTeardownError()); }
			};
			check();
		}
		await stopped.promise;
	} finally { clearTimeout(deadline); clearTimeout(poll); }
}
