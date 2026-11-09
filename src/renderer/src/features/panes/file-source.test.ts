// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { grantFileSource, isSvgSource, useFileSource } from "./file-source";

const invoke = vi.fn();
let host: HTMLDivElement, root: Root;
function View({ path, revision = 0 }: { path: string; revision?: number }) {
	const { src, error } = useFileSource(path, revision);
	return createElement("span", null, error ? "failed" : src);
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	host = document.createElement("div"); root = createRoot(host);
	invoke.mockReset().mockImplementation(async (channel: string, request: { path: string }) => channel === "preview:grant" ? { token: request.path, url: `vomp-preview://token/${request.path}`, assetRoot: false } : channel === "preview:prepare" ? { ok: true } : undefined);
});
afterEach(async () => { await act(async () => root.unmount()); });
it("grants exactly one file and revokes it when replaced or closed", async () => {
	await act(async () => root.render(createElement(View, { path: "/a.mp4" })));
	expect(invoke).toHaveBeenCalledWith("preview:grant", { path: "/a.mp4", root: null, related: [], fileOnly: true });
	await act(async () => root.render(createElement(View, { path: "/b.mp4" })));
	expect(invoke).toHaveBeenCalledWith("preview:revoke", "/a.mp4");
	expect(host.textContent).toContain("/b.mp4");
	await act(async () => root.render(null));
	expect(invoke).toHaveBeenCalledWith("preview:revoke", "/b.mp4");
});
it("revokes a grant that resolves after its view closes", async () => {
	const pending = Promise.withResolvers<{ token: string; url: string; assetRoot: boolean }>();
	invoke.mockImplementation((channel: string) => channel === "preview:grant" ? pending.promise : Promise.resolve());
	await act(async () => root.render(createElement(View, { path: "/late.png" })));
	await act(async () => root.render(null));
	await act(async () => pending.resolve({ token: "late", url: "vomp-preview://late/image.png", assetRoot: false }));
	expect(invoke).toHaveBeenCalledWith("preview:revoke", "late");
});
it("renews the grant on reload and exposes a failed grant", async () => {
	await act(async () => root.render(createElement(View, { path: "/a.pdf" })));
	invoke.mockImplementation(async (channel: string) => { if (channel === "preview:grant") throw new Error("missing"); });
	await act(async () => root.render(createElement(View, { path: "/a.pdf", revision: 1 })));
	expect(invoke).toHaveBeenCalledWith("preview:revoke", "/a.pdf");
	expect(host.textContent).toBe("failed");
});

it("keeps vector fitting for grant URLs and adds the PDF navigation revision", async () => {
	expect(isSvgSource("vomp-preview://token/SLIDE.SVG?rev=2")).toBe(true);
	expect(isSvgSource("vomp-preview://token/image.png?file=x.svg")).toBe(false);
	const pdf = await grantFileSource("/large.pdf", 3);
	expect(pdf.src).toContain("?rev=3");
	expect(invoke).toHaveBeenCalledWith("preview:prepare", "/large.pdf", 3);
	pdf.release();
});
