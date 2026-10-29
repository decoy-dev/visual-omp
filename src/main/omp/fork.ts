import { z } from "zod";
import { rpcRequests } from "./rpc";
import { resolveSessionFile } from "./sessions";

const ForkResult = z.object({ cancelled: z.boolean() });
const ForkState = z.object({ sessionFile: z.string(), sessionId: z.string() });

/** Fork from a read-only RPC snapshot; the source process retains its lease and session. */
export async function forkSavedSession(file: string, folder: string, entryId?: string): Promise<{ file: string; id: string }> {
	const source = await resolveSessionFile(file);
	const [fork, state] = await rpcRequests(folder, [
		{ type: "fork", params: entryId === undefined ? {} : { entryId } },
		{ type: "get_state" },
	], {
		flags: ["--resume", source, "--no-tools", "--no-lsp", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-title"],
		timeoutMs: 30_000,
		waitForExit: true,
		messages: {
			timeout: "omp did not finish copying the chat in time.",
			exited: "omp stopped before it finished copying the chat.",
			failed: "omp could not copy the chat.",
		},
	});
	if (ForkResult.parse(fork).cancelled) throw new Error("omp cancelled copying the chat.");
	const copied = ForkState.parse(state);
	if (copied.sessionFile === source) throw new Error("omp did not create a copy of the chat.");
	return { file: copied.sessionFile, id: copied.sessionId };
}
