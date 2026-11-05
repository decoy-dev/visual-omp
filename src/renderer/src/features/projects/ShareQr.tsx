import { useMemo, type ReactNode } from "react";
import { useDeferredTranslation } from "@/i18n";
import { shareQr } from "./share-qr";

export function ShareQr({ link }: { link: string }): ReactNode {
	const { t } = useDeferredTranslation("projectDetails");
	const code = useMemo(() => {
		try { return shareQr(link); }
		catch { return null; }
	}, [link]);
	return (
		<div className="flex flex-wrap items-center gap-4">
			{code ? (
				<svg role="img" aria-label={t("share.invite.qrLabel")} viewBox={`0 0 ${code.size} ${code.size}`} className="size-40 shrink-0" shapeRendering="crispEdges">
					<rect width={code.size} height={code.size} fill="var(--qr-bg)" />
					<path d={code.path} fill="var(--qr-fg)" />
				</svg>
			) : <p role="status" className="text-sm text-fg-muted">{t("share.invite.qrFailed")}</p>}
			<div className="min-w-0 flex-1 basis-40">
				<h3 className="text-md font-medium text-fg">{t("share.invite.phone")}</h3>
				<p className="mt-2 text-sm text-fg-muted">{t("share.invite.phoneHint")}</p>
			</div>
		</div>
	);
}
