/**
 * The slow-window warning (DESIGN §4.22). Main judges the window from heartbeats and the bytes waiting to reach it
 * (`main/services/window-health.ts`); this answers the heartbeats and shows main's verdict as a sticky warning with
 * Reload window and Close idle chats. A dismissed warning stays dismissed for that slowdown, and it goes away by itself
 * when the window keeps up again.
 */
import type { WindowHealthIncident } from "@shared/contracts/window-health";
import { i18n } from "../../i18n";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { registerCommand } from "../../registry/commands";
import { chatTitle } from "../../shell/hooks";
import { allControllers, closeIdleChats, useApp } from "../../state/app";
import { dismissToast, toast, updateToast } from "../../ui/toast";

function answer(seq: number): void {
	void window.vomp.invoke("window:heartbeat", seq).catch(() => {});
}

/** Tell main this page answers heartbeats, once its listener is in place; main sends none before that. */
function ready(): void {
	void window.vomp.invoke("window:ready").catch(() => {});
}

// Development builds answer through `dev.ts`, whose release-tour command can hold answers back to try the warning.
if (import.meta.env.DEV) {
	void import("./dev").then(dev => {
		dev.answerHeartbeats(answer);
		ready();
	});
} else {
	window.vomp.on("window:ping", answer);
	ready();
}

/** The title the chat on `hostId` shows, for naming it in the warning. */
function hostTitle(hostId: string): string {
	const controller = allControllers().find(candidate => candidate.hostId === hostId);
	const tab = controller ? useApp.getState().tabs.find(entry => entry.id === controller.tabId) : undefined;
	return chatTitle(controller?.getSnapshot() ?? null, tab?.title ?? null) ?? i18n.t("onboarding:notify.untitled");
}

/** The warning's title and its explanation for `incident`; a slow window comes first since it delays every chat. */
export function healthCopy(incident: WindowHealthIncident, title: (hostId: string) => string): { message: string; description: string } {
	const reload = i18n.t("shell:health.reload");
	if (incident.slow) return { message: i18n.t("shell:health.slowTitle"), description: `${i18n.t("shell:health.slowBody")} ${reload}` };
	const [first] = incident.delayed.length > 0 ? incident.delayed : incident.resyncing;
	const count = incident.delayed.length > 0 ? incident.delayed.length : incident.resyncing.length;
	const kind = incident.delayed.length > 0 ? "delayed" : "resyncing";
	const body = count === 1 ? i18n.t(`shell:health.${kind}One`, { title: title(first!) }) : i18n.t(`shell:health.${kind}Many`, { count });
	return { message: i18n.t("shell:health.delayedTitle"), description: `${body} ${reload}` };
}

let shown: { incident: number; toastId: string; message: string } | null = null;
let dismissed: number | null = null;

window.vomp.on("window:health", incident => {
	if (!incident) {
		const current = shown;
		shown = null;
		if (current) dismissToast(current.toastId);
		return;
	}
	if (incident.id === dismissed) return;
	const copy = healthCopy(incident, hostTitle);
	if (shown?.incident === incident.id && shown.message === copy.message) {
		updateToast(shown.toastId, { description: copy.description });
		return;
	}
	// A new slowdown, or one whose title changed: replace the warning without counting it as dismissed.
	const replaced = shown;
	shown = null;
	if (replaced) dismissToast(replaced.toastId);
	const toastId = toast({
		tone: "warn",
		sticky: true,
		message: copy.message,
		description: copy.description,
		secondaryAction: {
			label: i18n.t("shell:health.closeIdle"),
			onClick: () => void closeIdleChats().then(closed => {
				if (closed !== null && closed > 0) void window.vomp.invoke("window:healthActed").catch(() => {});
			}),
		},
		action: { label: i18n.t("shell:health.reloadWindow"), onClick: () => void window.vomp.invoke("window:reload").catch(() => {}) },
		onDismiss: () => {
			if (shown?.toastId !== toastId) return;
			shown = null;
			dismissed = incident.id;
		},
	});
	shown = { incident: incident.id, toastId, message: copy.message };
});

registerCommand({
	id: "window.reload",
	title: "palette:cmd.reloadWindow.title",
	hint: "palette:cmd.reloadWindow.hint",
	keywords: "palette:cmd.reloadWindow.keywords",
	group: "help",
	icon: ArrowsClockwise,
	// Main asks first, natively, since text typed into an open omp form is not kept.
	run: () => void window.vomp.invoke("window:reload").catch(() => {}),
});

