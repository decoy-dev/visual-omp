export const IMAGE_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
};

const imageExtensions = Object.keys(IMAGE_TYPES).map(extension => extension.slice(1)).join("|");
export const IMAGE_EXT = new RegExp(`\\.(?:${imageExtensions})$`, "i");

export function isSupportedImagePath(path: string): boolean {
	const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return false;
	return Object.prototype.hasOwnProperty.call(IMAGE_TYPES, name.slice(dot).toLowerCase());
}
