import { parseSessionExportOutput } from "@shared/session-export";
import { toast } from "@/ui";
import { i18n } from "../../i18n";
import type { SessionController } from "../../state/session";
import { readyEditor, reportFailure, reportOutput, runCommand } from "./drive";

function showExport(path: string, message: string, description?: string): true {
	toast({ tone: "ok", message, description, action: { label: i18n.t("session:export.show"), onClick: () => void window.vomp.invoke("app:showItem", path) } });
	return true;
}

/** Prefer the live export, preserving the system prompt and tool list whenever omp can parse its path. */
export async function exportChat(session: SessionController, useUserThemes = false): Promise<void> {
	try {
		await readyEditor(session);
		const file = session.sessionFile;
		if (!file) throw new Error(i18n.t("session:export.unsaved"));
		const plan = await window.vomp.invoke("share:defaultExport", file, session.projectPath, useUserThemes);
		const description = plan.fallback ? i18n.t(`session:export.${plan.fallback}`) : undefined;
		if (plan.command === null) {
			showExport(plan.path, i18n.t("session:export.saved", { path: plan.path }), description);
			return;
		}
		await runCommand(session, plan.command, {
			timeoutMs: 10000,
			until: (_lines, output) => output.some(line => /Session exported to:|Failed to export session:/i.test(line)),
			present: result => {
				if (result.status === "error" || result.status === "cancelled" || result.output.some(line => /Failed to export session:/i.test(line))) return reportOutput(result.output, undefined, result.status);
				const parsed = parseSessionExportOutput(result.output);
				return parsed ? showExport(parsed.path, parsed.message, description) : false;
			},
		});
	} catch (error) { reportFailure(error); }
}
