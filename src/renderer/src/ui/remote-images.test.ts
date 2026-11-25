// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../transcript/render";
import { handleRemoteImage } from "./remote-images";
import { hydrateRichContent } from "./rich-content";

const restoreCallbacks: (() => void)[] = [];
afterEach(() => {
	for (const restore of restoreCallbacks.splice(0)) restore();
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

function stubImageFetch(handler: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string }>) {
	const previous = (window as unknown as { vomp?: unknown }).vomp;
	const invoke = vi.fn(async (channel: string, url: string) => {
		if (channel !== "app:fetchRemoteImage") throw new Error(`unexpected channel ${channel}`);
		return handler(url);
	});
	Object.assign(window, { vomp: { invoke, platform: "darwin" } });
	restoreCallbacks.push(() => {
		if (previous === undefined) delete (window as unknown as { vomp?: unknown }).vomp;
		else Object.assign(window, { vomp: previous });
	});
	return invoke;
}

describe("remote Markdown image consent", () => {
	it("makes no image request until activation, and loads only the chosen image via blob URL", async () => {
		const invoke = stubImageFetch(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }));
		const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/img-1");
		const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const srcs: { image: HTMLImageElement; url: string }[] = [];
		vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function(this: HTMLImageElement, url: string) { srcs.push({ image: this, url }); });
		const root = document.createElement("div");
		root.innerHTML = renderMarkdown("![First](https://images.example/one?private=one)\n\n![Second](https://images.example/two?private=two)");
		document.body.append(root);
		const cleanup = hydrateRichContent(root);
		expect(invoke).not.toHaveBeenCalled();
		expect(root.querySelectorAll("img")).toHaveLength(0);
		const buttons = root.querySelectorAll<HTMLButtonElement>("[data-load-image]");
		buttons[1].click();
		await vi.waitFor(() => expect(srcs).toHaveLength(1));
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith("app:fetchRemoteImage", "https://images.example/two?private=two");
		expect(createUrl).toHaveBeenCalledTimes(1);
		expect(srcs[0].url).toBe("blob:http://localhost/img-1");
		buttons[1].click();
		expect(invoke).toHaveBeenCalledTimes(1);
		srcs[0].image.dispatchEvent(new Event("load"));
		expect(root.querySelector("img")?.alt).toBe("Second");
		expect(root.querySelectorAll("[data-load-image]")).toHaveLength(1);
		cleanup();
		expect(revokeUrl).toHaveBeenCalledWith("blob:http://localhost/img-1");
	});

	it("keeps a failed request retryable without loading another image", async () => {
		const invoke = stubImageFetch(async () => { throw new Error("network error"); });
		const root = document.createElement("div");
		root.innerHTML = renderMarkdown("![Preview](https://images.example/fail)");
		document.body.append(root);
		root.addEventListener("click", event => handleRemoteImage(event, root));
		root.querySelector<HTMLButtonElement>("button")!.click();
		await vi.waitFor(() => expect(root.textContent).toContain("This image could not be loaded."));
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(root.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);

		const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/bad-bytes");
		let requested: HTMLImageElement | undefined;
		vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function(this: HTMLImageElement) { requested = this; });
		invoke.mockResolvedValueOnce({ bytes: new Uint8Array([9]), mimeType: "image/png" });
		root.querySelector<HTMLButtonElement>("button")!.click();
		await vi.waitFor(() => expect(requested).toBeDefined());
		requested!.dispatchEvent(new Event("error"));
		expect(revokeUrl).toHaveBeenCalledWith("blob:http://localhost/bad-bytes");
		expect(root.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
		expect(root.textContent).toContain("This image could not be loaded.");
	});

	it("keeps raw HTML images inert until consent and applies their safe size", async () => {
		stubImageFetch(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }));
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/raw");
		let requested: HTMLImageElement | undefined;
		vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function(this: HTMLImageElement) { requested = this; });
		const root = document.createElement("div");
		root.innerHTML = renderMarkdown('<img src="https://images.example/raw.png" alt="Raw preview" title="Preview" width="40%">');
		document.body.append(root);
		root.addEventListener("click", event => handleRemoteImage(event, root));
		expect(root.querySelector("img")).toBeNull();
		expect(root.querySelector(".vomp-remote-image")?.textContent).toContain("Raw preview");
		root.querySelector<HTMLButtonElement>("[data-load-image]")!.click();
		await vi.waitFor(() => expect(requested).toBeDefined());
		expect(requested?.style.width).toBe("40%");
		expect(requested?.style.height).toBe("auto");
		expect(requested?.title).toBe("Preview");
		requested!.dispatchEvent(new Event("load"));
		expect(root.querySelector("img")).toBe(requested);
		expect(root.querySelector(".vomp-remote-image")?.textContent).toBe("");
		expect(requested?.style.backgroundColor).toBe("");
	});
});
