import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { figurePalette } from "../../../ui/diagram-source";
import type { LiveSubject } from "../types";

export function SizeNote() {
	const { t } = useTranslation("panes");
	return <p className="p-4 text-sm text-fg-muted" role="status">{t("live.elided")}</p>;
}

export function WaitingForSave() {
	const { t } = useTranslation("panes");
	return <p className="p-2 text-sm text-fg-muted" role="status">{t("live.waitingForSave")}</p>;
}

/** Recompute the figure colors on the same theme changes as transcript diagrams. */
export function useFigurePalette() {
	const ref = useRef<HTMLDivElement>(null);
	const [palette, setPalette] = useState<Record<string, string>>({});
	useEffect(() => {
		const update = () => {
			if (ref.current) {
				const next = figurePalette(ref.current);
				setPalette(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
			}
		};
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
		return () => observer.disconnect();
	}, []);
	return { ref, palette };
}

/** The file replaces an elided source once it has been saved. Failed reads leave the last complete text visible. */
export function useSourceText(subject: LiveSubject): { text: string | null; error: boolean } {
	const [file, setFile] = useState<{ path: string; text: string } | null>(null);
	const [error, setError] = useState(false);
	const path = subject.path;
	const revision = subject.revision;
	const fromFile = subject.kind === "file";
	useEffect(() => {
		if (!fromFile || !path) return;
		let live = true;
		void window.vomp.invoke("panes:readFile", path).then(value => {
			if (!live) return;
			if (value.kind === "text") { setFile({ path, text: value.text }); setError(false); }
			else setError(true);
		}).catch(() => { if (live) setError(true); });
		return () => { live = false; };
	}, [fromFile, path, revision]);
	return { text: fromFile ? file?.path === path ? file.text : null : subject.text, error };
}
