// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "./pptx";
import type { LiveSubject } from "../types";
import copy from "../../../i18n/en/panes.json";

const state = vi.hoisted(() => ({ frame: { grant: { token: "token", url: "vomp-preview://token/office.pptx", assetRoot: true }, revision: 1 } }));
vi.mock("./usePreviewGrant", () => ({ usePreviewGrant: () => ({ frame: state.frame, error: false }) }));
vi.mock("../../panes/media", () => ({ PdfFrame: ({ revision }: { revision: number }) => `PDF revision ${revision}` }));
vi.mock("../../panes/common", () => ({ FileName: ({ name }: { name: string }) => name }));
vi.mock("../../panes/files-store", () => ({ openInFiles: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => {
	let value: unknown = copy; for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part]; return String(value ?? key);
} }) }));
let host: HTMLDivElement, root: Root;
const invoke = vi.fn();
const subject = { id: "slides", kind: "file", format: "pptx", path: "/project/office.pptx", revision: 1, state: "saved" } as LiveSubject;
async function show(revision: number) {
	state.frame = { ...state.frame, revision };
	await act(async () => root.render(createElement(Frame, { subject: { ...subject, revision }, projectPath: "/project", related: [], turnImages: ["/project/slide-1.png"] })));
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	host = document.createElement("div"); root = createRoot(host); invoke.mockReset();
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
});
afterEach(async () => { await act(async () => root.unmount()); });

describe("slide preview states", () => {
	it("explains missing LibreOffice and lists the turn's slide images", async () => {
		invoke.mockResolvedValue({ ok: false, reason: "noLibreOffice" }); await show(1);
		expect(host.textContent).toContain("Slide previews need LibreOffice, which is not installed.");
		expect(host.textContent).toContain("slide-1.png");
	});
	it("never displays an older conversion after a newer one", async () => {
		const old = Promise.withResolvers<{ ok: true; revision: number; pdfPath: string }>();
		invoke.mockImplementation(async (channel: string, _token: string, revision: number) => channel === "panes:readPdf" ? new Uint8Array([1]) : revision === 1 ? old.promise : { ok: true, revision: 2, pdfPath: "/scratch/new.pdf" });
		await show(1); await show(2); expect(host.textContent).toContain("PDF revision 2");
		await act(async () => old.resolve({ ok: true, revision: 1, pdfPath: "/scratch/old.pdf" }));
		expect(host.textContent).toContain("PDF revision 2"); expect(host.textContent).not.toContain("PDF revision 1");
		invoke.mockResolvedValueOnce({ ok: false, reason: "failed" }); await show(3);
		expect(host.textContent).toContain("PDF revision 2"); expect(host.textContent).toContain("Waiting for omp to finish saving");
	});
});

it("mentions retention after a timeout only when a successful preview exists", async () => {
	invoke.mockResolvedValueOnce({ ok: false, reason: "timeout" }); await show(1);
	expect(host.textContent).toContain("This preview took too long.");
	expect(host.textContent).not.toContain("The previous preview is still available.");
	invoke.mockImplementation(async (channel: string) => channel === "panes:readPdf" ? new Uint8Array([1]) : { ok: true, revision: 2, pdfPath: "/scratch/good.pdf" });
	await show(2);
	invoke.mockResolvedValueOnce({ ok: false, reason: "timeout" }); await show(3);
	expect(host.textContent).toContain("The previous preview is still available.");
});
