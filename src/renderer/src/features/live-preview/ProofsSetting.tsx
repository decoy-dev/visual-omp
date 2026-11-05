import { useEffect, useState } from "react";
import { useDeferredTranslation } from "@/i18n";
import { useApp } from "@/state/app";
import { Button, Switch } from "@/ui";
import { ipcErrorMessage, useResource } from "../manage/shared";

/** This preference manages an omp skill; all loading and diagnostics remain in the existing skill flow. */
export function ProofsSetting() {
	const { t } = useDeferredTranslation("settings");
	const enabled = useApp(state => state.prefs?.visualProofs === true);
	const status = useResource(() => window.vomp.invoke("proofs:status"), [enabled]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => window.vomp.on("skills:changed", () => void status.reload()), [status.reload]);
	useEffect(() => window.vomp.on("config:changed", () => void status.reload()), [status.reload]);

	const change = async (next: boolean) => {
		setPending(true);
		setError(null);
		try { status.setData(await window.vomp.invoke("proofs:set", next)); }
		catch (reason) { setError(ipcErrorMessage(reason)); }
		finally { setPending(false); }
	};
	const current = status.data;
	const note = current?.state === "conflict" ? t("general.visualProofs.conflict", { path: current.path })
		: current?.state === "unavailable" ? t(`general.visualProofs.${current.reason}`)
		: current?.state === "outdated" ? t("general.visualProofs.outdated") : null;
	return (
		<div className="py-3">
			<Switch label={t("general.visualProofs.label")} description={t("general.visualProofs.description")}
				checked={enabled} disabled={pending || status.loading || current?.state === "conflict"}
				onCheckedChange={next => void change(next)} />
			{note && <p className="mt-2 break-words text-sm text-fg-muted" role="status">{note}</p>}
			{(error || status.error) && <p className="mt-2 text-sm text-err" role="alert">{error || status.error}</p>}
			{(current?.state === "outdated" || current?.state === "unavailable" || current?.state === "conflict" || status.error) && (
				<Button className="mt-2" size="sm" variant="secondary" disabled={pending || status.loading}
					onClick={() => void (current?.state === "outdated" ? change(true) : status.reload())}>
					{t(current?.state === "outdated" ? "general.visualProofs.repair" : "general.visualProofs.checkAgain")}
				</Button>
			)}
		</div>
	);
}
