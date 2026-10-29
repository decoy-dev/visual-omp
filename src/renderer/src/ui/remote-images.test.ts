// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../transcript/render";
import { handleRemoteImage } from "./remote-images";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("remote Markdown image consent", () => {
	it("makes no image request until activation, and loads only the chosen image", () => {
		const requests: { image: HTMLImageElement; url: string }[] = [];
		vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function(this: HTMLImageElement, url: string) { requests.push({ image: this, url }); });
		const root = document.createElement("div");
		root.innerHTML = renderMarkdown("![First](https://images.example/one?private=one)\n\n![Second](https://images.example/two?private=two)");
		document.body.append(root);
		root.addEventListener("click", event => handleRemoteImage(event, root));
		expect(requests).toHaveLength(0);
		expect(root.querySelectorAll("img")).toHaveLength(0);
		const buttons = root.querySelectorAll<HTMLButtonElement>("[data-load-image]");
		buttons[1].click();
		expect(requests.map(request => request.url)).toEqual(["https://images.example/two?private=two"]);
		expect(requests[0].image.referrerPolicy).toBe("no-referrer");
		buttons[1].click();
		expect(requests).toHaveLength(1);
		requests[0].image.dispatchEvent(new Event("load"));
		expect(root.querySelector("img")?.alt).toBe("Second");
		expect(root.querySelectorAll("[data-load-image]")).toHaveLength(1);
	});

	it("keeps a failed request retryable without loading another image", () => {
		let requested: HTMLImageElement | undefined;
		vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function(this: HTMLImageElement) { requested = this; });
		const root = document.createElement("div");
		root.innerHTML = renderMarkdown("![Preview](https://images.example/fail)");
		document.body.append(root);
		root.addEventListener("click", event => handleRemoteImage(event, root));
		root.querySelector<HTMLButtonElement>("button")!.click();
		requested!.dispatchEvent(new Event("error"));
		expect(root.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
		expect(root.textContent).toContain("This image could not be loaded.");
	});
});
