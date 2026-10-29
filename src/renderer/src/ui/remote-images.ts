import { i18n } from "../i18n";

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
	image.onload = () => { if (root.contains(placeholder)) placeholder.replaceChildren(image); };
	image.onerror = () => {
		if (!root.contains(placeholder)) return;
		button.disabled = false;
		if (status) status.textContent = i18n.t("chat:visual.imageFailed");
	};
	// Assigning src is the first network-capable operation, after the reader's explicit activation.
	image.src = url.href;
}
