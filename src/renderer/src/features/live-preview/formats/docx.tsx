import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderAsync } from "docx-preview";
import DocxWorker from "./docx.worker?worker";
import { OfficeWorkerClient } from "./office-worker-client";
import { sanitizeOfficeDom } from "./office-sanitize";
import { usePreviewGrant } from "./usePreviewGrant";
import { WaitingForSave } from "./shared";
import type { LiveAdapter, LiveFrameProps } from "../types";

export function Frame(props: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const { frame, error } = usePreviewGrant(props);
	const host = useRef<HTMLDivElement>(null);
	const renders = useRef<Promise<void>>(Promise.resolve());
	const [failure, setFailure] = useState<string | null>(null);
	useEffect(() => {
		if (!frame) return;
		let current = true;
		const client = new OfficeWorkerClient(new DocxWorker());
		const run = async () => {
			try {
				const binary = await window.vomp.invoke("preview:readBinary", frame.grant.token);
				if (!current) return;
				if (!binary.ok) { setFailure(binary.reason); return; }
				const clean = await client.request<{ bytes: Uint8Array<ArrayBuffer>; links: Record<string, string> }>({ bytes: binary.bytes }, [binary.bytes.buffer]);
				client.dispose();
				// renderAsync cannot abort. Serialize it and skip stale work before starting another render.
				const prior = renders.current;
				const render = async () => {
					await prior;
					if (!current) return;
					const body = document.createElement("div"), styles = document.createElement("div");
					await renderAsync(clean.bytes, body, styles, { useBase64URL: true, renderAltChunks: false, experimental: false,
						ignoreLastRenderedPageBreak: true, ignoreWidth: true, ignoreHeight: true, inWrapper: false });
					sanitizeOfficeDom(body, styles, clean.links);
					if (!current || !host.current) return;
					const shadow = host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" });
					const layout = document.createElement("style");
					layout.textContent = ":host{display:block;min-width:0}section{box-sizing:border-box;max-width:100%!important;padding:1rem!important;overflow-wrap:anywhere}img,table{max-width:100%}img{height:auto}table{table-layout:fixed}td,th{overflow-wrap:anywhere}a{cursor:pointer}";
					shadow.replaceChildren(styles, layout, body);
					body.addEventListener("click", event => {
						const link = event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
						if (!link) return;
						event.preventDefault(); event.stopPropagation();
						const href = link.getAttribute("href") ?? "";
						if (/^https?:/i.test(href)) void window.vomp.invoke("app:openExternal", href);
						else if (href.startsWith("#")) shadow.getElementById(href.slice(1))?.scrollIntoView({ block: "nearest" });
					});
					setFailure(null);
				};
				const rendering = render();
				renders.current = rendering.catch(() => {});
				await rendering;
			} catch (cause) { if (current) setFailure(cause instanceof Error ? cause.message : "unsafe"); }
			finally { client.dispose(); }
		};
		void run();
		return () => { current = false; client.dispose(); };
	}, [frame]);
	return <div className="min-w-0 flex-1 overflow-auto">
		<div ref={host} data-theme="light" className="min-w-0 bg-sheet text-fg" />
		{(error || failure === "incomplete" || failure === "missing") && <WaitingForSave />}
		{failure && failure !== "incomplete" && failure !== "missing" && <p role="status" className="p-3 text-sm text-fg-muted">{t(failure === "timeout" ? "live.office.timeout" : "live.office.unsafe")}{failure === "timeout" && host.current?.shadowRoot && <> {t("live.office.retained")}</>}</p>}
	</div>;
}

export const adapter: LiveAdapter = { format: "docx", maxFps: 2, Frame };
