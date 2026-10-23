import { homedir } from "node:os";
import { join } from "node:path";
import { nativeImage } from "electron";
import { userEnv } from "../env";
import { handle } from "../ipc";
import { agentDir } from "../omp/paths";
import { findPlanFile, previewablePath, readBlobImage, readPaneFile, readPdfFile, scanMadeFiles } from "../services/panes";

/** Longest side of an Outputs pane thumbnail, in pixels. */
const THUMBNAIL_SIZE = 480;

export function register(): void {
	handle("panes:readFile", path => readPaneFile(path));
	handle("panes:readBlob", async hash => readBlobImage(join(agentDir(await userEnv()), "blobs"), hash));
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
