/**
 * Slash commands the app passes through to omp (treatment R in docs/COMMANDS.md): typed into omp's
 * editor, then omp's painted screen is watched until what it printed settles into a result row in the
 * chat (`results.ts`). A command that starts a turn or a session change ends the watch without a row.
 * When omp replaces its editor with a screen of its own, the terminal sheet opens unless a native card
 * draws that screen (`registerNativeOverlay`) or a collab question is pending; the chat's queue is held
 * until the editor is back, then the sheet the app opened closes and queued messages continue.
 *
 * One watch per chat: typing the next command ends the previous watch first (keeping what it printed
 * unless its spinner still shows), so two commands typed close together never share output.
 */
import { displayedEntries } from "../../chat/branch";
import { liveGuest, type SessionController, setSlashDelivery } from "../../state/session";
import { useApp } from "../../state/app";
import { isNativeOverlay } from "../palette/overlays";
import { autoOpened } from "../palette/TerminalSheet";
import { OmpBusyError, readScreen, readyEditor, reportFailure, sleep } from "./drive";
import { addCommandResult, drawsRow, linesTone, presentLines, roomKey, startWatch, supersededResult, WATCH, watchStep } from "./results";
import { parseStatusLine } from "./screen";
import { routeSlash } from "./slash";

const POLL_MS = 120;
/** Slower polling while omp's own screen is up: it may stay open for a long time. */
const SCREEN_POLL_MS = 300;

/** The chat's running watch, ended by the next command typed into the same omp. */
const watches = new WeakMap<SessionController, { supersede: () => void }>();
/** The chat's latest typing, so concurrent sends type one at a time. */
const typing = new WeakMap<SessionController, Promise<unknown>>();

/** Open the terminal sheet on omp's screen, the way OverlayWatcher does. */
function openSheet(session: SessionController): void {
	const app = useApp.getState();
	const visible = app.view === "chat" && (app.activeTabId === session.tabId || app.splitTabId === session.tabId);
	if (!visible || app.terminalTabId) return;
	autoOpened.tabId = session.tabId;
	app.openTerminal(session.tabId);
}

/** omp's screen went away: close the sheet if the app opened it for that screen (not one the user opened). */
function closeAutoSheet(session: SessionController): void {
	if (autoOpened.tabId !== session.tabId) return;
	autoOpened.tabId = null;
	if (useApp.getState().terminalTabId === session.tabId) useApp.getState().closeTerminal();
}

/**
 * Resolves once omp's editor is back for good: painted with no overlay and no collab question for a
 * few polls in a row. Also resolves when omp stops or the chat moves to another omp.
 */
async function editorBack(session: SessionController): Promise<void> {
	const hostId = session.hostId;
	let streak = 0;
	while (streak < WATCH.replacedPolls) {
		await sleep(SCREEN_POLL_MS);
		if (session.hostId !== hostId || session.getSnapshot().mode === "exited") return;
		const lines = await readScreen(session);
		const view = session.getSnapshot();
		const free = parseStatusLine(lines) !== null && (view.host?.tui?.overlays ?? 0) === 0 && !view.guest?.uiRequest;
		streak = free ? streak + 1 : 0;
	}
}

/**
 * Watch omp after `line` was typed over the `before` screen; never rejects. While omp's own screen
 * replaces its editor, the chat's queue is held, and the sheet the app opened for it closes again when
 * the editor is back.
 */
