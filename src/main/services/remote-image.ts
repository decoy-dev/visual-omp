export const MAX_REMOTE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const ALLOWED_REMOTE_IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"image/svg+xml",
]);

function normalizeImageMime(headerValue: string | null): string | null {
	const raw = (headerValue ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	const normalized = raw === "image/jpg" ? "image/jpeg" : raw;
	return ALLOWED_REMOTE_IMAGE_TYPES.has(normalized) ? normalized : null;
}

function parseHttpUrl(raw: string, base?: URL): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw, base);
	} catch {
		throw new Error("The remote image URL is invalid.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported remote image protocol: ${parsed.protocol}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error("Remote image URLs cannot contain embedded credentials.");
	}
	return parsed;
}

/**
 * Fetches an explicitly requested remote Markdown image in main without renderer cookies or referer,
 * allowing the renderer CSP to drop `https:` from `img-src`.
 */
export async function fetchRemoteImage(
	rawUrl: string,
	fetchImpl: typeof fetch = fetch,
	maxBytes = MAX_REMOTE_IMAGE_BYTES,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
	let current = parseHttpUrl(rawUrl);
	let response: Response | null = null;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		response = await fetchImpl(current.href, {
			method: "GET",
			headers: { Accept: "image/*", "User-Agent": "visual-omp" },
			redirect: "manual",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!REDIRECT_STATUSES.has(response.status)) break;
		await response.body?.cancel().catch(() => undefined);
		const location = response.headers.get("location");
		if (!location) throw new Error("The image server sent a redirect without a location.");
		const next = parseHttpUrl(location, current);
		if (current.protocol === "https:" && next.protocol === "http:") {
			throw new Error("The image server redirected from HTTPS to HTTP.");
		}
		current = next;
		response = null;
	}
	if (!response) throw new Error("The image request redirected too many times.");
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`Image request failed with HTTP ${response.status}.`);
	}
	const mimeType = normalizeImageMime(response.headers.get("content-type"));
	if (!mimeType) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error("The remote server did not return a supported image type.");
	}
	const declared = response.headers.get("content-length");
	if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`Image exceeded ${maxBytes} bytes.`);
	}
	if (!response.body) {
		const raw = new Uint8Array(await response.arrayBuffer());
		if (raw.byteLength === 0) throw new Error("The image response was empty.");
		if (raw.byteLength > maxBytes) throw new Error(`Image exceeded ${maxBytes} bytes.`);
		return { bytes: raw, mimeType };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			if (total + value.byteLength > maxBytes) {
				throw new Error(`Image exceeded ${maxBytes} bytes.`);
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	if (total === 0) throw new Error("The image response was empty.");
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, mimeType };
}
