import { parentPort } from "node:worker_threads";
import { rewriteOfficePackage } from "@shared/preview-office-package";

parentPort?.once("message", (bytes: Uint8Array) => {
	try {
		const clean = rewriteOfficePackage(bytes, "pptx").bytes;
		parentPort!.postMessage({ ok: true, bytes: clean }, [clean.buffer]);
	} catch { parentPort!.postMessage({ ok: false }); }
});
