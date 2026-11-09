import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { figurePalette } from "../../../ui/diagram-source";
import type { LiveFrameProps, LiveSubject } from "../types";
import { FIT_MARGIN } from "../../panes/zoom";

export function SizeNote() {
	const { t } = useTranslation("panes");
	return <p className="p-4 text-sm text-fg-muted" role="status">{t("live.elided")}</p>;
}

export function WaitingForSave({ tooLarge = false }: { tooLarge?: boolean }) {
	const { t } = useTranslation("panes");
	return <p className="p-2 text-sm text-fg-muted" role="status">{t(tooLarge ? "live.sourceTooLarge" : "live.waitingForSave")}</p>;
}

/** Report natural text height without making the scrolling viewport size its own contents. */
export function useContentHeight(onHeight: LiveFrameProps["onHeight"]) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || !onHeight) return;
		const measure = () => {
			const style = getComputedStyle(element.parentElement!);
			onHeight(Math.ceil(element.getBoundingClientRect().height + parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0")));
		};
		measure();
		const observer = new ResizeObserver(measure); observer.observe(element);
		return () => observer.disconnect();
	}, [onHeight]);
	return ref;
}

/** Width-fitted image height stays independent of the stage's current height cap. */
export function usePictureHeight(ref: RefObject<HTMLDivElement | null>, onHeight: LiveFrameProps["onHeight"], vector = false, minimum = 0) {
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || !onHeight) return;
		const measure = () => {
			const images = element.querySelectorAll("img");
			if (!images.length || Array.from(images).some(image => !image.naturalWidth || !image.naturalHeight)) return;
			const style = getComputedStyle(element);
			const horizontal = vector ? parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0") : FIT_MARGIN * 2;
			const vertical = vector ? parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0") : FIT_MARGIN * 2;
			let height = 0;
			for (const image of images) height += Math.max(minimum, image.naturalHeight * Math.min(vector ? Infinity : 1, Math.max(1, element.clientWidth - horizontal) / image.naturalWidth) + vertical);
			onHeight(Math.ceil(height));
		};
		measure();
		const observer = new ResizeObserver(measure); observer.observe(element);
		element.addEventListener("load", measure, true);
		return () => { observer.disconnect(); element.removeEventListener("load", measure, true); };
	}, [ref, onHeight, vector, minimum]);
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
export function useSourceText(subject: LiveSubject): { text: string | null; error: boolean; tooLarge: boolean } {
	const [file, setFile] = useState<{ path: string; text: string } | null>(null);
	const [error, setError] = useState(false);
	const [tooLarge, setTooLarge] = useState(false);
	const path = subject.path;
	const revision = subject.revision;
	const fromFile = subject.kind === "file";
	useEffect(() => {
		if (!fromFile || !path) return;
		let live = true;
		void window.vomp.invoke("panes:readFile", path).then(value => {
			if (!live) return;
			if (value.kind === "text") { setFile({ path, text: value.text }); setError(false); setTooLarge(false); }
			else { setError(true); setTooLarge(value.kind === "tooLarge"); }
		}).catch(() => { if (live) { setError(true); setTooLarge(false); } });
		return () => { live = false; };
	}, [fromFile, path, revision]);
	return { text: fromFile ? file?.path === path ? file.text : null : subject.text, error, tooLarge };
}
