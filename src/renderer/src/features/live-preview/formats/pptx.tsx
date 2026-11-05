import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PdfFrame } from "../../panes/media";
import { FileName } from "../../panes/common";
import { openInFiles } from "../../panes/files-store";
import { usePreviewGrant } from "./usePreviewGrant";
import { WaitingForSave } from "./shared";
import type { LiveAdapter, LiveFrameProps } from "../types";

export function Frame(props: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const { frame, error } = usePreviewGrant(props);
	const [good, setGood] = useState<{ path: string; revision: number; bytes: Uint8Array<ArrayBuffer> } | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	useEffect(() => {
		if (!frame) return;
		let current = true;
		void (async () => {
			try {
				const result = await window.vomp.invoke("preview:slides", frame.grant.token, frame.revision);
				if (!current) return;
				if (!result.ok) { setFailure(result.reason); return; }
				if (result.revision !== frame.revision) return;
				const bytes = await window.vomp.invoke("panes:readPdf", result.pdfPath);
				if (!current) return;
				setGood({ path: result.pdfPath, revision: result.revision, bytes }); setFailure(null);
			} catch { if (current) setFailure("failed"); }
		})();
		return () => { current = false; };
	}, [frame]);
	const images = props.turnImages ?? [];
	return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
		{good && <PdfFrame key={good.revision} path={good.path} revision={good.revision} bytes={good.bytes} name={props.subject.path?.split(/[\\/]/).at(-1) ?? ""} />}
		{failure === "noLibreOffice" && <div className="p-3 text-sm text-fg-muted" role="status">
			<p>{t("live.office.noLibreOffice")}</p>
			{images.length > 0 && <ul className="mt-2 flex flex-col gap-1" aria-label={t("live.office.slideImages")}>
				{images.map(path => <li key={path}><button type="button" className="max-w-full rounded-sm text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
					onClick={() => openInFiles(props.projectPath ?? path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1), path)} title={path}><FileName name={path.split(/[\\/]/).at(-1) ?? path} /></button></li>)}
			</ul>}
		</div>}
		{(error || failure === "failed" || failure === "revoked") && <WaitingForSave />}
		{failure && ["unsafe", "tooLarge", "timeout", "converterUnavailable"].includes(failure) && <p role="status" className="p-3 text-sm text-fg-muted">{t(failure === "converterUnavailable" ? "live.office.converterUnavailable" : failure === "timeout" ? "live.office.timeout" : "live.office.unsafe")}{failure === "timeout" && good && <> {t("live.office.retained")}</>}</p>}
	</div>;
}

export const adapter: LiveAdapter = { format: "pptx", maxFps: 2, Frame };
