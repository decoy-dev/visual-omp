/**
 * New users start on "Ask me first" (omp `tools.approvalMode: always-ask`), while omp's own default
 * stays Auto (`yolo`) for everyone who already chose or inherited it.
 *
 * prefs.ts marks a profile `pending` when there was no preferences file at launch (a fresh profile).
 * While pending, the check runs at app start, before every `config:approval` read and before every
 * chat's omp starts (`gateHostStart`), sharing one run between concurrent callers:
 *
 * 1. omp reports where `tools.approvalMode` comes from (`omp read cfg://tools.approvalMode`). Only omp's
 *    built-in default counts as unset; any other source (a global or project file, the environment)
 *    is an explicit choice, so the profile is marked done without writing.
 * 2. When it is unset, `always-ask` is written to the global config inside the config file's own edit
 *    transaction (`editConfig`, which queues every app write to that file), and only if the file still
 *    has no approval mode at that moment. A choice the user saves between step 1 and step 2 is queued
 *    ahead of the default, so the default sees it and writes nothing.
 * 3. The profile is marked done, so the check never runs again.
 *
 * When omp can't be read (not installed yet, or the read fails) the profile stays pending and the next
 * caller retries. A failed read does not show that the user has no explicit choice, so no chat starts
 * while the check is unverified: `gateHostStart` rejects the start with an error the chat shows, and
 * the next start runs the check again.
 */
import type { SettingSource } from "@shared/contracts/config";
import type { HostStartOptions } from "@shared/ipc";
import { editConfig } from "../omp/config-file";
import { documentJson, getPath, setDocumentPath } from "./omp-config";

export type NewUserApproval = "pending" | "done";

/** `write`: set the global default, then mark done. `skip`: mark done without writing. `none`: nothing to do. */
export type NewUserApprovalAction = "write" | "skip" | "none";

export function newUserApprovalAction(state: NewUserApproval | undefined, modeSource: SettingSource): NewUserApprovalAction {
	if (state !== "pending") return "none";
	return modeSource === "default" ? "write" : "skip";
}

/** `settled`: nothing left to do. `unverified`: the profile is pending and omp could not be read. */
export type NewUserApprovalResult = "settled" | "unverified";

export interface NewUserApprovalDeps {
	state(): NewUserApproval | undefined;
	markDone(): void;
	/** Source layer of the effective `tools.approvalMode`; rejects when omp can't be read. */
	readSource(): Promise<SettingSource>;
	/** Write the default if the global file still has no approval mode; resolves whether it wrote. */
	writeDefault(): Promise<boolean>;
}

/** The check as one shared run: concurrent callers wait for the same attempt; a failed attempt is retried by the next call. */
export function newUserApprovalRunner(deps: NewUserApprovalDeps): () => Promise<NewUserApprovalResult> {
	let running: Promise<NewUserApprovalResult> | null = null;
	return () => {
		if (deps.state() !== "pending") return Promise.resolve("settled");
		running ??= (async (): Promise<NewUserApprovalResult> => {
			try {
				const action = newUserApprovalAction(deps.state(), await deps.readSource());
				if (action === "none") return "settled";
				if (action === "write") await deps.writeDefault();
				deps.markDone();
				return "settled";
			} catch {
				return "unverified";
			} finally {
				running = null;
			}
		})();
		return running;
	};
}

/**
 * Set global `tools.approvalMode: always-ask` in one config transaction, unless the file has a mode by
 * then. A YAML `null` counts as unset, as it does for omp (config.ts `layerValue`).
 */
export async function writeApprovalDefaultIfUnset(): Promise<boolean> {
	let wrote = false;
	await editConfig("global", undefined, doc => {
		if ((getPath(documentJson(doc), ["tools", "approvalMode"]) ?? null) !== null) return;
		setDocumentPath(doc, ["tools", "approvalMode"], "always-ask");
		wrote = true;
	});
	return wrote;
}

/** Rejects a fresh profile's host start while the check can't read omp's settings. */
export const UNVERIFIED_APPROVAL_MESSAGE =
	"visual-omp couldn't read omp's settings, so it couldn't apply the default permission level for a new install. Check that omp runs in a terminal, then start omp again.";

/**
 * Wrap the host start so every chat's omp waits for the check. Existing profiles settle at once and
 * start unchanged. When a fresh profile's check is unverified, it runs once more (the attempt it joined
 * may have started before omp was ready); still unverified, the start is rejected and nothing runs, so
 * the profile stays pending and the next start tries again.
 */
export function gateHostStart<T>(
	check: () => Promise<NewUserApprovalResult>,
	start: (options: HostStartOptions) => Promise<T>,
): (options: HostStartOptions) => Promise<T> {
	return async options => {
		if ((await check()) === "unverified" && (await check()) === "unverified") throw new Error(UNVERIFIED_APPROVAL_MESSAGE);
		return start(options);
	};
}
