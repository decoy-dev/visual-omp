import { Eye } from "@phosphor-icons/react";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { FileRefContext } from "../../chat/transcript/FileLinks";
import { useApp } from "../../state/app";
import { IconButton } from "../../ui";
import { isVisualCall } from "./subjects";
import { useLivePreview } from "./store";

export function WatchAction({ name, args, callId }: { name: string; args: unknown; callId?: string }) {
	const { t } = useTranslation("panes");
	const scope = useContext(FileRefContext);
	const enabled = useApp(state => state.prefs?.livePreview === true);
	if (!enabled || !scope?.chat || !isVisualCall(name, args)) return null;
	return <IconButton size="md" className="data-live-watch:rounded-sm data-live-watch:text-fg-faint data-live-watch:focus-visible:-outline-offset-2 data-live-watch:[&>svg]:size-3.5" data-live-watch="" label={t("live.watch")} icon={<Eye />} onClick={() => {
		if (callId) useLivePreview.getState().select(scope.chat, `call:${callId}`);
		useApp.getState().showPane("outputs", scope.chat);
	}} />;
}
