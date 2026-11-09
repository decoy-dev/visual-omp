import { homedir } from "node:os";
import { join } from "node:path";
import { nativeImage } from "electron";
import { userEnv } from "../env";
import { handle, handleWithEvent } from "../ipc";
import { agentDataDir } from "../omp/paths";
import { findPlanFile, inspectPaneFile, previewablePath, readPaneFile, readPdfFile, scanMadeFiles } from "../services/panes";
import { grantBlobPreview } from "../services/preview-protocol";

/** Longest side of an Outputs pane thumbnail, in pixels. */
const THUMBNAIL_SIZE = 480;

export function register(): void {
	handle("panes:readFile", path => readPaneFile(path));
	handle("panes:inspect", path => inspectPaneFile(path));
	handleWithEvent("panes:readBlob", async (event, hash) => grantBlobPreview(join(agentDataDir(await userEnv()), "blobs"), hash, event.sender.id));
	handle("panes:readPdf", path => readPdfFile(path));
	handle("panes:thumbnail", async path => {
		try {
			const image = await nativeImage.createThumbnailFromPath(await previewablePath(path), { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE });
			return image.isEmpty() ? null : image.toDataURL();
		} catch {
			return null;
		}
	});
	handle("panes:scanMade", queries => scanMadeFiles(queries, homedir()));
	handle("panes:planFile", sessionFile => findPlanFile(sessionFile));
}
