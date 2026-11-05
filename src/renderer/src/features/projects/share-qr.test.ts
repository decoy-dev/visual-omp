import { expect, it } from "vitest";
import { shareQr } from "./share-qr";

const control = `https://my.omp.sh/#room_ABCDEFGHIJ.${"A".repeat(64)}`;
const view = `https://my.omp.sh/#room_ABCDEFGHIJ.${"A".repeat(43)}`;

it("generates stable QR geometry with a four-module quiet zone", () => {
	const code = shareQr(control);
	expect(shareQr(control)).toEqual(code);
	const cells = [...code.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(match => [Number(match[1]), Number(match[2])]);
	expect(cells.length).toBeGreaterThan(100);
	for (const [x, y] of cells) {
		expect(x).toBeGreaterThanOrEqual(4);
		expect(y).toBeGreaterThanOrEqual(4);
		expect(x).toBeLessThan(code.size - 4);
		expect(y).toBeLessThan(code.size - 4);
	}
	// The upper-left finder remains seven modules wide and starts after the quiet zone.
	for (let x = 4; x < 11; x++) expect(cells).toContainEqual([x, 4]);
});

it("encodes the control token and changes when the room rotates", () => {
	expect(shareQr(control)).not.toEqual(shareQr(view));
	expect(shareQr(control)).not.toEqual(shareQr(control.replace("room_ABCDEFGHIJ", "room_KLMNOPQRST")));
});

it("reports links beyond the QR capacity so the dialog can retain copy links", () => {
	expect(() => shareQr(`https://custom.example/${"a".repeat(5000)}`)).toThrow();
});
