/**
 * Background alerts (DESIGN §4.22): when a chat finishes or needs an answer while the window is in
 * the background, ask main for a native notification titled with the chat and a one-line outcome,
 * and keep the count of such chats on the Dock icon (macOS) or the taskbar button (Windows) until
 * the window gains focus.
 */
import { type AttentionState, NOTIFY_LIMITS } from "@shared/ipc";
import { i18n } from "../../i18n";
import { allControllers, useApp } from "../../state/app";
import type { SessionController, SessionEvent } from "../../state/session";
import { drawOverlayBadge, overlayLabel, shorten, UnseenChats } from "./attention";
import { chatTitle } from "./chat";
import { outcomeSummary } from "./outcome";

const unseen = new UnseenChats();

/** Send the unseen count to main. `alert` asks for the one-time Dock bounce or taskbar flash. */
function publish(alert: boolean): void {
	const count = unseen.count;
	let overlay: AttentionState["overlay"] = null;
	if (count > 0 && window.vomp.platform === "win32") {
		const css = getComputedStyle(document.documentElement);
		overlay = {
			image: drawOverlayBadge(overlayLabel(count), {
				fill: css.getPropertyValue("--accent"),
				ink: css.getPropertyValue("--accent-fg"),
				font: css.getPropertyValue("--font-ui"),
			}),
			description: i18n.t("onboarding:notify.overlay", { count }),
		};
	}
	void window.vomp.invoke("app:attention", { count, alert, overlay });
}

function onChatEvent(controller: SessionController, event: SessionEvent): void {
	if (event.kind !== "finished" && event.kind !== "needsInput") return;
	const enabled = useApp.getState().prefs?.notifications ?? false;
	const result = unseen.record(controller.tabId, { focused: document.hasFocus(), enabled });
	if (result === "ignored") return;
	const t = i18n.getFixedT(null, "onboarding");
	const title = chatTitle(controller) ?? t("notify.untitled");
	let body: string;
	if (event.kind === "needsInput") body = t("notify.needsInput");
	else {
		const summary = outcomeSummary(controller.getSnapshot().guest?.entries ?? []);
		body = summary ? t("notify.finishedWith", { summary }) : t("notify.finished");
	}
	void window.vomp.invoke("app:notify", shorten(title, NOTIFY_LIMITS.title), shorten(body, NOTIFY_LIMITS.body), controller.tabId);
	if (result === "new") publish(true);
}

/** Attaches to every chat controller as it appears (controllers are created with their tabs). */
export function installNotifications(): void {
	const watched = new WeakSet<SessionController>();
	const attach = () => {
		for (const controller of allControllers()) {
			if (watched.has(controller)) continue;
			watched.add(controller);
			controller.onEvent(event => onChatEvent(controller, event));
		}
	};
	attach();
	useApp.subscribe(state => {
		attach();
		if (!state.prefs?.notifications && unseen.clear()) publish(false);
	});
	window.addEventListener("focus", () => {
		if (unseen.clear()) publish(false);
	});
	window.vomp.on("app:openChat", ({ chatId }) => useApp.getState().activateTab(chatId));
	// A reload starts with nothing unseen, so remove whatever the previous page left on the Dock or taskbar.
	publish(false);
}
