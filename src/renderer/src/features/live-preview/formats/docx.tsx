import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderAsync } from "docx-preview";
import DocxWorker from "./docx.worker?worker";
import { OfficeWorkerClient } from "./office-worker-client";
import { sanitizeOfficeDom } from "./office-sanitize";
import { usePreviewGrant } from "./usePreviewGrant";
import { WaitingForSave } from "./shared";
import type { LiveAdapter, LiveFrameProps } from "../types";

/** Scale the rendered page, including its margins and contents, without reflowing it. */
function fitDocumentPages(host: HTMLDivElement): void {
	const style = getComputedStyle(host);
	const width = host.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
	if (width <= 0) return;
	for (const page of host.shadowRoot?.querySelectorAll<HTMLElement>("section.docx") ?? []) {
		const slot = page.parentElement;
		if (!slot || page.offsetWidth <= 0) continue;
		const scale = Math.min(1, width / page.offsetWidth);
		slot.style.width = `${page.offsetWidth * scale}px`;
		slot.style.height = `${page.offsetHeight * scale}px`;
		page.style.transform = `scale(${scale})`;
	}
}

/** Both fresh and retained presentations have passed the sanitizer before this attachment. */
function attachDocument(host: HTMLDivElement, body: HTMLDivElement, styles: HTMLDivElement): void {
	const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
	const layout = document.createElement("style");
	layout.textContent = ":host{display:block;min-width:0}.docx-pages{display:flex;flex-direction:column;align-items:center;gap:1rem}.docx-page{position:relative;flex:none;overflow:hidden}section.docx{position:absolute;top:0;left:0;transform-origin:top left;box-sizing:border-box;margin:0;background:var(--sheet);font-size:12pt;line-height:normal}a{cursor:pointer}";
	body.className = "docx-pages";
	for (const page of body.querySelectorAll("section.docx")) {
		const slot = document.createElement("div");
		slot.className = "docx-page";
		page.replaceWith(slot);
		slot.append(page);
	}
	shadow.replaceChildren(styles, layout, body);
	fitDocumentPages(host);
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
		const element = host.current;
		if (!element) return;
		const observer = new ResizeObserver(() => {
			fitDocumentPages(element);
			if (element.shadowRoot?.querySelector("section.docx")) props.onHeight?.(element.offsetHeight);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [props.subject.path, props.subject.format, props.onHeight]);
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
						ignoreLastRenderedPageBreak: true, ignoreWidth: false, ignoreHeight: false, inWrapper: false });
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
	return <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-inset [scrollbar-gutter:stable]">
		<div key={`${props.subject.format}:${props.subject.path}`} ref={host} data-theme="light" className="min-w-0 p-4 text-fg" />
		{(error || failure === "incomplete" || failure === "missing") && <WaitingForSave />}
		{failure && failure !== "incomplete" && failure !== "missing" && <p role="status" className="p-3 text-sm text-fg-muted">{t(failure === "timeout" ? "live.office.timeout" : "live.office.unsafe")}{failure === "timeout" && goodRevision.current !== null && <> {t("live.office.retained")}</>}</p>}
	</div>;
}

export const adapter: LiveAdapter = { format: "docx", maxFps: 2, Frame };
