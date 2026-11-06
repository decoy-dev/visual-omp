import { CaretDown, UserCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionAccounts } from "@shared/contracts/native";
import type { ChatSlotProps } from "../../registry/slots";
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger, Spinner, Tooltip, cn } from "@/ui";
import { rowPicker } from "@/ui/styles";
import { pinSessionAccount, useSessionAccounts } from "./accounts";
import { useVisualSelection } from "../../state/visualSnapshot";
import { shallow } from "zustand/shallow";
import { selectAccount } from "./selection";

/** Shorten only when the resulting visible label distinguishes this account from its peers. */
function compactAccountLabel(label: string): string {
	const email = label.match(/([^\s<>@]+)@[^\s<>@]+/u);
	const characters = Array.from(email?.[1] ?? label);
	return characters.length > 14
		? `${characters.slice(0, 8).join("")}…${characters.slice(-5).join("")}`
		: characters.join("");
}

/** The trigger and menu share this identity contract for accounts whose labels are identical. */
function fullAccountLabel(account: SessionAccounts["accounts"][number], accounts: SessionAccounts["accounts"]): string {
	return accounts.some(other => other.credentialId !== account.credentialId && other.label === account.label)
		? `${account.label} · #${account.credentialId}`
		: account.label;
}

/** This control is lazy-loaded and absent for providers with fewer than two stored OAuth accounts. */
export function AccountButton({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const view = useVisualSelection(session.subscribe, session.getSnapshot, selectAccount, shallow);
	const listing = useSessionAccounts(session, view);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const identity = JSON.stringify([view.hostId, view.generation, listing?.provider, listing?.sessionId]);
	useEffect(() => { setOpen(false); setError(null); }, [identity, view.readOnly]);
	if (!listing || listing.accounts.length < 2) return null;
	const current = listing.accounts.find(account => account.active);
	const name = current?.label ?? t("account.unselected");
	const fullName = current ? fullAccountLabel(current, listing.accounts) : name;
	let compact = current ? compactAccountLabel(name) : name;
	if (current && listing.accounts.some(account => account.credentialId !== current.credentialId && compactAccountLabel(account.label) === compact)) {
		compact = fullName;
	}
	const label = t("account.aria", { name: fullName });
	return (
		<Menu open={open} onOpenChange={next => {
			setOpen(next);
			if (next) {
				setError(null);
				if (view.hostId) void window.vomp.invoke("native:sessionAccounts", view.hostId, view.generation).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
			}
		}}>
			<Tooltip content={label}>
				<MenuTrigger asChild disabled={view.readOnly || busy}>
					<button type="button" aria-label={label} className={cn(rowPicker, "h-7 shrink-0 whitespace-nowrap")}>
						{busy ? <Spinner size={14} tone="current" /> : <UserCircle className="size-3.5 shrink-0" aria-hidden />}
						<span>{compact}</span>
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
							<span className="break-words [overflow-wrap:anywhere]">{fullAccountLabel(account, listing.accounts)}</span>
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
