// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "./docx";
import type { LiveSubject, OfficeFrameCache } from "../types";
import copy from "../../../i18n/en/panes.json";

const state = vi.hoisted(() => ({ frame: { grant: { token: "token", url: "vomp-preview://token/office.docx", assetRoot: true }, revision: 1 }, workers: [] as { terminate: ReturnType<typeof vi.fn> }[] }));
vi.mock("./usePreviewGrant", () => ({ usePreviewGrant: () => ({ frame: state.frame, error: false }) }));
vi.mock("./docx.worker?worker", () => ({ default: class {
	onmessage: ((event: MessageEvent) => void) | null = null;
	terminate = vi.fn();
	constructor() { state.workers.push(this); }
	postMessage(message: { id: number; bytes: Uint8Array }) { queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, bytes: message.bytes, links: {} } } as MessageEvent)); }
} }));
vi.mock("docx-preview", () => ({ renderAsync: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => {
	let value: unknown = copy; for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part]; return String(value ?? key);
} }) }));
import { renderAsync } from "docx-preview";
let host: HTMLDivElement, root: Root;
const invoke = vi.fn();
const subject = { id: "doc", kind: "file", format: "docx", path: "/project/office.docx", revision: 1, state: "saved" } as LiveSubject;
async function show(revision: number, officeCache?: OfficeFrameCache) {
	state.frame = { ...state.frame, revision };
	await act(async () => root.render(createElement(Frame, { subject: { ...subject, revision }, projectPath: "/project", related: [], officeCache })));
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	host = document.createElement("div"); root = createRoot(host); state.workers.length = 0;
	invoke.mockReset().mockImplementation(async () => ({ ok: true, bytes: new Uint8Array([state.frame.revision]), size: 1, mtimeMs: 1 }));
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	vi.mocked(renderAsync).mockReset().mockImplementation(async (bytes, body, styles) => {
		body.innerHTML = `<section><p>Revision ${(bytes as Uint8Array)[0]}</p><a href="https://example.test">Website</a><img src="https://bad.test/image" onerror="bad()"><script>bad()</script></section>`;
		styles!.innerHTML = '<style>p{background:url(https://bad.test)}</style>';
	});
});
afterEach(async () => { await act(async () => root.unmount()); });

describe("DOCX frame lifecycle", () => {
	it("renders three saves and retains the previous frame for an incomplete save", async () => {
		for (const revision of [1, 2, 3]) { await show(revision); expect(host.firstElementChild?.firstElementChild?.shadowRoot?.textContent).toContain(`Revision ${revision}`); }
		invoke.mockResolvedValueOnce({ ok: false, reason: "incomplete" });
		await show(4);
		expect(host.firstElementChild?.firstElementChild?.shadowRoot?.textContent).toContain("Revision 3");
		expect(host.textContent).toContain("Waiting for omp to finish saving");
		expect(renderAsync).toHaveBeenCalledTimes(3);
	});
	it("sanitizes before attaching and intercepts links through the app handler", async () => {
		await show(1);
		const shadow = host.firstElementChild?.firstElementChild?.shadowRoot!;
		expect(shadow.querySelector("script")).toBeNull(); expect(shadow.querySelector("img")?.hasAttribute("src")).toBe(false);
		expect(shadow.querySelector("style")?.textContent).not.toContain("https://bad.test");
		await act(async () => shadow.querySelector("a")!.click());
		expect(invoke).toHaveBeenCalledWith("app:openExternal", "https://example.test");
		expect(renderAsync).toHaveBeenCalledWith(expect.any(Uint8Array), expect.any(HTMLElement), expect.any(HTMLElement), expect.objectContaining({ useBase64URL: true, renderAltChunks: false, experimental: false, ignoreLastRenderedPageBreak: true }));
	});
	it("serializes non-abortable renders and never attaches a stale revision", async () => {
		const gate = Promise.withResolvers<void>();
		vi.mocked(renderAsync).mockImplementationOnce(async (_bytes, body) => { await gate.promise; body.textContent = "Stale revision"; });
		await show(1); await show(2); await show(3);
		expect(renderAsync).toHaveBeenCalledOnce();
		await act(async () => gate.resolve());
		expect(renderAsync).toHaveBeenCalledTimes(2);
		expect(host.firstElementChild?.firstElementChild?.shadowRoot?.textContent).toContain("Revision 3");
		expect(host.firstElementChild?.firstElementChild?.shadowRoot?.textContent).not.toContain("Stale");
		expect(state.workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
	});
});

it("stores sanitized DOCX presentation rather than the source package", async () => {
	const officeCache: OfficeFrameCache = { read: () => null, write: vi.fn(), clear: vi.fn() };
	await show(1, officeCache);
	const value = vi.mocked(officeCache.write).mock.calls[0]![0];
	expect(value).not.toHaveProperty("bytes");
	expect(value.format).toBe("docx");
	if (value.format === "docx") {
		expect(value.body).toContain("Revision 1");
		expect(value.body).not.toMatch(/script|onerror/);
		expect(value.body).not.toContain("https://bad.test");
		expect(value.styles).not.toContain("https://bad.test");
	}
});

it.each([{ path: "/project/other.docx", revision: 1 }, { path: "/project/office.docx", revision: 2 }])("refuses a retained DOCX with mismatched identity or future revision: %j", async identity => {
	invoke.mockResolvedValueOnce({ ok: false, reason: "incomplete" });
	const officeCache: OfficeFrameCache = { read: () => ({ ...identity, format: "docx", body: "<p>Forbidden presentation</p>", styles: "" }), write: vi.fn(), clear: vi.fn() };
	await show(1, officeCache);
	expect(host.firstElementChild?.firstElementChild?.shadowRoot).toBeNull();
	expect(host.textContent).not.toContain("Forbidden presentation");
});

it("restores sanitized document markup and preserves intercepted links", async () => {
	invoke.mockResolvedValueOnce({ ok: false, reason: "incomplete" });
	const officeCache: OfficeFrameCache = { read: () => ({ format: "docx", path: "/project/office.docx", revision: 1,
		body: '<section><p>Retained text</p><img src="data:image/png;base64,YQ=="><a href="https://example.test/retained">Retained link</a></section>', styles: "<style>p{font-size:12pt}</style>" }), write: vi.fn(), clear: vi.fn() };
	await show(1, officeCache);
	const shadow = host.querySelector('[data-theme="light"]')!.shadowRoot!;
	expect(shadow.textContent).toContain("Retained text");
	expect(shadow.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,YQ==");
	await act(async () => shadow.querySelector("a")!.click());
	expect(invoke).toHaveBeenCalledWith("app:openExternal", "https://example.test/retained");
});
