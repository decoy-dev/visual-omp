import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@shared/ipc";
import { Button, Dialog, DialogContent, Input } from "../ui";
import { renameSavedChat } from "./renameSavedChat";

export function RenameChatDialog({ session, close }: { session: SessionSummary; close(): void }) {
	const { t } = useTranslation("session");
	const [value, setValue] = useState(session.title ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const titleInput = useRef<HTMLInputElement>(null);
	const submit = async () => {
		if (busy || !value.trim()) return;
		setBusy(true);
		setError(null);
		try {
			await renameSavedChat(session, value);
			close();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={open => !open && !busy && close()}>
			<DialogContent initialFocus={titleInput} title={t("rename.title")} description={t("rename.savedDescription")} size="md" footer={<><Button variant="ghost" disabled={busy} onClick={close}>{t("common.cancel")}</Button><Button variant="primary" loading={busy} disabled={!value.trim()} onClick={() => void submit()}>{t("rename.action")}</Button></>}>
				<Input ref={titleInput} label={t("rename.label")} value={value} disabled={busy} onChange={event => setValue(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit(); }} />
				{error && <p role="alert" className="mt-3 text-md text-err">{error}</p>}
			</DialogContent>
		</Dialog>
	);
}
