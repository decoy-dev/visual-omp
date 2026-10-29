/**
 * Rewind and resume-from-here use omp's `/tree` selector; fork uses a separate RPC process.
 *
 * omp has no text command that moves the session leaf, so the app opens `/tree`, switches the filter
 * (Alt+U user turns / Alt+A everything), moves the cursor with Home + Down×n using the row order it
 * computes from the session file (`selectorRows`), checks the highlighted row really is the target,
 * and presses Enter. Picking a user message rewinds past it (omp puts its text back in the editor;
 * the app moves it into its own composer instead), picking anything else continues from there.
 * `/branch` (rewind selector) ends in the same `navigateTree` call, so one path serves both.
 */
import { i18n } from "../../i18n";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { OmpBusyError, press, readScreen, readyEditor, waitForScreen } from "./drive";
import { parseStatusLine } from "./screen";
import { parseSessionTree, rowProbe, type SelectorMode, selectorRows, type SessionTree } from "./tree";

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
async function focusRow(session: SessionController, index: number, total: number, probe: string): Promise<boolean> {
	await press(session, index > 0 ? `home ${Array.from({ length: index }, () => "down").join(" ")}` : "home");
	if (await waitForScreen(session, lines => rowMatches(lines, probe), 800)) return true;
	await press(session, "home");
	for (let step = 0; step <= total + 4; step++) {
		if (rowMatches(await readScreen(session), probe)) return true;
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
	const probe = rowProbe(entry);
	if (!probe) throw new NavigationError(i18n.t("session:navigate.unsupported"));
	const mode: SelectorMode = entry.userTurn ? "user" : "all";
	const rows = selectorRows(tree, mode);

	await session.command("/tree");
	if (!(await waitForScreen(session, lines => lines.some(line => line.includes(TREE_TITLE)), 4000))) {
		throw new OmpBusyError();
	}
	await press(session, mode === "user" ? "M-u" : "M-a");
	const found = await focusRow(
		session,
		Math.max(0, rows.findIndex(row => row.id === entryId)),
		rows.length,
		probe,
	);
	if (!found) {
		await press(session, "escape");
		throw new NavigationError(i18n.t("session:navigate.notFound"));
	}
	await press(session, "enter");
	const outcome = (lines: readonly string[]) =>
		lines.some(line => /Navigated to selected point|Already at this point|Summarize branch\?/.test(line));
	let lines = await waitForScreen(session, outcome, 8000);
	if (lines?.some(line => line.includes("Summarize branch?"))) {
		// First option is "No summary": the conversation moves without an extra model call.
		await press(session, "enter");
		lines = await waitForScreen(session, candidate => /Navigated to selected point|Already at this point/.test(candidate.join("\n")), 8000);
	}
	if (!lines) throw new NavigationError(i18n.t("session:navigate.unconfirmed"));
	// omp moved the leaf in-process without a collab frame; show the new branch until the next entry.
	// (Rewinding the very first message leaves no leaf to show; the transcript corrects on the next entry.)
	const leaf = entry.userTurn ? entry.parentId : entry.id;
	if (leaf) session.setDisplayLeaf(leaf);

	let draft: string | null = null;
	if (entry.userTurn && entry.text) {
		// omp put the message back into its own editor; the app's composer owns drafts, so clear omp's
		// (one Ctrl+C clears the editor; never press it twice — two within 500 ms quit omp).
		await waitForScreen(session, screen => parseStatusLine(screen) !== null, 3000);
		await press(session, "C-c");
		draft = entry.text;
		useComposerDrafts.getState().setDraft(session.tabId, draft);
		useComposerDrafts.getState().focus(session.tabId);
	}
	return { draft };
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
