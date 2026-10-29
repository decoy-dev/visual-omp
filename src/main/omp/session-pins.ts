import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionSummary } from "@shared/ipc";
import { userEnv } from "../env";
import { finishSessionPinMigration, getPrefs } from "../prefs";
import { agentDir } from "./paths";
import { rpcRequest } from "./rpc";

/** omp owns both the cross-process lock and atomic replacement. This app only reads its pin file. */
export async function loadPinnedSessionIds(): Promise<Set<string>> {
	try {
		const value: unknown = JSON.parse(await readFile(join(agentDir(await userEnv()), "session-pins.json"), "utf8"));
		return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Could not read omp session pins", error);
		return new Set();
	}
}

/** `/pin` is a consumed builtin in RPC, so no conversation or model request is started. */
export async function toggleSessionPin(sessionId: string, cwd = tmpdir()): Promise<boolean> {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("This chat does not have a valid omp session id.");
	const printed: string[] = [];
	const result = await rpcRequest(cwd, "prompt", {
		flags: ["--no-session", "--no-lsp", "--no-title", "--no-tools", "--no-skills", "--no-rules", "--no-extensions"],
		timeoutMs: 30_000,
		messages: {
			timeout: "omp did not confirm the chat pin in time.",
			exited: "omp stopped before it confirmed the chat pin.",
			failed: "omp could not change the chat pin.",
		},
		onMessage: message => {
			if (typeof message !== "object" || message === null) return;
			const value = message as { type?: unknown; text?: unknown };
			if (value.type === "command_output" && typeof value.text === "string") printed.push(value.text);
		},
	}, { message: `/pin ${sessionId}` });
	const output = printed.join("\n").trim();
	if (!result || typeof result !== "object" || !("agentInvoked" in result) || result.agentInvoked !== false ||
		!/^Session (?:pinned to the top of the resume list\.|unpinned\.)$/.test(output)) {
		throw new Error(output || "omp did not confirm the chat pin.");
	}
	return output.startsWith("Session pinned");
}

const changing = new Set<string>();
/** The visible conversation is pinned when omp pins any of its retained physical copies. */
export async function toggleConversationPin(session: SessionSummary): Promise<boolean> {
	if (changing.has(session.id)) throw new Error("omp is already changing this chat's pin.");
	changing.add(session.id);
	try {
		const pins = await loadPinnedSessionIds();
		const pinnedIds = [session.id, ...(session.previousSessionIds ?? [])].filter(id => pins.has(id));
		if (!pinnedIds.length) return await toggleSessionPin(session.id);
		for (const id of pinnedIds) await toggleSessionPin(id);
		return false;
	} finally {
		changing.delete(session.id);
	}
}

let migrating: Promise<void> | undefined;
/** Retry interrupted migrations, but never toggle an already migrated pin back off. */
export async function migrateSessionPins(sessions: readonly SessionSummary[]): Promise<void> {
	const legacy = getPrefs().pinnedSessions;
	// An unavailable or empty sessions tree cannot establish that the old ids were deleted.
	if (!legacy || (legacy.length > 0 && sessions.length === 0)) return;
	migrating ??= (async () => {
		const pinned = await loadPinnedSessionIds();
		for (const id of getPrefs().pinnedSessions ?? []) {
			if (pinned.has(id)) continue;
			const session = sessions.find(item => item.id === id || item.previousSessionIds?.includes(id));
			// Deleted chats cannot be resolved by omp's builtin and need no pin in its picker.
			if (!session || pinned.has(session.id)) continue;
			if (await toggleSessionPin(session.id, tmpdir())) pinned.add(session.id);
			else throw new Error("omp did not retain the migrated chat pin.");
		}
		finishSessionPinMigration();
	})().finally(() => { migrating = undefined; });
	await migrating;
}
