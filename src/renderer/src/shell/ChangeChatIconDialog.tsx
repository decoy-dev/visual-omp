import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@shared/ipc";
import { splitCardTitle } from "@shared/titleCard";
import { composeCardTitle, normalizeCardIcon } from "@shared/titleCardCompose";
import { commandOutcomeSpec } from "@shared/tsp/command-result";
import type { SessionController } from "../state/session";
import { Button, Dialog, DialogContent, Input, SessionTitle } from "../ui";
import { runCommand } from "../features/session-tools/drive";
import { renameSavedChat } from "./renameSavedChat";

export function ChangeChatIconDialog({ title, live, session, close }: { title: string; live: SessionController | null; session: SessionSummary | null; close(): void }) {
	const { t } = useTranslation("session");
	const formId = useId();
	const card = splitCardTitle(title);
	const [emoji, setEmoji] = useState(normalizeCardIcon(card?.icon ?? "") ?? "");
	const [emojiEdited, setEmojiEdited] = useState(false);
	const [code, setCode] = useState(card?.code ?? "");
	const [supported, setSupported] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const emojiInput = useRef<HTMLInputElement>(null);
	const pending = useRef(false);
	const terminalIcon = !!card && /\p{Co}/u.test(card.icon);
	const emojiError = emojiEdited && !normalizeCardIcon(emoji) ? t("changeIcon.invalidEmoji") : undefined;
	let composed: string | undefined;
	try { composed = composeCardTitle(emoji, code, card?.title ?? title); } catch { /* Invalid fields keep Save disabled. */ }

	useEffect(() => {
		let active = true;
		void window.vomp.invoke("app:emojiPanelSupported").then(value => { if (active) setSupported(value); }).catch(() => undefined);
		return () => { active = false; };
	}, []);

	const chooseEmoji = async () => {
		emojiInput.current?.focus();
		emojiInput.current?.select();
		try { await window.vomp.invoke("app:showEmojiPanel"); }
		catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
	};
	const submit = async () => {
		if (!composed || pending.current || (!live && !session)) return;
		pending.current = true;
		setBusy(true);
		setError(null);
		try {
			if (live) {
				const result = await runCommand(live, `/rename ${composed}`, { timeoutMs: 10000, until: (_screen, output) => output.length > 0 });
				const outcome = commandOutcomeSpec("/rename")!;
				const failure = result.output.find(line => outcome.errors?.some(pattern => pattern.test(line)));
				if (failure || result.status === "error" || result.status === "cancelled") throw new Error(failure ?? (result.output.join("\n") || t("changeIcon.unconfirmed")));
				if (!result.output.some(line => outcome.success?.test(line))) throw new Error([t("changeIcon.unconfirmed"), ...result.output].join("\n"));
			} else if (session) await renameSavedChat(session, composed);
			close();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={open => !open && !busy && close()}>
			<DialogContent title={t("changeIcon.title")} description={t("changeIcon.description")} size="md" footer={<><Button variant="ghost" disabled={busy} onClick={close}>{t("common.cancel")}</Button><Button variant="primary" type="submit" form={formId} loading={busy} disabled={!composed || (!live && !session)}>{t("changeIcon.action")}</Button></>}>
				<form id={formId} className="space-y-stack" onSubmit={event => { event.preventDefault(); void submit(); }}>
					<div className="min-w-0 rounded-md bg-inset p-row" role="group" aria-label={t("changeIcon.preview")}><SessionTitle title={composed ?? title} /></div>
					{terminalIcon && <p className="text-md text-fg-muted">{t("changeIcon.terminalIcon")}</p>}
					<Input ref={emojiInput} autoFocus label={t("changeIcon.emoji")} description={t("changeIcon.emojiHint")} error={emojiError} value={emoji} disabled={busy} autoComplete="off" onChange={event => { setEmojiEdited(true); setEmoji(event.currentTarget.value); }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
					{supported && <Button variant="secondary" disabled={busy} onClick={() => void chooseEmoji()}>{t("changeIcon.chooseEmoji")}</Button>}
					{!card && <Input label={t("changeIcon.code")} description={t("changeIcon.codeHint")} value={code} disabled={busy} maxLength={6} autoComplete="off" onChange={event => setCode(event.currentTarget.value.toUpperCase())} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />}
					{error && <p role="alert" className="text-md text-err">{error}</p>}
				</form>
			</DialogContent>
		</Dialog>
	);
}
