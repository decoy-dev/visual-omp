/**
 * Quit / close-tab warning (DESIGN §4.22, copy §8.4). Main asks via `app:quitRequested` before
 * quitting; the shell asks through `confirmCloseTab` (installed as the tab-close guard) before
 * closing a chat. Either way, work in flight gets one dialog: Keep waiting / Stop and quit.
 */
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { allControllers, controllerFor } from "../../state/app";
import type { SessionController } from "../../state/session";
import { Button, Checkbox, Dialog, DialogContent, PulseDot } from "../../ui";
import { chatTitle } from "./chat";

const DONT_ASK_KEY = "visual-omp:quit.alwaysStop";

interface QuitRequest {
	kind: "quit" | "tab";
	chats: readonly SessionController[];
	promise: Promise<boolean>;
	resolve(allow: boolean): void;
}

const useQuitRequest = create<{ request: QuitRequest | null }>(() => ({ request: null }));

function ask(kind: QuitRequest["kind"], chats: readonly SessionController[]): Promise<boolean> {
	if (chats.length === 0 || localStorage.getItem(DONT_ASK_KEY) === "1") return Promise.resolve(true);
	// A second quit request while the dialog is up (e.g. ⌘Q twice) shares the first answer.
	const pending = useQuitRequest.getState().request;
	if (pending) return pending.promise;
	const { promise, resolve } = Promise.withResolvers<boolean>();
	useQuitRequest.setState({ request: { kind, chats, promise, resolve } });
	return promise;
}

/** Resolves true when it's fine to close the chat (it isn't working, or the user chose to stop it). */
export function confirmCloseTab(tabId: string): Promise<boolean> {
	const controller = controllerFor(tabId);
	return ask("tab", controller?.getSnapshot().working ? [controller] : []);
}

/** Set by {@link quitAfterConfirm}: the next quit request from main is answered without asking again. */
let preapproved = false;

/**
 * For app-initiated quits (restarting into an update): asks the quit question first, then runs
 * `quit`, whose quit request from main is approved without a second dialog. Resolves false when
 * the user keeps the app open.
 */
export async function quitAfterConfirm(quit: () => Promise<void>): Promise<boolean> {
	if (!(await ask("quit", allControllers().filter(controller => controller.getSnapshot().working)))) return false;
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
		const working = allControllers().filter(controller => controller.getSnapshot().working);
		void ask("quit", working).then(allow => window.vomp.invoke("app:confirmQuit", allow));
	});
}

function WorkingChat({ controller }: { controller: SessionController }) {
	const { t } = useTranslation("onboarding");
	const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	return (
		<li className="flex h-9 items-center gap-2.5 px-3">
			{view.working ? <PulseDot label={t("quit.working")} /> : <span className="size-2 rounded-full bg-ok" aria-hidden />}
			<span className="min-w-0 flex-1 truncate text-md text-fg">{chatTitle(controller) ?? t("notify.untitled")}</span>
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

	const answer = (allow: boolean) => {
		// "Always stop" only sticks when the user actually chose to stop.
		if (allow && alwaysStop) localStorage.setItem(DONT_ASK_KEY, "1");
		setAlwaysStop(false);
		useQuitRequest.setState({ request: null });
		request.resolve(allow);
	};

	return (
		<Dialog open onOpenChange={open => !open && answer(false)}>
			<DialogContent
				size="sm"
				destructive
				hideClose
				title={tab ? t("quit.tabTitle") : t("quit.title", { count: request.chats.length })}
				description={tab ? t("quit.tabBody") : t("quit.body")}
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
					<ul className="mb-4 divide-y divide-border rounded-md border border-border bg-inset">
						{request.chats.map(controller => (
							<WorkingChat key={controller.tabId} controller={controller} />
						))}
					</ul>
				)}
				<Checkbox
					label={t("quit.dontAsk")}
					checked={alwaysStop}
					onCheckedChange={setAlwaysStop}
				/>
			</DialogContent>
		</Dialog>
	);
}
