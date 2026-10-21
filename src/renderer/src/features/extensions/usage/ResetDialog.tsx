/**
 * Usage & limits → Spend a saved reset (DESIGN §4.18). Opening the dialog asks omp for its live
 * `/usage reset` listing and finds this account in it, so the dialog states which stored sign-in omp
 * would spend from and whether it can spend one now. Confirming sends `/usage reset <provider>/<credential id>`
 * to a short-lived omp (`usage:spendReset`), shows what omp printed and refreshes the limits. The steps
 * live in {@link ResetFlow}, which keeps the confirmed target fixed while omp works.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent, Notice, Spinner } from "@/ui";
import { checkUsageLimits } from "./limitsStore";
import type { AccountLimits } from "./planUsage";
import { ResetFlow } from "./resets";

export interface ResetDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	/** Provider id (`openai-codex`, `anthropic`). */
	provider: string;
	/** Product name ("Codex"). */
	providerName: string;
	account: AccountLimits;
	/** How the account is named on the page, with its organization. */
	accountName: string;
	/** Names of the account's limits omp's last report says the next reset clears; empty when it doesn't say. */
	clears: string[];
}

export function ResetDialog({ open, onOpenChange, provider, providerName, account, accountName, clears }: ResetDialogProps) {
	const { t, i18n } = useTranslation("extensions");
	const flow = useMemo(
		() =>
			new ResetFlow({
				list: () => window.vomp.invoke("usage:resetAccounts"),
				spend: target => window.vomp.invoke("usage:spendReset", target),
				refresh: checkUsageLimits,
			}),
		[],
	);
	const phase = useSyncExternalStore(flow.subscribe, flow.snapshot);
	const [attempt, setAttempt] = useState(0);
	// The snapshot is rebuilt on every poll, so the effect keys on the identity's values; the flow
	// itself ignores checks while a spend runs.
	const { accountId, email, orgId, orgName } = account.identity;
	useEffect(() => {
		if (open) flow.check(provider, { accountId, email, orgId, orgName });
		else flow.close();
	}, [flow, open, attempt, provider, accountId, email, orgId, orgName]);

	const spending = phase.kind === "spending";
	const entry = phase.kind === "ready" || phase.kind === "spending" ? phase.entry : null;
	const usable = entry !== null && entry.unavailable === null && (entry.usableCount ?? 0) > 0;
	const expires = entry?.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
	const list = new Intl.ListFormat(i18n.language, { type: "conjunction" });
	const spent = phase.kind === "spent" ? phase : null;

	const footer = spent ? (
		<>
			{spent.refresh.kind === "failed" && <Button onClick={() => void flow.refreshLimits()}>{t("usage.limits.resets.refreshAction")}</Button>}
			<Button variant="primary" onClick={() => onOpenChange(false)}>
				{t("common.done")}
			</Button>
		</>
	) : (
		<>
			<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={spending}>
				{t("common.cancel")}
			</Button>
			{phase.kind === "failed" ? (
				<Button variant="primary" onClick={() => setAttempt(value => value + 1)}>
					{t("common.retry")}
				</Button>
			) : (
				<Button variant="primary" disabled={!usable} loading={spending} onClick={() => void flow.spend()}>
					{t("usage.limits.resets.spend")}
				</Button>
			)}
		</>
	);

	return (
		<Dialog open={open} onOpenChange={next => !spending && onOpenChange(next)}>
			<DialogContent
				title={t(spent ? "usage.limits.resets.spentTitle" : "usage.limits.resets.dialogTitle", { provider: providerName })}
				description={t(spent ? "usage.limits.resets.spentAccount" : "usage.limits.resets.dialogAccount", { account: accountName })}
				footer={footer}
			>
				<div className="flex flex-col gap-3" aria-live="polite">
					{(phase.kind === "checking" || phase.kind === "idle") && (
						<p className="flex items-center gap-2 text-fg-muted">
							<Spinner size={14} />
							{t("usage.limits.resets.checking")}
						</p>
					)}
					{phase.kind === "failed" && (
						<Notice tone="err">
							{t("usage.limits.resets.listFailed")} {phase.error}
						</Notice>
					)}
					{phase.kind === "unreadable" && <Notice tone="warn">{t("usage.limits.resets.unreadable")}</Notice>}
					{phase.kind === "unmatched" && <Notice tone="warn">{t("usage.limits.resets.unmatched")}</Notice>}
					{entry && (
						<>
							<p className="[overflow-wrap:anywhere]">{t("usage.limits.resets.target", { label: entry.label, target: `${entry.provider}/${entry.credentialId}` })}</p>
							<p className="text-fg-muted">
								{clears.length > 0 ? t("usage.limits.resets.clears", { limits: list.format(clears) }) : t("usage.limits.resets.clearsUnknown", { provider: providerName })}
							</p>
							{entry.savedCount !== null && entry.usableCount !== null && (
								<p className="text-fg-muted">
									{t("usage.limits.resets.ompCounts", { count: entry.savedCount, usable: entry.usableCount })}
									{Number.isFinite(expires) &&
										` ${t("usage.limits.resets.ompExpiry", {
											date: new Intl.DateTimeFormat(i18n.language, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(expires),
										})}`}
								</p>
							)}
							{usable ? (
								<p className="text-fg-muted">{t("usage.limits.resets.final")}</p>
							) : (
								<Notice tone="warn">{t("usage.limits.resets.notUsable", { reason: entry.unavailable ?? t("usage.limits.resets.noneUsable") })}</Notice>
							)}
						</>
					)}
					{spent && (
						<>
							{spent.outcome && spent.outcome.output !== "" && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{spent.outcome.output}</p>}
							{spent.outcome && !spent.outcome.confirmed && <Notice tone="warn">{t("usage.limits.resets.unconfirmed")}</Notice>}
							{spent.error !== null && (
								<Notice tone="err">
									{t("usage.limits.resets.notSent")} {spent.error}
								</Notice>
							)}
							{spent.refresh.kind === "failed" ? (
								<Notice tone="err">
									{t("usage.limits.resets.refreshFailed")} {spent.refresh.error}
								</Notice>
							) : (
								<p className="flex items-center gap-2 text-sm text-fg-muted">
									{spent.refresh.kind === "running" && <Spinner size={12} />}
									{t(spent.refresh.kind === "running" ? "usage.limits.resets.refreshing" : "usage.limits.resets.refreshed")}
								</p>
							)}
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
