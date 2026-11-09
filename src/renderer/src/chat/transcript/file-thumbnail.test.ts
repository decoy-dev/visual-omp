// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fillThumbnails } from "./fileLinkMarkup";
const invoke = vi.fn();
let callback: (entries: { target: Element; isIntersecting: boolean }[]) => void;
let host: HTMLDivElement;
let close: (() => void) | null;
const decode = Promise.withResolvers<void>();
beforeEach(() => {
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	invoke.mockReset().mockImplementation(async (channel: string) => channel === "preview:grant" ? { token: "thumbnail", url: "vomp-preview://thumbnail/image.svg", assetRoot: false } : undefined);
	vi.stubGlobal("IntersectionObserver", class {
		constructor(value: typeof callback) { callback = value; }
		observe() {} unobserve() {} disconnect() {}
	});
	vi.stubGlobal("Image", class { src = ""; crossOrigin = ""; decode() { return decode.promise; } });
	host = document.createElement("div"); document.body.append(host);
	close = null;
});
afterEach(() => { close?.(); host.remove(); vi.unstubAllGlobals(); });
function start(path: string) {
	host.innerHTML = `<span class="tr-file-tile" data-thumb="${path}"></span>`;
	close = fillThumbnails(host);
	callback([{ target: host.firstElementChild!, isIntersecting: true }]);
}
async function flush() { for (let tick = 0; tick < 6; tick++) await Promise.resolve(); }
it("revokes an in-flight SVG thumbnail when its transcript closes", async () => {
	start("/project/pending.svg"); await flush();
	close!(); close = null;
	expect(invoke).toHaveBeenCalledWith("preview:revoke", "thumbnail");
});
it("revokes an SVG grant that arrives after its transcript closed", async () => {
	const pending = Promise.withResolvers<{ token: string; url: string; assetRoot: boolean }>();
	invoke.mockImplementation((channel: string) => channel === "preview:grant" ? pending.promise : Promise.resolve());
	start("/project/late.svg");
	close!(); close = null;
	pending.resolve({ token: "late", url: "vomp-preview://late/image.svg", assetRoot: false });
	await flush();
	expect(invoke).toHaveBeenCalledWith("preview:revoke", "late");
});
