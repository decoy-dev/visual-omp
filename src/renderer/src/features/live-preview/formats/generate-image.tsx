import { useTranslation } from "react-i18next";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { useContentHeight } from "./shared";

export function Frame({ subject, onHeight }: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const request = subject.request;
	const content = useContentHeight(onHeight);
	return <div className="min-h-0 flex-1 overflow-auto p-4"><div ref={content} className="flow-root">
		{request?.prompt && <><h4 className="mb-2 text-sm font-medium text-fg">{t("live.requestPrompt")}</h4><p className="whitespace-pre-wrap break-words text-sm text-fg">{request.prompt}</p></>}
		<dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
			{request?.model && <><dt className="text-fg-muted">{t("live.requestModel")}</dt><dd className="break-words text-fg">{request.model}</dd></>}
			{request?.size && <><dt className="text-fg-muted">{t("live.requestSize")}</dt><dd className="text-fg">{request.size}</dd></>}
			{request?.aspectRatio && <><dt className="text-fg-muted">{t("live.requestAspectRatio")}</dt><dd className="text-fg">{request.aspectRatio}</dd></>}
			{request?.count !== null && request?.count !== undefined && <><dt className="text-fg-muted">{t("live.requestCount")}</dt><dd className="text-fg tabular-nums">{request.count}</dd></>}
		</dl>
	</div></div>;
}

export const adapter: LiveAdapter = { format: "generate-image", maxFps: 4, Frame };
