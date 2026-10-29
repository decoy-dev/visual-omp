import { resolve } from "node:path";
import { z } from "zod";
import { listHosts } from "./host";
import { sessionOwnership } from "./elsewhere";
import { rpcRequests } from "./rpc";
import { resolveSessionFile, sessionSummary } from "./sessions";

/** Use omp's user-title writer, which persists the title slot and its title_change entry together. */
export async function renameSavedSession(input: string, name: string): Promise<{ title: string; file: string; id: string; movedFrom: string | null }> {
	const file = await resolveSessionFile(resolve(input));
	const summary = await sessionSummary(file);
	if (!summary) throw new Error("This saved chat could not be found.");
	if (!name.trim()) throw new Error("Enter a name for this chat.");
	if (listHosts().some(host => host.sessionFile === file && host.phase !== "exited") || (await sessionOwnership([file])).get(file) !== "free") {
		throw new Error("This chat is running in omp. Stop it before renaming its saved file.");
	}
	const identity = z.object({ sessionFile: z.string().min(1), sessionId: z.string().min(1) });
	const [, , state] = await rpcRequests(summary.cwd, [
		{ type: "get_state", validate: data => {
			const current = identity.parse(data);
			if (resolve(current.sessionFile) !== file || current.sessionId !== summary.id) {
				throw new Error("omp opened a different session before the rename. No name was changed.");
			}
		} },
		{ type: "set_session_name", params: { name: name.trim() } },
		{ type: "get_state" },
	], {
		flags: ["--resume", file, "--no-lsp", "--no-title", "--no-tools", "--no-skills", "--no-rules", "--no-extensions"],
		timeoutMs: 30_000,
		waitForExit: true,
		messages: {
			timeout: "omp did not confirm the chat name in time.",
			exited: "omp stopped before it confirmed the chat name.",
			failed: "omp could not rename the saved chat.",
		},
	});
	const saved = identity.extend({ sessionName: z.string().min(1) }).safeParse(state);
	if (!saved.success) throw new Error("omp did not confirm the saved chat name and identity.");
	const destination = resolve(saved.data.sessionFile);
	const written = await sessionSummary(destination);
	if (!written || written.file !== destination || written.id !== saved.data.sessionId ||
		(destination === file && saved.data.sessionId !== summary.id)) {
		throw new Error("omp reported a changed chat destination that could not be confirmed. Check the saved files before renaming again.");
	}
	return { title: saved.data.sessionName, file: destination, id: saved.data.sessionId, movedFrom: destination === file ? null : file };
}
