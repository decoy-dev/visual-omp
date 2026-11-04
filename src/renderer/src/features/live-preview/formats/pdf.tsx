import { useEffect, useRef, useState } from "react";
import { PdfFrame } from "../../panes/media";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { WaitingForSave } from "./shared";

interface PdfRevision { path: string; revision: number; bytes: Uint8Array<ArrayBuffer> }

export function Frame({ subject }: LiveFrameProps) {
	const [good, setGood] = useState<PdfRevision | null>(null);
	const previous = useRef<PdfRevision | null>(null);
	const [failed, setFailed] = useState(false);
	const path = subject.path;
	const revision = subject.revision;
	useEffect(() => {
		if (!path) return;
		let live = true;
		void window.vomp.invoke("panes:readPdf", path).then(bytes => {
			if (!live) return;
			// A save may have its header before it has its cross-reference trailer.
			const header = new TextDecoder().decode(bytes.subarray(0, 8));
			const tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
			if (!header.startsWith("%PDF-") || !/%%EOF\s*$/.test(tail)) { setFailed(true); return; }
			setGood(current => {
				previous.current = current;
				return { path, revision, bytes };
			});
			setFailed(false);
		}).catch(() => { if (live) setFailed(true); });
		return () => { live = false; };
	}, [path, revision]);
	return <div className="flex min-h-0 flex-1 flex-col" onErrorCapture={() => {
		setFailed(true);
		setGood(previous.current);
		previous.current = null;
	}}>
		{good && <PdfFrame key={good.revision} path={good.path} revision={good.revision} bytes={good.bytes} name={good.path.split(/[\\/]/).pop() ?? good.path} />}
		{failed && <WaitingForSave />}
	</div>;
}

export const adapter: LiveAdapter = { format: "pdf", maxFps: 4, Frame };
