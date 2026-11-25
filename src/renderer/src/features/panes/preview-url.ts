function isBlockedOrigin(url: URL, blockedOrigin: string | null): boolean {
	if (!blockedOrigin) return false;
	if (url.origin === blockedOrigin) return true;
	try {
		const blocked = new URL(blockedOrigin);
		const loopback = (host: string) => host === "localhost" || host === "127.0.0.1";
		return url.protocol === "http:"
			&& blocked.protocol === "http:"
			&& url.port === blocked.port
			&& loopback(url.hostname)
			&& loopback(blocked.hostname);
	} catch {
		return false;
	}
}

/**
 * Normalizes what the user typed into the Preview address bar, or null when it may not load there
 * (the frame CSP allows local http and https only): `localhost:3000` -> `http://localhost:3000/`,
 * `:5173` -> `http://localhost:5173/`, bare hosts -> `https://`. Also refuses visual-omp's own
 * dev-server origin so a same-origin frame cannot script the app window.
 */
export function normalizePreviewUrl(input: string, blockedOrigin?: string | null): string | null {
	const text = input.trim();
	if (!text) return null;
	const withScheme = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0):\d/i.test(text)
		? text
		: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?(\/|$)/i.test(text) || /^:\d+/.test(text)
			? `http://${text.startsWith(":") ? `localhost${text}` : text}`
			: `https://${text}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	if (url.hostname === "0.0.0.0") url.hostname = "localhost";
	const resolvedBlocked = blockedOrigin !== undefined
		? blockedOrigin
		: typeof window !== "undefined" && (window.location.protocol === "http:" || window.location.protocol === "https:")
			? window.location.origin
			: null;
	if (isBlockedOrigin(url, resolvedBlocked)) return null;
	const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
	return local || url.protocol === "https:" ? url.href : null;
}
