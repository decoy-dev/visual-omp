import { useEffect, useRef, useState } from "react";
import type { PreviewGrant } from "@shared/contracts/preview";
import { PdfFrame } from "../../panes/media";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { WaitingForSave } from "./shared";
import { usePreviewGrant } from "./usePreviewGrant";

interface PdfRevision { grant: PreviewGrant; revision: number; path: string }
interface PdfDisplay { current: PdfRevision; previous: PdfRevision | null }

export function Frame(props: LiveFrameProps) {
	// Main streams each checked live revision from an immutable private file, without a whole-file IPC copy.
	const { frame, error } = usePreviewGrant(props);
	const [display, setDisplay] = useState<PdfDisplay | null>(null);
	const current = useRef<PdfDisplay | null>(null);
	const [failed, setFailed] = useState(false);
	const path = props.subject.path;
	useEffect(() => {
		if (!frame?.pdf || !path || current.current?.current.grant.token === frame.pdf.token) return;
		const prior = current.current;
		if (prior?.previous) void window.vomp.invoke("preview:revoke", prior.previous.grant.token).catch(() => {});
		const next = { current: { grant: frame.pdf, revision: frame.revision, path }, previous: prior?.current ?? null };
		current.current = next;
		setDisplay(next);
		setFailed(false);
	}, [frame, path]);
	return <div className="flex min-h-0 flex-1 flex-col" onErrorCapture={() => {
		const shown = current.current;
		if (!shown) return;
		void window.vomp.invoke("preview:revoke", shown.current.grant.token).catch(() => {});
		const restored = shown.previous ? { current: shown.previous, previous: null } : null;
		current.current = restored;
		setDisplay(restored);
		setFailed(true);
	}}>
		{display && <PdfFrame key={display.current.grant.token} path={display.current.path} revision={display.current.revision} sourceUrl={`${display.current.grant.url}?rev=${display.current.revision}`} name={display.current.path.split(/[\\/]/).pop() ?? display.current.path} />}
		{(error || failed) && <WaitingForSave />}
	</div>;
}

export const adapter: LiveAdapter = { format: "pdf", maxFps: 4, Frame };
