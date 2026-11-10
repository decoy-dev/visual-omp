import { Play } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { shallow } from "zustand/shallow";
import type { NativeSnapshot } from "@shared/contracts/native";
import type { SessionController } from "../state/session";
import { supportsContinue } from "../state/continue";
import { useVisualSelection } from "../state/visualSnapshot";
import { MenuItem, Tooltip, toast } from "../ui";

/** Only the parent header mounts this item; helper input has no resume capability. */
export function ContinueAction({ session }: { session: SessionController }) {
	const { t } = useTranslation("chat");
	const { host, mode, eligible } = useVisualSelection(session.subscribe, session.getSnapshot,
		view => ({ host: view.host, mode: view.mode, eligible: session.canContinue }), shallow);
	const [native, setNative] = useState<{ scope: string; snapshot: NativeSnapshot } | null>(null);
	const [pending, setPending] = useState(false);
	const scope = JSON.stringify([host?.hostId, host?.generation, mode]);
	useEffect(() => {
		if (!host || mode !== "live") return;
		let active = true;
		let revision = 0;
		const publish = (snapshot: NativeSnapshot) => { if (active) setNative({ scope, snapshot }); };
		const off = window.vomp.on("native:changed", event => {
			if (event.hostId !== host.hostId) return;
			revision++;
			publish(event.snapshot);
		});
		void window.vomp.invoke("native:snapshot", host.hostId).then(snapshot => {
			if (revision === 0) publish(snapshot);
		}).catch(() => {});
		return () => { active = false; off(); };
	}, [session, scope]);
	if (native?.scope !== scope || !supportsContinue(native.snapshot, session.getSnapshot())) return null;
	const run = async () => {
		setPending(true);
		try { await session.continueTurn(); }
		catch (error) { toast({ tone: "err", message: error instanceof Error ? error.message : String(error) }); }
		finally { setPending(false); }
	};
	return <Tooltip content={t("continue.hint")}>
		<MenuItem icon={<Play />} disabled={!eligible || pending} onSelect={() => { void run(); }}>
			{t("continue.label")}
		</MenuItem>
	</Tooltip>;
}
