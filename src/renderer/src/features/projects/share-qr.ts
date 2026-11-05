import qrcode from "qrcode-generator";

/** Four light modules around the code keep the camera's required quiet zone intact. */
export function shareQr(link: string): { size: number; path: string } {
	const code = qrcode(0, "M");
	code.addData(link);
	code.make();
	const modules = code.getModuleCount();
	const cells: string[] = [];
	for (let row = 0; row < modules; row++) {
		for (let col = 0; col < modules; col++) {
			if (code.isDark(row, col)) cells.push(`M${col + 4} ${row + 4}h1v1h-1z`);
		}
	}
	return { size: modules + 8, path: cells.join("") };
}
