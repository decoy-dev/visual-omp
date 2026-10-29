/**
 * Quit / close-tab warning (DESIGN §4.22, copy §8.4). Main asks via `app:quitRequested` before
 * quitting; the shell asks through `confirmCloseTab` (installed as the tab-close guard) before
 * closing a chat. Either way, work in flight (omp's reply or helpers at work, `workInFlight`) gets
 * one dialog: Keep waiting / Stop and quit. The dialog states the work recorded when it was asked
 * for and waits for an answer; its rows show what each chat is doing now. A quit also asks about
 * chats whose state could not be checked in time, since unknown work may be running.
 */
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { allControllers, controllerFor, whenHostsAdopted } from "../../state/app";
import { type ChatWork, workInFlight } from "../../state/chatWork";
import type { SessionController, SessionView } from "../../state/session";
import { Button, Checkbox, Dialog, DialogContent, PulseDot } from "../../ui";
import { SessionTitle } from "../../ui/SessionTitle";
import { chatTitle } from "./chat";
import { closeCopy, quitCopy, rowCopy } from "./quitCopy";

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
function stateKnown(view: SessionView): boolean {
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

/** What a request asks about: chats with work in flight, and (quitting only) chats whose state is not known. */
interface Findings {
	chats: readonly BusyChat[];
	unchecked: readonly SessionController[];
}

interface QuitRequest extends Findings {
	kind: "quit" | "tab";
	/** The chat a close asks about; null when quitting. */
	tabId: string | null;
	promise: Promise<boolean>;
	resolve(allow: boolean): void;
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

/**
 * Ask before quitting (`tabId` null) or closing one chat. The same request made again while its dialog is open (⌘Q
 * twice, a second close of the same chat) shares the answer. A different one waits until that dialog is answered and
 * then asks about its own chats, so stopping one chat never approves quitting the others.
 */
async function ask(kind: QuitRequest["kind"], tabId: string | null, find: () => Findings): Promise<boolean> {
	for (let pending = useQuitRequest.getState().request; pending; pending = useQuitRequest.getState().request) {
		if (pending.kind === kind && pending.tabId === tabId) return pending.promise;
		await pending.promise;
		// Let the operation that dialog approved run first (closeChat removes its chat right after the answer), so this
		// request asks about the chats that are left.
		const { promise: nextTask, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await nextTask;
	}
	const { chats, unchecked } = find();
	if (chats.length === 0 && unchecked.length === 0) return true;
	// "Always stop working chats when quitting" covers known work when quitting; closing a chat, and chats that could
	// not be checked, still ask.
	if (kind === "quit" && unchecked.length === 0 && localStorage.getItem(DONT_ASK_KEY) === "1") return true;
	const { promise, resolve } = Promise.withResolvers<boolean>();
	useQuitRequest.setState({ request: { kind, tabId, chats, unchecked, promise, resolve } });
	return promise;
}

/**
 * Answer the open dialog: Stop passes true; Keep waiting, Escape and dismissing it pass false. `alwaysStop` saves the
 * quit preference, and only when the answer stops quitting chats.
 */
export function answerQuitRequest(allow: boolean, alwaysStop = false): void {
	const request = useQuitRequest.getState().request;
	if (!request) return;
	if (allow && alwaysStop && request.kind === "quit") localStorage.setItem(DONT_ASK_KEY, "1");
	useQuitRequest.setState({ request: null });
	request.resolve(allow);
}

/** Resolves true when it's fine to close the chat (nothing works in it, or the user chose to stop it). */
export function confirmCloseTab(tabId: string): Promise<boolean> {
	return ask("tab", tabId, () => {
		const controller = controllerFor(tabId);
		return { chats: controller ? busyChats([controller]) : [], unchecked: [] };
	});
}

/** The work quitting would stop, and the chats whose state is not known. */
function quitFindings(): Findings {
	const controllers = allControllers();
	const unchecked = controllers.filter(controller => !stateKnown(controller.getSnapshot()));
	return { chats: busyChats(controllers.filter(controller => !unchecked.includes(controller))), unchecked };
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
	await chatsKnown();
	return ask("quit", null, quitFindings);
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

/** One chat in the quit list, live: what it is doing now, "No work running", or "Not checked" while unknown. */
function WorkingChat({ controller }: { controller: SessionController }) {
	const { t } = useTranslation("onboarding");
	const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	const known = stateKnown(view);
	const work = known ? workInFlight(view) : null;
	const doing = known ? rowCopy(work) : { key: "quit.notChecked" };
	return (
		<li className="flex h-9 items-center gap-2.5 px-3">
			{work ? <PulseDot /> : <span className={known ? "size-2 rounded-full bg-ok" : "size-2 rounded-full bg-warn"} aria-hidden />}
			<SessionTitle title={chatTitle(controller) ?? t("notify.untitled")} className="flex-1 text-md text-fg" />
			<span className="shrink-0 text-sm text-fg-muted">{t(doing.key, { count: doing.count })}</span>
		</li>
	);
}

/** Mounted once at the app root. */
export function QuitDialog() {
	const { t } = useTranslation("onboarding");
	const request = useQuitRequest(state => state.request);
	const [alwaysStop, setAlwaysStop] = useState(false);
	if (!request) return null;
	const tab = request.kind === "tab";
	const first = request.chats[0];
	const copy =
		tab && first
			? closeCopy(first.work)
			: quitCopy(
					request.chats.map(chat => chat.work),
					request.unchecked.length,
				);

	const answer = (allow: boolean) => {
		setAlwaysStop(false);
		answerQuitRequest(allow, alwaysStop);
	};

	return (
		<Dialog open onOpenChange={open => !open && answer(false)}>
			<DialogContent
				size="sm"
				destructive
				hideClose
				title={t(copy.title.key, { count: copy.title.count })}
				description={copy.body.map(part => t(part.key, { count: part.count })).join(" ")}
				footer={
					<>
						<Button variant="ghost" onClick={() => answer(false)} autoFocus>
							{t("quit.keepWaiting")}
						</Button>
						<Button variant="danger" onClick={() => answer(true)}>
							{tab ? t("quit.stopAndClose") : t("quit.stopAndQuit")}
						</Button>
					</>
				}
			>
				{!tab && (
					<>
						<ul className="mb-4 divide-y divide-border rounded-md border border-border bg-inset">
							{[...request.chats.map(chat => chat.controller), ...request.unchecked].map(controller => (
								<WorkingChat key={controller.tabId} controller={controller} />
							))}
						</ul>
						<Checkbox
							label={t("quit.dontAsk")}
							checked={alwaysStop}
							onCheckedChange={setAlwaysStop}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
