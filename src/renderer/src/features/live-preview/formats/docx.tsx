import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderAsync } from "docx-preview";
import DocxWorker from "./docx.worker?worker";
import { OfficeWorkerClient } from "./office-worker-client";
import { sanitizeOfficeDom } from "./office-sanitize";
import { usePreviewGrant } from "./usePreviewGrant";
import { WaitingForSave } from "./shared";
import type { LiveAdapter, LiveFrameProps } from "../types";

/** Both fresh and retained presentations have passed the sanitizer before this attachment. */
function attachDocument(host: HTMLDivElement, body: HTMLDivElement, styles: HTMLDivElement): void {
	const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
	const layout = document.createElement("style");
	layout.textContent = ":host{display:block;min-width:0}section{box-sizing:border-box;max-width:100%!important;padding:1rem!important;overflow-wrap:anywhere}img,table{max-width:100%}div:has(>img){max-width:100%!important;height:auto!important}img{height:auto!important}table{width:100%!important;table-layout:fixed}col,td,th{width:auto!important}td,th{overflow-wrap:anywhere}a{cursor:pointer}";
	shadow.replaceChildren(styles, layout, body);
	body.addEventListener("click", event => {
		const link = event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
		if (!link) return;
		event.preventDefault(); event.stopPropagation();
		const href = link.getAttribute("href") ?? "";
		if (/^https?:/i.test(href)) void window.vomp.invoke("app:openExternal", href);
		else if (href.startsWith("#")) shadow.getElementById(href.slice(1))?.scrollIntoView({ block: "nearest" });
	});
}

export function Frame(props: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const { frame, error } = usePreviewGrant(props);
	const host = useRef<HTMLDivElement>(null);
	const renders = useRef<Promise<void>>(Promise.resolve());
	const goodRevision = useRef<number | null>(null);
	const requestedRevision = useRef(props.subject.revision);
	requestedRevision.current = props.subject.revision;
	const source = useRef<{ token: string; path: string | null }>({ token: "", path: null });
	if (frame && source.current.token !== frame.grant.token) source.current = { token: frame.grant.token, path: props.subject.path };
	const [failure, setFailure] = useState<string | null>(null);
	useEffect(() => {
		host.current?.shadowRoot?.replaceChildren(); goodRevision.current = null;
		if (error) { props.officeCache?.clear(); props.onOfficeCheck?.(null); }
	}, [props.subject.path, props.subject.format, error]);
	useEffect(() => {
		if (goodRevision.current !== null && goodRevision.current > props.subject.revision) {
			host.current?.shadowRoot?.replaceChildren(); goodRevision.current = null;
		}
	}, [props.subject.revision]);
	useEffect(() => {
		if (!frame || error || !props.subject.path || source.current.path !== props.subject.path) return;
		const path = props.subject.path;
		let current = true;
		let client: OfficeWorkerClient | null = null;
		const run = async () => {
			try {
				const binary = await window.vomp.invoke("preview:readBinary", frame.grant.token);
				if (!current) return;
				if (!binary.ok) {
					if (binary.reason !== "incomplete") {
						props.officeCache?.clear(); host.current?.shadowRoot?.replaceChildren(); goodRevision.current = null;
					} else if (binary.reason === "incomplete" && goodRevision.current === null) {
						const cached = props.officeCache?.read();
						if (cached?.format === "docx" && cached.path === path && cached.revision <= frame.revision && host.current) {
							const body = document.createElement("div"), styles = document.createElement("div");
							body.innerHTML = cached.body; styles.innerHTML = cached.styles;
							sanitizeOfficeDom(body, styles);
							attachDocument(host.current, body, styles); goodRevision.current = cached.revision;
						}
					}
					if (binary.reason === "unsafe" || binary.reason === "tooLarge") props.onOfficeCheck?.(false);
					else props.onOfficeCheck?.(goodRevision.current !== null ? true : null);
					setFailure(binary.reason); return;
				}
				client = new OfficeWorkerClient(new DocxWorker());
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
					if (!current || !host.current || frame.revision > requestedRevision.current) return;
					const snapshot = { format: "docx" as const, path, revision: frame.revision, body: body.innerHTML, styles: styles.innerHTML };
					attachDocument(host.current, body, styles); goodRevision.current = frame.revision;
					props.officeCache?.write(snapshot); setFailure(null);
					props.onOfficeCheck?.(true);
				};
				const rendering = render();
				renders.current = rendering.catch(() => {});
				await rendering;
			} catch (cause) {
				if (current) {
					const reason = cause instanceof Error ? cause.message : "unsafe";
					setFailure(reason);
					props.onOfficeCheck?.(reason === "unsafe" || reason === "tooLarge" ? false : null);
				}
			}
			finally { client?.dispose(); }
		};
		void run();
		return () => { current = false; client?.dispose(); };
	}, [frame, props.subject.path, props.subject.format, error]);
	return <div className="min-w-0 flex-1 overflow-auto">
		<div key={`${props.subject.format}:${props.subject.path}`} ref={host} data-theme="light" className="min-w-0 bg-sheet text-fg" />
		{(error || failure === "incomplete" || failure === "missing") && <WaitingForSave />}
		{failure && failure !== "incomplete" && failure !== "missing" && <p role="status" className="p-3 text-sm text-fg-muted">{t(failure === "timeout" ? "live.office.timeout" : "live.office.unsafe")}{failure === "timeout" && goodRevision.current !== null && <> {t("live.office.retained")}</>}</p>}
	</div>;
}

export const adapter: LiveAdapter = { format: "docx", maxFps: 2, Frame };