async function watch(session: SessionController, line: string, before: string[], anchor: string | null): Promise<void> {
	const startView = session.getSnapshot();
	const room = roomKey(startView);
	const guest = session.guestClient();
	const hostId = session.hostId;
	const seen = liveGuest(startView)?.entries.length ?? 0;
	const stream = startView.guest?.stream ?? null;
	const tools = startView.guest?.activeTools ?? null;
	const record = (lines: string[]) => {
		const shown = presentLines(lines);
		if (shown.length > 0) addCommandResult(session, { command: line, lines: shown, tone: linesTone(shown), anchor, room });
	};
	let state = startWatch(Date.now(), startView.working);
	let superseded = false;
	const entry = {
		supersede: () => {
			if (superseded) return;
			superseded = true;
			const lines = supersededResult(state);
			if (lines) record(lines);
		},
	};
	watches.set(session, entry);
	let releaseQueue: (() => void) | null = null;
	/** omp's own screen was up and its editor is back: close the sheet the app opened for that screen. */
	let screenClosed = false;
	try {
		for (;;) {
			await sleep(state.replaced ? SCREEN_POLL_MS : POLL_MS);
			const lines = superseded ? [] : await readScreen(session);
			// The next command was typed, so omp's editor is back.
			if (superseded) {
				screenClosed = state.replaced;
				break;
			}
			const view = session.getSnapshot();
			const roomChanged = session.guestClient() !== guest || session.hostId !== hostId || view.mode !== "live";
			const [next, decision] = watchStep(state, before, line, {
				now: Date.now(),
				lines,
				editor: parseStatusLine(lines) !== null && (view.host?.tui?.overlays ?? 0) === 0,
				working: view.working,
				turnProgressed: (view.guest?.stream ?? null) !== stream || (view.guest?.activeTools ?? null) !== tools,
				roomChanged,
				transcriptGrew: (liveGuest(view)?.entries.slice(seen) ?? []).some(drawsRow),
			});
			const wasReplaced = state.replaced;
			state = next;
			if (decision.kind === "wait") continue;
			if (decision.kind === "replaced") {
				const { promise, resolve } = Promise.withResolvers<void>();
				releaseQueue = resolve;
				session.holdQueue(promise);
				if (!view.guest?.uiRequest && !isNativeOverlay(lines)) openSheet(session);
				continue;
			}
			if (decision.kind === "result") record(decision.lines);
			else screenClosed = wasReplaced && !roomChanged;
			break;
		}
	} catch {
		// omp stopped or its screen became unreadable mid-watch: nothing more to show.
	} finally {
		if (watches.get(session) === entry) watches.delete(session);
		if (screenClosed) closeAutoSheet(session);
		releaseQueue?.();
	}
}

/**
 * Type `line` once omp's editor is free and start watching, after any earlier send to this chat has
 * typed. Rejects (OmpBusyError, omp not running) before anything is typed; resolves once the line is
 * in, with the running watch (boxed, because an async function returning a promise would wait for it).
 */
function typeAndWatch(session: SessionController, line: string): Promise<{ watching: Promise<void> }> {
	const typed = (typing.get(session) ?? Promise.resolve())
		.catch(() => undefined)
		.then(async () => {
			await readyEditor(session);
			// The previous command's output belongs to it: end its watch before reading the screen this one is compared to.
			watches.get(session)?.supersede();
			const before = await readScreen(session);
			const anchor = displayedEntries(session.getSnapshot()).at(-1)?.id ?? null;
			await session.command(line);
			return { watching: watch(session, line, before, anchor) };
		});
	typing.set(session, typed);
	return typed;
}

/**
 * Deliver a pass-through slash command. While omp is busy (`SessionController.busy`), the line joins
 * the end of the chat's queue and is routed and typed when it drains; with `now` (Send now) it is typed
 * at once, steering the running turn, and still watched for a result. Otherwise it is typed now, and the
 * chat's queue is held from this call until the command's watch ends (it printed its result, started a
 * turn or changed the session), so a message sent meanwhile queues behind it. The promise settles once
 * the line is in omp's editor; the printed result arrives in the chat later. Rejects when the line could
 * not be typed (omp shows a menu of its own, or did not start), so the caller can keep the draft.
 */
export async function sendSlashCommand(session: SessionController, line: string, options: { now?: boolean } = {}): Promise<void> {
	const trimmed = line.trim();
	if (!trimmed) return;
	if (!(options.now && session.getSnapshot().working) && session.busy) {
		await session.send(trimmed);
		return;
	}
	const typed = typeAndWatch(session, trimmed);
	session.holdQueue(typed.then(({ watching }) => watching));
	await typed;
}

// Queued slash lines (drained or sent now from the queue tray) take the same path as the composer's.
setSlashDelivery(async (session, line, { report }) => {
	let typed: { watching: Promise<void> } | null;
	try {
		typed = (await routeSlash(session, line)) ? null : await typeAndWatch(session, line.trim());
	} catch (error) {
		// omp shows a screen of its own: the line stays queued and goes once the screen closes.
		if (error instanceof OmpBusyError) session.holdQueue(editorBack(session));
		// Send now from the tray shows its own notification for the failure.
		else if (report) reportFailure(error);
		throw error;
	}
	await typed?.watching;
});
