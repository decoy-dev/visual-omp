// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../ui", () => ({ cn: (...values: string[]) => values.filter(Boolean).join(" "), Spinner: () => null }));
vi.mock("../../ui/contextActions", () => ({ openWithDefaultApp: vi.fn(), revealLabel: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PreviewImage } from "./media";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	host = document.createElement("div"); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });
it("releases a failed file grant before loading the saved inline fallback", async () => {
	const events: string[] = [];
	const load = async () => ({ src: "vomp-preview://missing/image.png", release: () => { events.push("revoke"); } });
	const fallback = async () => { events.push("fallback"); return "data:image/png;base64,aW1hZ2U="; };
	await act(async () => root.render(createElement(PreviewImage, { sourceKey: "missing", load, fallback, pdf: false, enabled: true, alt: "Saved image" })));
	await act(async () => host.querySelector("img")!.dispatchEvent(new Event("error")));
	expect(events).toEqual(["revoke", "fallback"]);
	expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
});
it("keeps a shared image grant until the last mounted consumer closes", async () => {
	const release = vi.fn();
	const load = vi.fn(async () => ({ src: "vomp-preview://shared/image.png", release }));
	const image = (key: string) => createElement(PreviewImage, { key, sourceKey: "shared", load, pdf: false, enabled: true, alt: key });
	await act(async () => root.render(createElement("div", null, image("first"), image("second"))));
	expect(load).toHaveBeenCalledTimes(1);
	await act(async () => root.render(createElement("div", null, image("second"))));
	expect(release).not.toHaveBeenCalled();
	await act(async () => root.render(null));
	expect(release).toHaveBeenCalledTimes(1);
});
