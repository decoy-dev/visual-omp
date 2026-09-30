/**
 * Native notifications (DESIGN §4.22): when a chat finishes or needs an answer while the window
 * is in the background, show an OS notification titled with the chat and a one-line outcome.
 */
import { i18n } from "../../i18n";
import { allControllers, useApp } from "../../state/app";
import type { SessionController, SessionEvent } from "../../state/session";
import { chatTitle } from "./chat";
import { outcomeSummary } from "./outcome";

function notify(controller: SessionController, event: SessionEvent): void {
	if (event.kind === "exited" || document.hasFocus() || !useApp.getState().prefs?.notifications) return;
	const t = i18n.getFixedT(null, "onboarding");
	const title = chatTitle(controller) ?? t("notify.untitled");
	let body: string;
	if (event.kind === "needsInput") body = t("notify.needsInput");
	else {
		const summary = outcomeSummary(controller.getSnapshot().guest?.entries ?? []);
		body = summary ? t("notify.finishedWith", { summary }) : t("notify.finished");
	}
	void window.vomp.invoke("app:notify", title, body);
}

/** Attaches to every chat controller as it appears (controllers are created with their tabs). */
export function installNotifications(): void {
	const watched = new WeakSet<SessionController>();
	const attach = () => {
		for (const controller of allControllers()) {
			if (watched.has(controller)) continue;
			watched.add(controller);
			controller.onEvent(event => notify(controller, event));
		}
	};
	attach();
	useApp.subscribe(attach);
}
