/** Unopened results stay badged until their chat is shown with focus; background alerts remain optional. */
import { type AttentionState, NOTIFY_LIMITS } from "@shared/ipc";
import { sessionTitleText } from "@shared/titleCard";
import { i18n } from "../../i18n";
import { allControllers, dockTooNarrow, useApp } from "../../state/app";
import type { SessionController, SessionEvent } from "../../state/session";
import { type ChatVisibility, drawOverlayBadge, overlayLabel, reconcileUnseen, recordUnseen, shorten, shownChatIds } from "./attention";
import { chatTitle } from "./chat";
import { outcomeSummary } from "./outcome";

let publishedCount = -1;
let pendingAlert = false;
let publishedNotifications: boolean | undefined;

function visibility(): ChatVisibility {
	const state = useApp.getState();
	const covered = dockTooNarrow(state, window.innerWidth) && !state.chatOverDock;
	return {
		focused: document.hasFocus() && document.visibilityState !== "hidden",
		openChatIds: state.tabs.map(tab => tab.id),
		shownChatIds: shownChatIds(state.view, state.activeTabId, state.splitTabId, covered),
	};
}

/** Send changed counts to main; only a newly unseen background chat requests the one-time alert. */
function publish(alert: boolean): void {
	const state = useApp.getState();
	const count = Object.keys(state.unseenChats).length;
	const notifications = state.prefs?.notifications ?? false;
	if (count === publishedCount && notifications === publishedNotifications && !alert) return;
	publishedCount = count;
	publishedNotifications = notifications;
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
	const state = useApp.getState();
	const context = visibility();
	const next = recordUnseen(state.unseenChats, controller.tabId, event.kind, context);
	if (!context.openChatIds.includes(controller.tabId) || (context.focused && context.shownChatIds.includes(controller.tabId))) return;
	const backgroundAlert = !context.focused && (state.prefs?.notifications ?? false);
	pendingAlert = backgroundAlert && !Object.hasOwn(state.unseenChats, controller.tabId);
	try {
		if (next !== state.unseenChats) useApp.setState({ unseenChats: next });
	} finally {
		pendingAlert = false;
	}
	if (!backgroundAlert) return;
	const t = i18n.getFixedT(null, "onboarding");
	const title = sessionTitleText(chatTitle(controller) ?? t("notify.untitled"));
	const programStatus = controller.getSnapshot().host?.programStatus;
	let body: string;
	if (event.kind === "needsInput") body = programStatus?.state === "blocked" && programStatus.msg ? programStatus.msg : t("notify.needsInput");
	else {
		const summary = outcomeSummary(controller.getSnapshot().guest?.entries ?? []);
		body = programStatus?.state === "error" && programStatus.msg ? programStatus.msg : summary ? t("notify.finishedWith", { summary }) : t("notify.finished");
	}
	void window.vomp.invoke("app:notify", shorten(title, NOTIFY_LIMITS.title), shorten(body, NOTIFY_LIMITS.body), controller.tabId);
}

/** Attach to each controller and acknowledge only chats the person can currently see. */
export function installNotifications(): void {
	const watched = new WeakSet<SessionController>();
	const sync = () => {
		for (const controller of allControllers()) {
			if (watched.has(controller)) continue;
			watched.add(controller);
			controller.onEvent(event => onChatEvent(controller, event));
		}
		const state = useApp.getState();
		const next = reconcileUnseen(state.unseenChats, visibility());
		if (next !== state.unseenChats) {
			useApp.setState({ unseenChats: next });
			return;
		}
		publish(pendingAlert);
	};
	useApp.subscribe(sync);
	window.addEventListener("focus", sync);
	window.addEventListener("blur", sync);
	window.addEventListener("resize", sync);
	document.addEventListener("visibilitychange", sync);
	window.vomp.on("app:openChat", ({ chatId }) => useApp.getState().activateTab(chatId));
	// Restored tabs open on Home, so their saved unseen results remain until opened.
	sync();
}
