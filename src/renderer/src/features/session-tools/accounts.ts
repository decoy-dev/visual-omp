import { useEffect, useState } from "react";
import type { NativeSnapshot, SessionAccounts } from "@shared/contracts/native";
import { i18n } from "../../i18n";
import type { SessionController, SessionView } from "../../state/session";
import { readyEditor, sleep } from "./drive";

/** Account state is meaningful only for this room, session and omp-selected provider. */
export function currentSessionAccounts(native: NativeSnapshot, view: SessionView): SessionAccounts | null {
	const accounts = native.sessionAccounts;
	if (view.mode !== "live" || !accounts || native.asyncJobsGeneration !== view.host?.generation ||
		accounts.sessionId !== view.host?.sessionId || accounts.provider !== view.guest?.state?.model?.provider) return null;
	return accounts;
}

/** No background timer: initial and credential-change reads use the SDK, then native change events follow routing. */
export function useSessionAccounts(session: SessionController, view: SessionView): SessionAccounts | null {
	const [state, setState] = useState<{ scope: string; accounts: SessionAccounts | null } | null>(null);
	const host = view.host;
	const provider = view.guest?.state?.model?.provider;
	const scope = JSON.stringify([host?.hostId, host?.generation, host?.sessionId, provider, view.mode]);
	useEffect(() => {
		if (view.mode !== "live" || !host || !provider) return;
		let active = true;
		let revision = 0;
		const publish = (native: NativeSnapshot) => {
			if (!active) return;
			const accounts = currentSessionAccounts(native, session.getSnapshot());
			setState(previous => previous?.scope === scope && JSON.stringify(previous.accounts) === JSON.stringify(accounts) ? previous : { scope, accounts });
		};
		const refresh = () => {
			const before = revision;
			void window.vomp.invoke("native:sessionAccounts", host.hostId, host.generation).then(accounts => {
				if (revision === before) publish({ modes: null, theme: null, asyncJobsGeneration: host.generation, sessionAccounts: accounts });
			}).catch(() => { if (active && revision === before) setState({ scope, accounts: null }); });
		};
		const off = window.vomp.on("native:changed", event => {
			if (event.hostId !== host.hostId) return;
			revision++;
			publish(event.snapshot);
		});
		const offProviders = window.vomp.on("providers:changed", refresh);
		refresh();
		return () => { active = false; off(); offProviders(); };
	}, [session, scope]); // Scope includes every host identity field, without restarting on streamed text.
	return state?.scope === scope ? state.accounts : null;
}

/** Pin through omp's slash command in either presentation, then read the session's active SDK identity. */
export async function pinSessionAccount(session: SessionController, listing: SessionAccounts, credentialId: number): Promise<SessionAccounts> {
	const initial = session.getSnapshot();
	const host = initial.host;
	const scope = () => {
		const view = session.getSnapshot();
		if (!host || view.readOnly || view.mode !== "live" || view.host?.hostId !== host.hostId || view.host.generation !== host.generation ||
			view.host.sessionId !== listing.sessionId || view.guest?.state?.model?.provider !== listing.provider) throw new Error(i18n.t("session:account.sessionChanged"));
		if (view.working) throw new Error(i18n.t("session:account.busy"));
	};
	scope();
	if (!listing.accounts.some(account => account.credentialId === credentialId)) throw new Error(i18n.t("session:account.unavailable"));
	await readyEditor(session);
	scope();
	// The explicit identity form avoids 1-based positions changing after a sign-in or sign-out.
	await session.command(`/session pin OAuth credential #${credentialId}`, scope);
	const deadline = Date.now() + 5000;
	do {
		scope();
		const native = await window.vomp.invoke("native:snapshot", host!.hostId);
		scope();
		const current = currentSessionAccounts(native, session.getSnapshot());
		if (current?.accounts.some(account => account.credentialId === credentialId && account.active)) return current;
		await sleep(120);
	} while (Date.now() < deadline);
	throw new Error(i18n.t(initial.host?.transport === "tsp" ? "session:account.notConfirmedTsp" : "session:account.notConfirmed"));
}
