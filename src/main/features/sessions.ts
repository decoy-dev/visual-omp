import { broadcast, handle } from "../ipc";
import { resolveSessionFile, sessionFileSize, sessionSummary } from "../omp/sessions";
import { forkSavedSession } from "../omp/fork";
import { toggleConversationPin } from "../omp/session-pins";
import { renameSavedSession } from "../omp/session-rename";
import { helperSessionFile } from "../omp/helper-file";
import { loadSavedToolOutput } from "../omp/session-tool-output";
import { listHosts } from "../omp/host";
import { followedSessionFiles } from "../omp/follow";

/** Current main-owned reports only; asking to read a file never registers it. */
function reportedSessionFiles(): readonly string[] {
	return [
		...listHosts().flatMap(host => host.sessionFile === null ? [] : [host.sessionFile]),
		...followedSessionFiles(),
	];
}

export function register(): void {
	handle("sessions:resolve", resolveSessionFile);
	handle("sessions:summary", sessionSummary);
	handle("sessions:size", sessionFileSize);
	handle("sessions:helperFile", helperSessionFile);
	handle("sessions:toolOutput", (file, toolCallId, manual) => loadSavedToolOutput(file, toolCallId, manual, reportedSessionFiles));
	handle("sessions:fork", forkSavedSession);
	handle("sessions:pin", async file => {
		const session = await sessionSummary(file);
		if (!session) throw new Error("This saved chat could not be found.");
		const pinned = await toggleConversationPin(session);
		broadcast("sessions:changed", { cwd: null });
		return pinned;
	});
	handle("sessions:rename", async (file, title) => {
		const name = await renameSavedSession(file, title);
		broadcast("sessions:changed", { cwd: null });
		return name;
	});
}
