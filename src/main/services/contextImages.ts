/** Validate the renderer's rasterized image before native decoding or a save dialog. No URLs are fetched. */
export function contextImageBytes(dataUrl: unknown): Buffer {
	if (typeof dataUrl !== "string" || dataUrl.length > 32 * 1024 * 1024 || !dataUrl.startsWith("data:image/png;base64,")) throw new Error("Expected PNG image data up to 24 MB");
	const encoded = dataUrl.slice("data:image/png;base64,".length);
	if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid image data");
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Expected PNG image data");
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	if (!width || !height || width * height > 40_000_000) throw new Error("This image is too large to copy or save");
	return bytes;
}
