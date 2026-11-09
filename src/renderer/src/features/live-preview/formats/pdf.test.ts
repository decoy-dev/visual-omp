// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../panes/media", () => ({ PdfFrame: ({ sourceUrl }: { sourceUrl: string }) => createElement("iframe", { src: sourceUrl }) }));
vi.mock("./shared", () => ({ WaitingForSave: () => createElement("p", null, "Waiting for save") }));
import { Frame } from "./pdf";
let host: HTMLDivElement, root: Root, denied: boolean;
const invoke = vi.fn();
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.useFakeTimers(); denied = false;
	invoke.mockReset().mockImplementation(async (channel: string, _token: unknown, revision?: number) => channel === "preview:grant" ? { token: "pdf", url: "vomp-preview://pdf/large.pdf", assetRoot: false } : channel === "preview:prepare" ? denied ? { ok: false, reason: "missing" } : { ok: true, pdf: { token: `revision${revision}`, url: `vomp-preview://revision${revision}/large.pdf`, assetRoot: false } } : undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	host = document.createElement("div"); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
async function show(revision: number) {
	const props = { subject: { path: "/project/large.pdf", kind: "file", format: "pdf", state: "saved", text: null, elided: false, revision }, projectPath: "/project", related: [] } as unknown as Parameters<typeof Frame>[0];
	await act(async () => root.render(createElement(Frame, props)));
	await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
it("checks live PDF completion over its grant and retains the last frame after an incomplete save", async () => {
	await show(1);
	expect(invoke).toHaveBeenCalledWith("preview:grant", { path: "/project/large.pdf", root: "/project", related: [], fileOnly: true });
	expect(invoke).toHaveBeenCalledWith("preview:prepare", "pdf", 1, true);
	expect(host.querySelector("iframe")?.getAttribute("src")).toBe("vomp-preview://revision1/large.pdf?rev=1");
	denied = true; await show(2);
	expect(host.querySelector("iframe")?.getAttribute("src")).toBe("vomp-preview://revision1/large.pdf?rev=1");
	expect(host.textContent).toContain("Waiting for save");
	denied = false; await show(3);
	expect(host.querySelector("iframe")?.getAttribute("src")).toBe("vomp-preview://revision3/large.pdf?rev=3");
	expect(invoke.mock.calls.some(call => call[0] === "panes:readPdf")).toBe(false);
});

it("restores the preceding immutable revision on viewer error and releases failed and obsolete snapshots", async () => {
	await show(1); await show(2); await show(3);
	expect(invoke).toHaveBeenCalledWith("preview:revoke", "revision1");
	await act(async () => host.querySelector("iframe")!.dispatchEvent(new Event("error")));
	expect(host.querySelector("iframe")?.getAttribute("src")).toBe("vomp-preview://revision2/large.pdf?rev=2");
	expect(invoke).toHaveBeenCalledWith("preview:revoke", "revision3");
	expect(host.textContent).toContain("Waiting for save");
	denied = true; await show(4);
	expect(host.querySelector("iframe")?.getAttribute("src")).toBe("vomp-preview://revision2/large.pdf?rev=2");
});

it("revokes a prepared child revision that arrives after its render request was superseded", async () => {
	const pending = Promise.withResolvers<{ ok: true; pdf: { token: string; url: string; assetRoot: boolean } }>();
	invoke.mockImplementation(async (channel: string, _token: unknown, revision?: number) => channel === "preview:grant"
		? { token: "pdf", url: "vomp-preview://pdf/large.pdf", assetRoot: false }
		: channel === "preview:prepare" ? revision === 1 ? pending.promise : { ok: true, pdf: { token: "new", url: "vomp-preview://new/revision.pdf", assetRoot: false } } : undefined);
	await show(1); await show(2);
	await act(async () => pending.resolve({ ok: true, pdf: { token: "late", url: "vomp-preview://late/revision.pdf", assetRoot: false } }));
	expect(invoke).toHaveBeenCalledWith("preview:revoke", "late");
	expect(host.querySelector("iframe")?.src).toContain("vomp-preview://new/");
});
