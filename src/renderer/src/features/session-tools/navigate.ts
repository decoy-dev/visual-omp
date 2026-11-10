/**
 * Rewind and resume-from-here use omp's `/tree` selector; fork uses a separate RPC process.
 *
 * Classic hosts drive `/tree` with keys and confirm its painted row. TSP hosts activate omp's
 * session entry key and recover its exact restored editor text through semantic transfer.
 * Picking a user message rewinds past it; picking another entry continues from that point.
 */
import { i18n } from "../../i18n";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { screenActivity } from "../../state/tsp/screen-activity";
import { OmpBusyError, press, readScreen, readyEditor, waitForScreen } from "./drive";
import { parseStatusLine } from "./screen";
import { parseSessionTree, rowProbe, type SelectorMode, selectorRows, type SessionTree, type TreeEntry } from "./tree";
import { navigateSemantic } from "./navigateTsp";
import { cancelRewindUndo, offerRewindUndo, rewindCheckpoint } from "./rewindUndo";

export class NavigationError extends Error {}

const TREE_TITLE = "Session Tree";

/** The session file's tree, with the leaf omp is really on (a rewind moves it without writing). */
export async function loadTree(session: SessionController): Promise<SessionTree> {
	const file = session.sessionFile;
	if (!file) throw new NavigationError(i18n.t("session:navigate.noFile"));
	const host = session.getSnapshot().host;
	const newest = host && host.phase !== "exited" ? file : await window.vomp.invoke("sessions:resolve", file);
	const tree = parseSessionTree(await window.vomp.invoke("sessions:read", newest));
	const leaf = session.getSnapshot().displayLeaf;
	return leaf && tree.entries.has(leaf) ? { ...tree, leafId: leaf } : tree;
}

/** Whether the highlighted `/tree` row (`│ › • user: …`) shows `probe`. */
function rowMatches(lines: readonly string[], probe: string): boolean {
	const row = lines.findLast(line => /^\s*[│┃]?\s*›\s/.test(line));
	return row?.replace(/\s+/g, " ").includes(probe) ?? false;
}

/** Move the `/tree` cursor onto `probe`: jump by the computed index, then scan when the guess missed. */
async function focusRow(session: SessionController, index: number, total: number, probe: string, assertCurrent: () => void): Promise<boolean> {
	assertCurrent();
	await press(session, index > 0 ? `home ${Array.from({ length: index }, () => "down").join(" ")}` : "home");
	if (await waitForScreen(session, lines => rowMatches(lines, probe), 800)) return true;
	assertCurrent();
	await press(session, "home");
	for (let step = 0; step <= total + 4; step++) {
		if (rowMatches(await readScreen(session), probe)) return true;
		assertCurrent();
		await press(session, "down");
	}
	return false;
}

export interface NavigateResult {
	/** Text omp moved back into its editor (rewinding past a user message), now in the app's composer. */
	draft: string | null;
}

/**
 * Move the chat to `entryId` via `/tree`. For a user message this rewinds to just before it and puts
 * its text in the composer. Throws NavigationError when omp could not be driven there (the caller
 * then offers omp's own screen).
 */
export async function navigateTo(session: SessionController, entryId: string): Promise<NavigateResult> {
	if (session.getSnapshot().working) throw new NavigationError(i18n.t("session:navigate.busy"));
	await readyEditor(session);
	const tree = await loadTree(session);
	const entry = tree.entries.get(entryId);
	if (!entry) throw new NavigationError(i18n.t("session:navigate.missing"));
	cancelRewindUndo(session);
	const checkpoint = rewindCheckpoint(session);
	try {
		const result = await navigateEntry(session, tree, entry);
		const leaf = tree.leafId && tree.entries.get(tree.leafId);
		const nextLeaf = entry.userTurn ? entry.parentId : entry.id;
		const restorable = leaf && !leaf.userTurn && (session.getSnapshot().host?.transport === "tsp" || rowProbe(leaf) !== null);
		if (restorable && nextLeaf !== tree.leafId && checkpoint.current()) {
			offerRewindUndo(session, checkpoint, result.draft !== null, async (assertCurrent, confirmLeaf) => {
				assertCurrent();
				await readyEditor(session);
				assertCurrent();
				await navigateEntry(session, tree, leaf, assertCurrent, confirmLeaf);
			});
		} else checkpoint.dispose();
		return result;
	} catch (error) { checkpoint.dispose(); throw error; }
}

