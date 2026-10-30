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

/**
 * Copy buttons call `navigator.clipboard.writeText`, which Chromium gates behind `clipboard-sanitized-write`. Only the
 * app's top-level document may write, and only sanitized data; reading the clipboard stays denied. The handlers already
 * match the main webContents and its top-level URL; the explicit main-frame flag excludes iframes such as the Preview
 * pane, and a supplied requesting URL must be the app's.
 */
export function allowsClipboardWrite(permission: string, details: { isMainFrame?: boolean; requestingUrl?: string }): boolean {
	return permission === "clipboard-sanitized-write" && details.isMainFrame === true && (details.requestingUrl === undefined || isAppUrl(details.requestingUrl));
}

/** Everything the app document may use: its microphone for dictation and sanitized clipboard writes. */
export function allowsAppPermission(permission: string, details: { isMainFrame: boolean; requestingUrl?: string; mediaType?: string; mediaTypes?: string[] }): boolean {
	return allowsMicrophone(permission, details) || allowsClipboardWrite(permission, details);
}
