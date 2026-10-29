import { broadcast, handle } from "../ipc";
import { resolveSessionFile, sessionSummary } from "../omp/sessions";
import { forkSavedSession } from "../omp/fork";
import { toggleConversationPin } from "../omp/session-pins";
import { renameSavedSession } from "../omp/session-rename";

export function register(): void {
	handle("sessions:resolve", resolveSessionFile);
	handle("sessions:summary", sessionSummary);
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
