import { describe, expect, it } from "vitest";
import { contextImageBytes } from "./contextImages";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=";
const dataUrl = `data:image/png;base64,${png}`;

describe("context image data", () => {
	it("accepts bounded PNG data and returns its bytes unchanged", () => {
		expect(contextImageBytes(dataUrl)).toEqual(Buffer.from(png, "base64"));
	});
	it("refuses URLs, paths, other formats and incomplete or invalid base64", () => {
		for (const value of [null, 4, "https://example.com/a.png", "/tmp/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,a", "data:image/png;base64,@@@@", "data:image/png;base64,AAAA"]) expect(() => contextImageBytes(value)).toThrow();
	});
	it("refuses oversized dimensions before native decoding", () => {
		const bytes = Buffer.from(png, "base64");
		bytes.writeUInt32BE(100_000, 16);
		bytes.writeUInt32BE(100_000, 20);
		expect(() => contextImageBytes(`data:image/png;base64,${bytes.toString("base64")}`)).toThrow("too large");
		bytes.writeUInt32BE(0, 16);
		expect(() => contextImageBytes(`data:image/png;base64,${bytes.toString("base64")}`)).toThrow("too large");
	});
	it("refuses data over the payload limit", () => {
		expect(() => contextImageBytes(`data:image/png;base64,${"A".repeat(32 * 1024 * 1024)}`)).toThrow("24 MB");
	});
});
