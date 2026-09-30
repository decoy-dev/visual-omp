/**
 * Plan mode for one chat. `/plan` cycles omp through on → paused → off (a paused plan keeps its tools
 * and model restored; the next bare `/plan` turns it fully off). Leaving with a draft plan makes omp
 * ask "Exit plan mode?" in its editor slot, which the app answers after asking the user itself.
 */
import { i18n } from "../../i18n";
import { toast } from "@/ui";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { press, readyEditor, reportFailure, reportOutput, runCommand, waitForScreen } from "./drive";
import { parseStatusLine, type PlanState } from "./screen";
import { screenPoller } from "./status";

/** `<session file minus .jsonl>/local/` holds `local://PLAN.md` (any `*plan.md`). */
export async function loadPlan(sessionFile: string | null): Promise<string | null> {
	if (!sessionFile) return null;
	const dir = `${sessionFile.replace(/\.jsonl$/, "")}/local`;
	const files = await window.vomp.invoke("fs:list", dir).catch(() => []);
	const plan = files.find(file => file.name === "PLAN.md") ?? files.find(file => file.kind === "file" && /plan\.md$/i.test(file.name));
	return plan ? window.vomp.invoke("fs:read", plan.path).catch(() => null) : null;
}

/** Run `/plan` once and wait for the plan segment of the status line to change. */
async function stepPlan(session: SessionController, from: PlanState): Promise<PlanState> {
	const { output, screen } = await runCommand(session, "/plan", {
		until: (lines, printed) =>
			lines.some(line => line.includes("Exit plan mode?")) ||
			(parseStatusLine(lines)?.plan ?? from) !== from ||
			printed.some(line => /^warning/i.test(line)),
	});
	if (screen.some(line => line.includes("Exit plan mode?"))) {
		// The user already confirmed in the app; "Yes" is omp's default choice.
		await press(session, "enter");
	}
	const after = await waitForScreen(session, lines => (parseStatusLine(lines)?.plan ?? from) !== from, 3000);
	const next = (after && parseStatusLine(after)?.plan) ?? from;
	if (next === from) reportOutput(output);
	return next;
}

/** Leave plan mode entirely (on or paused → off). */
export async function exitPlan(session: SessionController): Promise<void> {
	try {
		let state = parseStatusLine(await readyEditor(session))?.plan ?? "off";
		for (let step = 0; state !== "off" && step < 2; step++) state = await stepPlan(session, state);
		if (state === "off") toast({ tone: "info", message: i18n.t("session:plan.off") });
	} catch (error) {
		reportFailure(error);
	} finally {
		void screenPoller(session).refresh();
	}
}

/** Header "Plan" button: turn plan mode on, or off (asking first when a draft plan exists). */
export async function togglePlan(session: SessionController): Promise<void> {
	try {
		const state = parseStatusLine(await readyEditor(session))?.plan ?? "off";
		if (state === "on") {
			if (await loadPlan(session.sessionFile)) useApp.getState().openSheet("session-plan-exit", { tabId: session.tabId });
			else await exitPlan(session);
			return;
		}
		// Paused → a bare /plan turns it off; one more turns it back on.
		let next = state === "paused" ? await stepPlan(session, state) : state;
		if (next === "off") next = await stepPlan(session, "off");
		if (next === "on") toast({ tone: "info", message: i18n.t("session:plan.on") });
	} catch (error) {
		reportFailure(error);
	} finally {
		void screenPoller(session).refresh();
	}
}
