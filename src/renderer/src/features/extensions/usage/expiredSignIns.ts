/**
 * Announces sign-ins omp stopped using. omp disables an OAuth credential whose grant expired or was revoked
 * and lists it under `disabledCredentials` in `omp usage --json`, which the shared limits snapshot carries.
 * The app reads that snapshot once at launch and checks every later one, and announces each disabled
 * credential once: the keys it announced persist in preferences, so a launch reports the sign-ins that
 * stopped working since the previous check. A profile without stored keys reports the current ones once.
 */
import type { DisabledCredential, UsageLimitsSnapshot } from "@shared/contracts/usage";
import { SIGNED_OUT_CAUSE } from "@shared/contracts/providers";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { i18n } from "@/i18n";
import { useApp } from "@/state/app";
import { openSettings } from "@/state/navigation";
import { toast } from "@/ui";
import { observeUsageLimits, readUsageLimits, usageLimitsSnapshot } from "./limitsStore";
import { providerName } from "./planUsage";

/** Keys announced in this run, so a second snapshot cannot repeat a notice before preferences round-trip. */
const announced = new Set<string>();

/** Provider, omp's credential row id and disable time; no account identity is stored. */
export function expiredSignInKey(credential: DisabledCredential): string {
	return `${credential.provider}:${credential.id}:${credential.disabledAtMs ?? ""}`;
}

/** Disabled sign-ins not announced yet. omp also records the user's own sign-outs, which need no notice. */
export function unannouncedSignIns(snapshot: UsageLimitsSnapshot, shown: readonly string[]): DisabledCredential[] {
	const known = new Set(shown);
	return snapshot.disabledCredentials.filter(credential => !SIGNED_OUT_CAUSE.test(credential.cause) && !known.has(expiredSignInKey(credential)));
}

export function expiredSignInNotice(credentials: readonly DisabledCredential[], t: TFunction, locale: string): { message: string; description: string } {
	const providers = [...new Set(credentials.map(credential => credential.provider))].map(providerName);
	if (providers.length > 1) {
		return {
			message: t("usage.signIns.titleMany", { count: providers.length }),
			description: t("usage.signIns.providers", { providers: new Intl.ListFormat(locale, { type: "conjunction" }).format(providers) }),
		};
	}
	const message = t("usage.signIns.titleOne", { provider: providers[0] });
	const [credential] = credentials;
	if (credentials.length > 1 || !credential) return { message, description: t("usage.signIns.accounts", { count: credentials.length }) };
	const account = credential.email ?? credential.accountId ?? credential.orgName;
	const date = credential.disabledAtMs === undefined ? null : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(credential.disabledAtMs);
	const key = account ? (date ? "account" : "accountUndated") : date ? "unnamed" : "unnamedUndated";
	return { message, description: t(`usage.signIns.${key}`, { account, date }) };
}

/** Shows one notice for the sign-ins in `snapshot` that were not announced before and records them. */
export function announceExpiredSignIns(snapshot: UsageLimitsSnapshot): void {
	const { prefs, setPrefs } = useApp.getState();
	if (!prefs) return;
	const fresh = unannouncedSignIns(snapshot, [...prefs.expiredSignInsShown, ...announced]);
	if (fresh.length === 0) return;
	for (const credential of fresh) announced.add(expiredSignInKey(credential));
	// A failed save only means a later launch reports these sign-ins again.
	setPrefs({ expiredSignInsShown: [...new Set([...prefs.expiredSignInsShown, ...announced])] }).catch(() => undefined);
	const t = i18n.getFixedT(null, "extensions");
	const { message, description } = expiredSignInNotice(fresh, t, i18n.language);
	toast({ tone: "warn", message, description, action: { label: t("usage.signIns.open"), onClick: () => openSettings("providers") } });
}

/** App-wide watcher: once omp is usable and setup is done, reads the limits once and checks each new snapshot. */
export function ExpiredSignInWatcher(): null {
	const ready = useApp(state => state.prefs?.setupCompleted === true && state.omp?.found === true && state.omp.supported && !state.omp.refused);
	useEffect(() => {
		if (!ready) return;
		const stop = observeUsageLimits(announceExpiredSignIns);
		const current = usageLimitsSnapshot();
		if (current) announceExpiredSignIns(current);
		void readUsageLimits();
		return stop;
	}, [ready]);
	return null;
}

