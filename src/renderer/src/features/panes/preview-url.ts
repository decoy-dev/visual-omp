/**
 * Normalizes what the user typed into the Preview address bar, or null when it may not load there
 * (the frame CSP allows local http and https only): `localhost:3000` → `http://localhost:3000/`,
 * `:5173` → `http://localhost:5173/`, bare hosts → `https://`.
 */
export function normalizePreviewUrl(input: string): string | null {
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
	const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
	return local || url.protocol === "https:" ? url.href : null;
}