async function navigateEntry(session: SessionController, tree: SessionTree, entry: TreeEntry, assertCurrent = () => {}, confirmLeaf: (leaf: string | null) => void = () => {}): Promise<NavigateResult> {
	assertCurrent();
	if (session.getSnapshot().host?.transport === "tsp") return navigateSemantic(session, entry, assertCurrent, confirmLeaf);
	const probe = rowProbe(entry);
	if (!probe) throw new NavigationError(i18n.t("session:navigate.unsupported"));
	const mode: SelectorMode = entry.userTurn ? "user" : "all";
	const rows = selectorRows(tree, mode);

	const host = session.getSnapshot().host;
	if (!host) throw new OmpBusyError();
	const { hostId, generation } = host;
	const releaseDrive = screenActivity.hold({ hostId, generation, epoch: null }, "drive");
	const off = session.subscribe(() => {
		const current = session.getSnapshot().host;
		if (!current || current.hostId !== hostId || current.generation !== generation || current.phase === "exited") releaseDrive();
	});
	try {
		await session.command("/tree", assertCurrent);
		if (!(await waitForScreen(session, lines => lines.some(line => line.includes(TREE_TITLE)), 4000))) {
			throw new OmpBusyError();
		}
		assertCurrent();
		await press(session, mode === "user" ? "M-u" : "M-a");
		const found = await focusRow(
			session,
			Math.max(0, rows.findIndex(row => row.id === entry.id)),
			rows.length,
			probe,
			assertCurrent,
		);
		if (!found) {
			assertCurrent();
			await press(session, "escape");
			throw new NavigationError(i18n.t("session:navigate.notFound"));
		}
		assertCurrent();
		await press(session, "enter");
		const outcome = (lines: readonly string[]) =>
			lines.some(line => /Navigated to selected point|Already at this point|Summarize branch\?/.test(line));
		let lines = await waitForScreen(session, outcome, 8000);
		if (lines?.some(line => line.includes("Summarize branch?"))) {
			// First option is "No summary": the conversation moves without an extra model call.
			assertCurrent();
			await press(session, "enter");
			lines = await waitForScreen(session, candidate => /Navigated to selected point|Already at this point/.test(candidate.join("\n")), 8000);
		}
		if (!lines) throw new NavigationError(i18n.t("session:navigate.unconfirmed"));
		assertCurrent();
		// omp moved the leaf in-process without a collab frame; show the new branch until the next entry.
		// (Rewinding the very first message leaves no leaf to show; the transcript corrects on the next entry.)
		const leaf = entry.userTurn ? entry.parentId : entry.id;
		confirmLeaf(leaf);
		if (leaf) session.setDisplayLeaf(leaf);

		let draft: string | null = null;
		if (entry.userTurn && entry.text) {
			// omp put the message back into its own editor; the app's composer owns drafts, so clear omp's
			// (one Ctrl+C clears the editor; never press it twice, two within 500 ms quit omp).
			await waitForScreen(session, screen => parseStatusLine(screen) !== null, 3000);
			assertCurrent();
			await press(session, "C-c");
			draft = entry.text;
			useComposerDrafts.getState().setDraft(session.tabId, draft);
			useComposerDrafts.getState().focus(session.tabId);
		}
		return { draft };
	} finally { off(); releaseDrive(); }
}

/** Copy this chat, optionally cut at a message, without moving or typing into its live host. */
export async function forkChat(session: SessionController, entryId?: string): Promise<void> {
	if (session.getSnapshot().working) throw new NavigationError(i18n.t("session:navigate.busy"));
	if (!session.sessionFile) throw new NavigationError(i18n.t("session:navigate.noFile"));
	const original = await window.vomp.invoke("sessions:resolve", session.sessionFile);
	const forked = await window.vomp.invoke("sessions:fork", original, session.projectPath, entryId);
	const summary = await window.vomp.invoke("sessions:summary", forked.file);
	if (!summary) throw new NavigationError(i18n.t("session:navigate.noFile"));
	useApp.getState().openSession(summary);
}
