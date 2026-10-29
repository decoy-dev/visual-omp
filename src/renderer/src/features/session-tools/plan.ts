/** Plan mode uses omp's extension controls. Leaving retains its draft and still asks for confirmation. */
import { i18n } from "../../i18n";
import { toast } from "@/ui";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { reportFailure } from "./drive";
import { sessionModes, setSessionMode } from "./nativeModes";

/** `<session file minus .jsonl>/local/` holds `local://PLAN.md` (any `*plan.md`). */
export async function loadPlan(sessionFile: string | null): Promise<string | null> {
	if (!sessionFile) return null;
	const dir = `${sessionFile.replace(/\.jsonl$/, "")}/local`;
	const files = await window.vomp.invoke("fs:list", dir).catch(() => []);
	const plan = files.find(file => file.name === "PLAN.md") ?? files.find(file => file.kind === "file" && /plan\.md$/i.test(file.name));
	return plan ? window.vomp.invoke("fs:read", plan.path).catch(() => null) : null;
}

/** Leave plan mode without approving or deleting its draft. */
export async function exitPlan(session: SessionController): Promise<void> {
	try {
		await setSessionMode(session, { mode: "plan", action: "exit" });
		toast({ tone: "info", message: i18n.t("session:plan.off") });
	} catch (error) { reportFailure(error); }
}

/** Header Plan action: enter, or leave after confirming an existing draft. */
export async function togglePlan(session: SessionController): Promise<void> {
	try {
		const modes = await sessionModes(session);
		if (modes.plan.status === "active") {
			if (await loadPlan(session.sessionFile)) useApp.getState().openSheet("session-plan-exit", { tabId: session.tabId });
			else await exitPlan(session);
			return;
		}
		await setSessionMode(session, { mode: "plan", action: "enter" });
		toast({ tone: "info", message: i18n.t("session:plan.on") });
	} catch (error) { reportFailure(error); }
}
