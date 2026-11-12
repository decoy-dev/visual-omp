/**
 * Quit / close-tab warning (DESIGN §4.22, copy §8.4). Main asks via `app:quitRequested` before
 * quitting; the shell asks through `confirmCloseTab` (installed as the tab-close guard) before
 * closing a chat. Either way, work in flight (omp's reply or helpers at work, `workInFlight`) gets
 * one dialog: Keep waiting / Stop and quit. The dialog states the work recorded when it was asked
 * for and waits for an answer; its rows show what each chat is doing now. A quit also asks about
 * chats whose state could not be checked in time, since unknown work may be running. A bulk close (every chat, the
 * chats selected in Current chats, or only the idle ones) always asks, through `confirmBulkCloseTabs`.
 */
import { lazyView, LoadFailedDialog, type LoadFailureProps } from "../../registry/lazy";
import { create } from "zustand";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { i18n } from "../../i18n";
import type { BulkCloseApproval, BulkCloseScope } from "../../registry/guards";
import { allControllers, controllerFor, MAIN_ID, useApp, whenHostsAdopted } from "../../state/app";
import { CLOSED_LIMIT } from "../../state/closedChats";
import { type ChatWork, workInFlight } from "../../state/chatWork";
import type { SessionController, SessionView } from "../../state/session";
import { toast } from "../../ui/toast";
import { chatTitle } from "./chat";

const DONT_ASK_KEY = "visual-omp:quit.alwaysStop";

/**
 * Longest wait for the open chats' state before a quit is decided. On macOS a quit after the window was closed reopens
 * it to ask (main's `before-quit`), and that request arrives before init() has adopted the running omp processes and
 * before their rooms have synced. A chat still unknown after the wait is asked about as unchecked, so a quit never
 * hangs and never treats unknown work as idle.
 */
const SYNC_WAIT_MS = 5_000;

/** Set once init() has adopted the running omp processes: a chat without one has none from then on. */
let adopted = false;
void whenHostsAdopted().then(() => {
	adopted = true;
});

/**
 * Whether the app knows what omp is doing in a chat: its omp exited, its room has synced, or it has no omp and the
 * running ones have been adopted (before that, a restored chat may still get one).
 */
export function stateKnown(view: SessionView): boolean {
	if (view.mode === "exited") return true;
	if (view.host === null) return adopted;
	const phase = view.guest?.phase;
	return phase === "live" || phase === "ended";
}

/** A chat with work in flight, and that work as it was when the dialog was asked for. */
interface BusyChat {
	controller: SessionController;
	work: ChatWork;
}

/** What a request asks about: work in flight, unknown states, and drafts a bulk close would discard. */
interface Findings {
	chats: readonly BusyChat[];
	unchecked: readonly SessionController[];
	drafts?: readonly LostDraft[];
	/**
	 * When a bulk close also offers to close only the idle chats (some chats are idle and others are working or
	 * unchecked): the drafts that choice would discard. It is figured separately because closing fewer saved chats
	 * changes which ones keep their text on the reopen stack.
	 */
	idleDrafts?: readonly LostDraft[] | null;
	/** The number of chats a bulk close names in its title or body. */
	count?: number;
}

export interface LostDraft {
	tabId: string;
	title: string | null;
	text: boolean;
	attachments: number;
}

/** Stop and quit or close (true), keep waiting or cancel (false), or close only the idle chats. */
export type QuitAnswer = boolean | "idle";

interface QuitRequest extends Findings {
	kind: "quit" | "tab" | "bulk";
	/** The chat a close asks about; null when quitting or closing several. */
	tabId: string | null;
	/** The chats a bulk close covers; null otherwise. */
	scope: BulkCloseScope | null;
	opener: HTMLElement | null;
	allowed: boolean;
	promise: Promise<QuitAnswer>;
	resolve(answer: QuitAnswer): void;
}

/** The open dialog's request (exported for tests). */
export const useQuitRequest = create<{ request: QuitRequest | null }>(() => ({ request: null }));

/** The chats among `controllers` that closing would interrupt. */
function busyChats(controllers: readonly SessionController[]): BusyChat[] {
	return controllers.flatMap(controller => {
		const work = workInFlight(controller.getSnapshot());
		return work ? [{ controller, work }] : [];
	});
}

/** Capture a menu's trigger before its item disappears, or the invoking control before any state-check wait. */
function quitOpener(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || active === document.body || active === document.documentElement) return null;
	const label = active.closest('[role="menu"]')?.getAttribute("aria-labelledby");
	return (label ? document.getElementById(label) : null) ?? active;
}

