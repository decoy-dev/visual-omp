let rendererUrl: URL | null = null;

/** Main configures the one document allowed to use the preload bridge. */
export function setAppRendererUrl(raw: string): void {
	rendererUrl = new URL(raw);
	rendererUrl.hash = "";
}

export function isAppUrl(raw: string): boolean {
	if (!rendererUrl) return false;
	try {
		const url = new URL(raw);
		url.hash = "";
		return url.href === rendererUrl.href;
	} catch {
		return false;
	}
}

/** Chromium uses file:// as the WebSocket Origin for a file-backed app document. */
export function isAppOrigin(raw: string): boolean {
	return rendererUrl !== null && raw === (rendererUrl.protocol === "file:" ? "file://" : rendererUrl.origin);
}

export function allowsMicrophone(permission: string, details: { isMainFrame: boolean; requestingUrl?: string; mediaType?: string; mediaTypes?: string[] }): boolean {
	if (permission !== "media" || !details.isMainFrame || !isAppUrl(details.requestingUrl ?? "")) return false;
	return details.mediaTypes !== undefined
		? details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === "audio")
		: details.mediaType === "audio";
}
