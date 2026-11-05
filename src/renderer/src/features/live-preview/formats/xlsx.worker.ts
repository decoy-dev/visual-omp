/// <reference lib="webworker" />
import { WorkbookPreview, type OfficeWindow } from "./xlsx-model";

let workbook: WorkbookPreview | null = null;
self.onmessage = (event: MessageEvent<{ id: number; bytes?: Uint8Array; window?: OfficeWindow }>) => {
	const { id, bytes, window } = event.data;
	try {
		if (bytes) {
			workbook = new WorkbookPreview(bytes);
			self.postMessage({ id, ok: true, sheets: workbook.sheets });
		} else if (window && workbook) self.postMessage({ id, ok: true, ...workbook.window(window) });
		else throw new Error("unsafe");
	} catch { self.postMessage({ id, ok: false, reason: "unsafe" }); }
};