/** Dismissal can remove its invoking menu or palette, so keep a surviving main-area target as a fallback. */
export function restoreQuitFocus(request: QuitRequest): void {
	requestAnimationFrame(() => {
		const targets = [
			...(!request.allowed ? [request.opener] : []),
			document.getElementById(MAIN_ID),
			document.querySelector<HTMLElement>("[data-new-chat]"),
		];
		for (const target of targets) {
			if (!target?.isConnected || target === document.body || target === document.documentElement || target.closest("[inert]")) continue;
			target.focus();
			if (document.activeElement === target) return;
		}
	});
}

/**
 * Ask before quitting (`tabId` null), closing one chat or closing several. The same quit or single close made again
 * while its dialog is open (⌘Q twice, a second close of the same chat) shares the answer. A different one, and every
 * bulk close, waits until that dialog is answered and then asks about its own chats, so stopping one chat never
 * approves quitting the others and one bulk close never approves another.
 */
async function ask(kind: QuitRequest["kind"], tabId: string | null, find: () => Findings, opener = quitOpener(), scope: BulkCloseScope | null = null): Promise<QuitAnswer> {
	for (let pending = useQuitRequest.getState().request; pending; pending = useQuitRequest.getState().request) {
		if (kind !== "bulk" && pending.kind === kind && pending.tabId === tabId) return pending.promise;
		await pending.promise;
		// Let the operation that dialog approved run first (closeChat removes its chat right after the answer), so this
		// request asks about the chats that are left.
		const { promise: nextTask, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await nextTask;
	}
	const { chats, unchecked, drafts = [], idleDrafts = null, count } = find();
	if (kind !== "bulk" && chats.length === 0 && unchecked.length === 0) return true;
	// "Always stop working chats when quitting" covers known work when quitting; closing a chat, and chats that could
	// not be checked, still ask.
	if (kind === "quit" && unchecked.length === 0 && localStorage.getItem(DONT_ASK_KEY) === "1") return true;
	const { promise, resolve } = Promise.withResolvers<QuitAnswer>();
	useQuitRequest.setState({ request: { kind, tabId, scope, chats, unchecked, drafts, idleDrafts, count, opener, allowed: false, promise, resolve } });
	return promise;
}

/**
 * Answer the open dialog: Stop passes true; Keep waiting, Cancel, Escape and dismissing it pass false; Close idle
 * chats passes "idle". `alwaysStop` saves the quit preference, and only when the answer stops quitting chats.
 */
export function answerQuitRequest(answer: QuitAnswer, alwaysStop = false): void {
	const request = useQuitRequest.getState().request;
	if (!request) return;
	if (answer === true && alwaysStop && request.kind === "quit") localStorage.setItem(DONT_ASK_KEY, "1");
	request.allowed = answer !== false;
	useQuitRequest.setState({ request: null });
	request.resolve(answer);
}

/** Resolves true when it's fine to close the chat (nothing works in it, or the user chose to stop it). */
export async function confirmCloseTab(tabId: string): Promise<boolean> {
	const answer = await ask("tab", tabId, () => {
		const controller = controllerFor(tabId);
		return { chats: controller ? busyChats([controller]) : [], unchecked: [] };
	});
	return answer === true;
}

/** The work quitting would stop, and the chats whose state is not known. */
function quitFindings(): Findings {
	const controllers = allControllers();
	const unchecked = controllers.filter(controller => !stateKnown(controller.getSnapshot()));
	return { chats: busyChats(controllers.filter(controller => !unchecked.includes(controller))), unchecked };
}

/**
 * A chat closing only idle chats may close: no reply or helper work is running in it and its state is known (or it
 * has no omp controller at all).
 */
function idleChat(tabId: string): boolean {
	const view = controllerFor(tabId)?.getSnapshot() ?? null;
	return view === null || (stateKnown(view) && !workInFlight(view));
}

/** The draft text and attachments closing `tabIds` in that order would discard. */
function lostDrafts(tabIds: readonly string[]): LostDraft[] {
	const current = new Map(useApp.getState().tabs.map(tab => [tab.id, tab]));
	const tabs = tabIds.flatMap(id => { const tab = current.get(id); return tab ? [tab] : []; });
	const drafts = useComposerDrafts.getState();
	// closeTab pushes in close order, so only the last ten distinct saved files retain their text.
	const retained = new Set([...new Set(tabs.flatMap(tab => tab.sessionFile ? [tab.sessionFile] : []))].slice(-CLOSED_LIMIT));
	return tabs.flatMap(tab => {
		const text = Boolean(drafts.drafts[tab.id]) && (!tab.sessionFile || !retained.has(tab.sessionFile));
		const attachments = drafts.attachments[tab.id]?.length ?? 0;
		const controller = controllerFor(tab.id);
		return text || attachments ? [{ tabId: tab.id, title: (controller ? chatTitle(controller) : null) ?? tab.title, text, attachments }] : [];
	});
}

/**
 * Always confirm a bulk close of `tabIds` (in close order), using quit's bounded state check and the drafts closeTab
 * would discard. When some of those chats are idle and others are working or unchecked, the dialog also offers to
 * close only the idle ones. An idle close covers only the chats the dialog counted as idle, so a chat that becomes
 * idle while it is open never closes with drafts the dialog did not list; each is checked again as it closes, and the
 * close reports what closed and what stayed open.
 */
export async function confirmBulkCloseTabs(tabIds: readonly string[], scope: BulkCloseScope): Promise<BulkCloseApproval | null> {
	const opener = quitOpener();
	await chatsKnown();
	if (scope === "idle" && !tabIds.some(idleChat)) {
		toast({ tone: "info", message: i18n.t("onboarding:quit.noIdle") });
		return null;
	}
	let idle: string[] = [];
	const answer = await ask("bulk", null, () => {
		const targets = new Set(tabIds);
		const findings = quitFindings();
		const chats = findings.chats.filter(chat => targets.has(chat.controller.tabId));
		const unchecked = findings.unchecked.filter(controller => targets.has(controller.tabId));
		idle = tabIds.filter(idleChat);
		const offerIdle = scope !== "idle" && idle.length > 0 && chats.length + unchecked.length > 0;
		return {
			chats,
			unchecked,
			drafts: lostDrafts(scope === "idle" ? idle : tabIds),
			idleDrafts: offerIdle ? lostDrafts(idle) : null,
			count: scope === "idle" ? idle.length : tabIds.length,
		};
	}, opener, scope);
	if (answer === false) return null;
	if (answer === true && scope !== "idle") return { tabIds, stillIdle: null };
	return {
		tabIds: idle.filter(idleChat),
		stillIdle: idleChat,
		done(closed, leftOpen) {
			const message = closed > 0 ? i18n.t("onboarding:quit.closedIdle", { count: closed }) : i18n.t("onboarding:quit.noIdle");
			const kept = leftOpen > 0 ? ` ${i18n.t(scope === "selected" ? "onboarding:quit.leftOpenSelected" : "onboarding:quit.leftOpen", { count: leftOpen })}` : "";
			toast({ tone: "info", message: `${message}${kept}` });
		},
	};
}

/**
 * Resolves once init() has adopted the running omp processes and every open chat's state is known, or after
 * `SYNC_WAIT_MS`, whichever comes first. Once the wait is over, nothing more subscribes.
 */
async function chatsKnown(): Promise<void> {
	let over = false;
	const stops: (() => void)[] = [];
	const known = whenHostsAdopted().then(() => {
		if (over) return undefined;
		return Promise.all(
			allControllers().map(controller => {
				if (stateKnown(controller.getSnapshot())) return undefined;
				const { promise, resolve } = Promise.withResolvers<void>();
				stops.push(
					controller.subscribe(() => {
						if (stateKnown(controller.getSnapshot())) resolve();
					}),
				);
				return promise;
			}),
		);
	});
	const { promise: timeout, resolve: expire } = Promise.withResolvers<void>();
	const timer = setTimeout(expire, SYNC_WAIT_MS);
	await Promise.race([known, timeout]);
	over = true;
	clearTimeout(timer);
	for (const stop of stops) stop();
}

/** Ask before quitting, once the open chats' state is known or the wait for it is over. */
async function confirmQuit(): Promise<boolean> {
	const opener = quitOpener();
	await chatsKnown();
	return (await ask("quit", null, quitFindings, opener)) === true;
}

/** Set by {@link quitAfterConfirm}: the next quit request from main is answered without asking again. */
let preapproved = false;

/**
 * For app-initiated quits (restarting into an update): asks the quit question first, then runs
 * `quit`, whose quit request from main is approved without a second dialog. Resolves false when
 * the user keeps the app open.
 */
export async function quitAfterConfirm(quit: () => Promise<void>): Promise<boolean> {
	if (!(await confirmQuit())) return false;
	preapproved = true;
	try {
		await quit();
	} catch (error) {
		preapproved = false;
		throw error;
	}
	return true;
}

/** Answers main's quit request: immediately when nothing is working, otherwise after the dialog. */
export function installQuitGuard(): void {
	window.vomp.on("app:quitRequested", () => {
		if (preapproved) {
			preapproved = false;
			void window.vomp.invoke("app:confirmQuit", true);
			return;
		}
		void confirmQuit().then(allow => window.vomp.invoke("app:confirmQuit", allow));
	});
}

function QuitLoadFailed({ request, retry }: { request: QuitRequest } & LoadFailureProps) {
	return <LoadFailedDialog retry={retry} onClose={() => answerQuitRequest(false)} onExited={() => restoreQuitFocus(request)} />;
}

const QuitWarning = lazyView<{ request: QuitRequest }>(() => import("./QuitDialog").then(module => module.QuitDialog), null, QuitLoadFailed);

/** Keep the warning's UI out of startup; its first request loads the dialog. */
export function QuitDialog() {
	const request = useQuitRequest(state => state.request);
	return request ? <QuitWarning request={request} /> : null;
}
