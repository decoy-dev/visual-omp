import { i18n } from "../i18n";
const CSS_IMAGE_DIMENSION = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|%|vw|vh|ch|em)$/i;

/** Remote Markdown images stay inert until this exact placeholder's button is activated. */
export function handleRemoteImage(event: MouseEvent, root: HTMLElement): void {
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
	const image = document.createElement("img");
	image.alt = placeholder.dataset.imageAlt || "";
	image.referrerPolicy = "no-referrer";
	image.tabIndex = 0;
	const width = placeholder.dataset.imageWidth;
	const height = placeholder.dataset.imageHeight;
	image.style.maxWidth = "100%";
	if (width && CSS_IMAGE_DIMENSION.test(width)) image.style.width = width;
	if (height && CSS_IMAGE_DIMENSION.test(height)) image.style.height = height;
	if (width && !height) image.style.height = "auto";
	if (height && !width) image.style.width = "auto";
	if (placeholder.dataset.imageTitle) image.title = placeholder.dataset.imageTitle;
	image.onload = () => { if (root.contains(placeholder)) { placeholder.dataset.imageLoaded = ""; placeholder.replaceChildren(image); } };
	image.onerror = () => {
		if (!root.contains(placeholder)) return;
		button.disabled = false;
		if (status) status.textContent = i18n.t("chat:visual.imageFailed");
	};
	// Assigning src is the first network-capable operation, after the reader's explicit activation.
	image.src = url.href;
}
