// This integration case intentionally uses the fixture's one-second platform-clock cadence and unmocked JSZip scheduling.
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAsync } from "docx-preview";
import { zipSync, strToU8 } from "fflate";
import { rewriteOfficePackage } from "@shared/preview-office-package";
import { sanitizeOfficeDom } from "./office-sanitize";
import { Frame } from "./docx";
import { useLivePreview } from "../store";
import type { LiveSubject, OfficeFrameSnapshot } from "../types";

// happy-dom keeps the prefix in XML Attr.localName, unlike Chromium. docx-preview reads that DOM field.
class NamespaceDOMParser extends DOMParser {
	override parseFromString(...args: Parameters<DOMParser["parseFromString"]>) {
		const document = super.parseFromString(...args);
		for (const element of document.getElementsByTagName("*")) for (const attribute of element.attributes) {
			if (attribute.name.includes(":")) Object.defineProperty(attribute, "localName", { value: attribute.name.split(":").at(-1) });
		}
		return document;
	}
}

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./docx.worker?worker", () => ({ default: class {
	onmessage: ((event: MessageEvent) => void) | null = null;
	closed = false;
	postMessage(message: { id: number; bytes: Uint8Array }, transfer: Transferable[]) {
		const received = structuredClone(message, { transfer });
		queueMicrotask(() => {
			if (this.closed) return;
			const result = rewriteOfficePackage(received.bytes, "docx");
			this.onmessage?.({ data: { id: received.id, ok: true, ...result } } as MessageEvent);
		});
	}
	terminate() { this.closed = true; }
} }));

function fixture(revision: number, page = { width: 12240, height: 15840 }) {
	const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main", rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
	const files = {
		"[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		"_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml": `<w:document xmlns:w="${word}"><w:body><w:p><w:r><w:t>Office fixture revision ${revision}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="${page.width}" w:h="${page.height}"/><w:pgMar w:top="720" w:right="1440" w:bottom="720" w:left="1440"/></w:sectPr></w:body></w:document>`,
	};
	return zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)]))) as Uint8Array<ArrayBuffer>;
}
function subject(revision: number): LiveSubject {
	return { id: "office", kind: "file", format: "docx", path: "/project/office.docx", text: null, revision, state: "running", toolCallId: null, toolName: null, elided: false, intent: null, request: null, images: null, progress: null, sequence: null, size: 100, startedAt: 1, updatedAt: revision };
}
let host: HTMLDivElement, root: Root;
let currentRevision = 1;
let currentPage = { width: 12240, height: 15840 };
let denial: "revoked" | "notFile" | "missing" | null = null;
const cache = { read: () => useLivePreview.getState().readOffice("chat", "office", "/project/office.docx", "docx", currentRevision),
	write: (snapshot: OfficeFrameSnapshot) => useLivePreview.getState().retainOffice("chat", "office", snapshot),
	clear: () => useLivePreview.getState().discardOffice("chat", "office", "/project/office.docx", "docx") };
async function show(revision: number) {
	currentRevision = revision;
	useLivePreview.getState().update("chat", [subject(revision)], []);
	await act(async () => root.render(createElement(Frame, { subject: subject(revision), projectPath: "/project", related: [], officeCache: cache })));
}
async function until(predicate: () => boolean) {
	const end = Date.now() + 3000;
	while (!predicate() && Date.now() < end) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
	expect(predicate()).toBe(true);
}
const shadowText = () => host.querySelector('[data-theme="light"]')?.shadowRoot?.textContent ?? "";
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("DOMParser", NamespaceDOMParser);
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	useLivePreview.setState({ chats: {} });
	currentPage = { width: 12240, height: 15840 };
	denial = null;
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke: vi.fn(async (channel: string) => {
		if (channel === "preview:grant") return { token: "token", url: "vomp-preview://token/office.docx", assetRoot: true };
		if (channel === "preview:readBinary") return denial ? { ok: false, reason: denial } : currentRevision === 4 || currentRevision === 6 ? { ok: false, reason: "incomplete" } : { ok: true, bytes: fixture(currentRevision, currentPage), size: 100, mtimeMs: currentRevision };
	}) } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useLivePreview.setState({ chats: {} }); vi.unstubAllGlobals(); });

describe("real DOCX package rendering", () => {
	it("renders the canonicalized package through docx-preview and the sanitizer", async () => {
		const clean = rewriteOfficePackage(fixture(3), "docx");
		const body = document.createElement("div"), styles = document.createElement("div");
		await renderAsync(clean.bytes, body, styles, { useBase64URL: true, renderAltChunks: false, experimental: false, ignoreLastRenderedPageBreak: true, ignoreWidth: false, ignoreHeight: false, inWrapper: false });
		sanitizeOfficeDom(body, styles, clean.links);
		expect(body.textContent).toContain("Office fixture revision 3");
	});
	it.each([
		{ name: "Letter", width: 12240, height: 15840 },
		{ name: "A4", width: 11906, height: 16838 },
	])("preserves $name page dimensions and margins through the adapter", async page => {
		currentPage = page;
		await show(1); await until(() => shadowText().includes("Office fixture revision 1"));
		const rendered = host.querySelector('[data-theme="light"]')!.shadowRoot!.querySelector<HTMLElement>("section.docx")!;
		expect(parseFloat(rendered.style.width), rendered.outerHTML).toBe(page.width / 20);
		expect(parseFloat(rendered.style.minHeight)).toBe(page.height / 20);
		expect(parseFloat(rendered.style.paddingLeft)).toBe(72);
		expect(parseFloat(rendered.style.paddingTop)).toBe(36);
	});
	it("retains the real rendered third revision after truncation and after remounting the subject", async () => {
		for (const revision of [1, 2, 3]) {
			await show(revision); await until(() => shadowText().includes(`Office fixture revision ${revision}`));
			if (revision < 3) await act(async () => { await new Promise(resolve => setTimeout(resolve, 1000)); });
		}
		await show(4); await until(() => host.textContent?.includes("live.waitingForSave") === true);
		expect(shadowText()).toContain("Office fixture revision 3");
		expect(cache.read()?.format).toBe("docx");
		expect(cache.read()).not.toHaveProperty("bytes");
		await act(async () => root.unmount()); root = createRoot(host);
		await show(4); await until(() => shadowText().includes("Office fixture revision 3"));
		expect(host.textContent).toContain("live.waitingForSave");
		await show(5); await until(() => shadowText().includes("Office fixture revision 5"));
		await act(async () => root.unmount()); root = createRoot(host);
		await show(6); await until(() => shadowText().includes("Office fixture revision 5"));
		expect(host.textContent).toContain("live.waitingForSave");
	}, 10000);
});

it.each(["revoked", "notFile", "missing"] as const)("clears mounted and reselected DOCX presentation after %s", async reason => {
	await show(1); await until(() => shadowText().includes("Office fixture revision 1"));
	denial = reason; await show(2);
	await until(() => shadowText() === "" && useLivePreview.getState().chats.chat?.officeFrames.office === undefined);
	denial = null; await show(3); await until(() => shadowText().includes("Office fixture revision 3"));
	await act(async () => root.unmount()); root = createRoot(host);
	expect(useLivePreview.getState().chats.chat?.officeFrames.office).toBeDefined();
	denial = reason; await show(4);
	await until(() => useLivePreview.getState().chats.chat?.officeFrames.office === undefined);
	expect(shadowText()).toBe("");
});
