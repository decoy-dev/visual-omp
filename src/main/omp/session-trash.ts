import { lstat } from "node:fs/promises";
import { shell } from "electron";
import { sessionSummary } from "./sessions";
import { listHosts, stopHost } from "./host";
import { sessionOwnership } from "./elsewhere";

/** Keep every original path intact in the system Trash so the operating system can put it back. */
export async function trashSessionConversation(file: string): Promise<void> {
	if (!file.endsWith(".jsonl")) throw new Error("This is not an omp session file.");
	const session = await sessionSummary(file);
	const files = session ? [session.file, ...(session.previousSessionFiles ?? [])] : [file];
	for (const host of listHosts()) {
		if (host.phase !== "exited" && host.sessionFile && files.includes(host.sessionFile)) await stopHost(host.hostId);
	}
	const owners = await sessionOwnership(files);
	const blocked = files.filter(source => owners.get(source) !== "free");
	if (blocked.length) throw new Error(`This chat still has running or unverified omp owners. No files were moved to the system Trash:\n${blocked.join("\n")}`);
	const failures: string[] = [];
	for (const source of files) {
		for (const target of [source, source.slice(0, -".jsonl".length)]) {
			try {
				await lstat(target);
				await shell.trashItem(target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (failures.length) throw new Error(`Some chat files could not be moved to the system Trash. These paths remain:\n${failures.join("\n")}`);
}
