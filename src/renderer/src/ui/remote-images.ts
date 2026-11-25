import { i18n } from "../i18n";
const CSS_IMAGE_DIMENSION = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|%|vw|vh|ch|em)$/i;

async function loadRemoteImage(
	root: HTMLElement,
	placeholder: HTMLElement,
	button: HTMLButtonElement,
	status: HTMLElement | null,
	url: string,
	onBlobUrl?: (url: string) => void,
): Promise<void> {
	let objectUrl: string | null = null;
	try {
		const result = await window.vomp.invoke("app:fetchRemoteImage", url);
		if (!root.contains(placeholder)) return;
		objectUrl = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mimeType }));
		onBlobUrl?.(objectUrl);
		const createdUrl = objectUrl;
		const image = document.createElement("img");
		image.alt = placeholder.dataset.imageAlt || "";
		image.tabIndex = 0;
		const width = placeholder.dataset.imageWidth;
		const height = placeholder.dataset.imageHeight;
		image.style.maxWidth = "100%";
		if (width && CSS_IMAGE_DIMENSION.test(width)) image.style.width = width;
		if (height && CSS_IMAGE_DIMENSION.test(height)) image.style.height = height;
		if (width && !height) image.style.height = "auto";
		if (height && !width) image.style.width = "auto";
		if (placeholder.dataset.imageTitle) image.title = placeholder.dataset.imageTitle;
		image.onload = () => {
			if (root.contains(placeholder)) {
				placeholder.dataset.imageLoaded = "";
				placeholder.replaceChildren(image);
			} else {
				URL.revokeObjectURL(createdUrl);
			}
		};
		image.onerror = () => {
			URL.revokeObjectURL(createdUrl);
			if (!root.contains(placeholder)) return;
			button.disabled = false;
			if (status) status.textContent = i18n.t("chat:visual.imageFailed");
		};
		// Assigning the blob URL loads the already-fetched bytes without triggering external image requests in the renderer.
		image.src = createdUrl;
	} catch {
		if (objectUrl) URL.revokeObjectURL(objectUrl);
		if (!root.contains(placeholder)) return;
		button.disabled = false;
		if (status) status.textContent = i18n.t("chat:visual.imageFailed");
	}
}

/** Remote Markdown images stay inert until this exact placeholder's button is activated. */
export function handleRemoteImage(event: MouseEvent, root: HTMLElement, onBlobUrl?: (url: string) => void): void {
	const target = event.target instanceof Element ? event.target : null;
	const button = target?.closest<HTMLButtonElement>("[data-load-image]");
	const placeholder = button?.closest<HTMLElement>("[data-remote-image]");
	if (!button || !placeholder || !root.contains(placeholder) || button.disabled) return;
	event.preventDefault();
	event.stopPropagation();
	let url: URL;
	try { url = new URL(placeholder.dataset.remoteImage || ""); } catch { return; }
	if (url.protocol !== "https:" && url.protocol !== "http:") return;
	button.disabled = true;
	const status = placeholder.querySelector<HTMLElement>("[data-image-status]");
	if (status) status.textContent = i18n.t("chat:visual.loadingImage");
	void loadRemoteImage(root, placeholder, button, status, url.href, onBlobUrl);
}
