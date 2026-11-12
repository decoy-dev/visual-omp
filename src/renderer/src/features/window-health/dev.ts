/**
 * Development builds only (`import.meta.env.DEV` in `index.ts`): heartbeat answers, plus Test slow-window warning in
 * a release tour, which holds them back for 45 seconds. Main's detector, the warning, the frozen-window dialog and the
 * recovery all run as they would for a slow window; only the answers are late.
 */
import { Timer } from "@phosphor-icons/react";
import { registerCommand } from "../../registry/commands";

const HOLD_MS = 45_000;
/** The hold in progress and the heartbeat main is waiting for during it. */
let holding: { seq: number | null } | null = null;
let tour = false;
void window.vomp.invoke("app:info").then(info => { tour = Boolean(info.tourLayout); }).catch(() => {});

export function answerHeartbeats(answer: (seq: number) => void): void {
	window.vomp.on("window:ping", seq => {
		if (holding) holding.seq = seq;
		else answer(seq);
	});
	registerCommand({
		id: "dev.testSlowWindow",
		title: "palette:cmd.testSlowWindow.title",
		hint: "palette:cmd.testSlowWindow.hint",
		group: "help",
		icon: Timer,
		when: () => tour && holding === null,
		run() {
			const hold: { seq: number | null } = { seq: null };
			holding = hold;
			setTimeout(() => {
				holding = null;
				if (hold.seq !== null) answer(hold.seq);
			}, HOLD_MS);
		},
	});
}
