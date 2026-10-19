/**
 * Windows refusing to start omp. CreateProcess fails with a Windows error that libuv has no name
 * for, so `child_process` throws "spawn UNKNOWN" synchronously and the cause is lost; node-pty
 * keeps the code in its message ("Cannot create process, error code: 4551"). A security policy is
 * one possible cause: Smart App Control and other application control policies block unsigned
 * programs that Microsoft's reputation service does not know, and omp's Windows builds are
 * unsigned, so a fresh omp release can be refused. Messages say what Windows confirmed and mark
 * the rest as a possible cause.
 */
import { execFile } from "node:child_process";

/** Thrown in place of the raw spawn error when Windows refused to start omp. */
export class OmpRefusedError extends Error {}

/**
 * `unexplained`: "spawn UNKNOWN", any CreateProcess error libuv cannot name. `appControl`: 4551,
 * an application control policy (Smart App Control or one set by an administrator). `groupPolicy`:
 * 1260, a Group Policy software restriction.
 */
export type StartRefusal = "unexplained" | "appControl" | "groupPolicy";

/** How Windows refused to start a program, from the error its start threw; null for other failures. */
export function startRefusal(error: unknown, platform: NodeJS.Platform = process.platform): StartRefusal | null {
	if (platform !== "win32" || !(error instanceof Error)) return null;
	const { code, syscall } = error as NodeJS.ErrnoException;
	if (code === "UNKNOWN" && syscall === "spawn") return "unexplained";
	const windowsCode = /\berror code: (\d+)\b/.exec(error.message)?.[1];
	return windowsCode === "4551" ? "appControl" : windowsCode === "1260" ? "groupPolicy" : null;
}

const SAC_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy";
const SAC_VALUE = "VerifiedAndReputablePolicyState";

/** `reg query` output for Smart App Control's state, where 1 is On (0 is Off and 2 is Evaluation, which blocks nothing). */
export function smartAppControlOn(regOutput: string): boolean {
	return new RegExp(`${SAC_VALUE}\\s+REG_DWORD\\s+0x0*1\\b`, "i").test(regOutput);
}

function readSmartAppControl(): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	try {
		execFile("reg", ["query", SAC_KEY, "/v", SAC_VALUE], { timeout: 5000, windowsHide: true }, (error, stdout) =>
			resolve(!error && smartAppControlOn(stdout)),
		);
	} catch {
		resolve(false);
	}
	return promise;
}

/** What to tell the user; `reported` is the original error message, kept for diagnosis. */
export function refusalMessage(refusal: StartRefusal, path: string, reported: string, smartAppControl: boolean): string {
	const lead = {
		unexplained: `Windows did not start omp (${path}) and reported no reason beyond "${reported}".`,
		appControl: `Windows blocked omp (${path}) under an application control policy ("${reported}").`,
		groupPolicy: `Windows blocked omp (${path}) under a Group Policy rule ("${reported}").`,
	}[refusal];
	if (smartAppControl && refusal !== "groupPolicy") {
		return `${lead} Smart App Control is on and may be the cause: it blocks unsigned programs that Microsoft does not recognize, and omp's Windows builds are unsigned. Review App & browser control in Windows Security, or ask whoever manages this computer. If Smart App Control is the cause, turning it off may allow omp to run, but it also stops Smart App Control from checking every other program.`;
	}
	return refusal === "unexplained"
		? `${lead} omp's Windows builds are unsigned, and antivirus software or an application control policy can block unsigned programs. Check whether your antivirus software blocked omp, or ask whoever manages this computer.`
		: `${lead} Ask whoever manages this computer to allow omp.`;
}

/** An `OmpRefusedError` when `error` means Windows refused to start omp at `path`; any other error unchanged. */
export async function ompStartError(error: unknown, path: string): Promise<unknown> {
	const refusal = startRefusal(error);
	if (!refusal) return error;
	// A Group Policy refusal is not Smart App Control's, so its state does not matter there.
	const smartAppControl = refusal !== "groupPolicy" && (await readSmartAppControl());
	return new OmpRefusedError(refusalMessage(refusal, path, (error as Error).message, smartAppControl));
}
