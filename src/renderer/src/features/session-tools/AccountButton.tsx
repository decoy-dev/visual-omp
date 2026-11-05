import { CaretDown, UserCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatSlotProps } from "../../registry/slots";
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger, Spinner, Tooltip, cn } from "@/ui";
import { rowPicker } from "@/ui/styles";
import { pinSessionAccount, useSessionAccounts } from "./accounts";
import { useSessionView } from "./status";

/** This control is lazy-loaded and absent for providers with fewer than two stored OAuth accounts. */
export function AccountButton({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const view = useSessionView(session);
	const listing = useSessionAccounts(session, view);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const identity = JSON.stringify([view.host?.hostId, view.host?.generation, listing?.provider, listing?.sessionId]);
	useEffect(() => { setOpen(false); setError(null); }, [identity, view.readOnly]);
	if (!listing || listing.accounts.length < 2) return null;
	const current = listing.accounts.find(account => account.active);
	const name = current?.label ?? t("account.unselected");
	return (
		<Menu open={open} onOpenChange={next => {
			setOpen(next);
			if (next) {
				setError(null);
				if (view.host) void window.vomp.invoke("native:sessionAccounts", view.host.hostId, view.host.generation).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
			}
		}}>
			<Tooltip content={t("account.aria", { name })}>
				<MenuTrigger asChild disabled={view.readOnly || busy}>
					<button type="button" aria-label={t("account.aria", { name })} className={cn(rowPicker, "h-7 min-w-0 max-w-[min(16rem,100%)] shrink-0")}>
						{busy ? <Spinner size={14} tone="current" /> : <UserCircle className="size-3.5 shrink-0" aria-hidden />}
						<span className="truncate">{name}</span>
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</MenuTrigger>
			</Tooltip>
			<MenuContent side="top" align="end" className="w-80 max-w-[calc(100vw-2rem)]">
				<MenuLabel>{t("account.title")}</MenuLabel>
				<p className="px-row pb-1 text-sm text-fg-muted">{t("account.scopeNote")}</p>
				<MenuRadioGroup value={current ? String(current.credentialId) : ""} onValueChange={value => {
					if (pending.current) return;
					pending.current = true; setBusy(true); setError(null);
					void pinSessionAccount(session, listing, Number(value)).then(() => setOpen(false), cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => { pending.current = false; setBusy(false); });
				}}>
					{listing.accounts.map(account => (
						<MenuRadioItem key={account.credentialId} value={String(account.credentialId)} disabled={view.readOnly || view.working || busy} onSelect={event => event.preventDefault()} className="h-auto min-h-8 [&>span:last-child]:whitespace-normal">
							<span className="break-words [overflow-wrap:anywhere]">{account.label}</span>
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
				{view.working && <p className="px-row pt-1 text-sm text-fg-muted">{t("account.busy")}</p>}
				{busy && <p role="status" className="px-row pt-1 text-sm text-fg-muted">{t("account.confirming")}</p>}
				{error && <p role="alert" className="px-row pt-1 text-sm text-err">{error}</p>}
			</MenuContent>
		</Menu>
	);
}
