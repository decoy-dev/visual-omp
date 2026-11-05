/// <reference lib="webworker" />
import { rewriteOfficePackage } from "@shared/preview-office-package";

self.onmessage = (event: MessageEvent<{ id: number; bytes: Uint8Array }>) => {
	try {
		const result = rewriteOfficePackage(event.data.bytes, "docx");
		self.postMessage({ id: event.data.id, ok: true, ...result }, { transfer: [result.bytes.buffer] });
	} catch { self.postMessage({ id: event.data.id, ok: false, reason: "unsafe" }); }
};
