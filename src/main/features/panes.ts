import { join } from "node:path";
import { shell } from "electron";
import { userEnv } from "../env";
import { handle } from "../ipc";
import { agentDir } from "../omp/paths";
import { findPlanFile, openableImagePath, readBlobImage, readPaneFile } from "../services/panes";

export function register(): void {
	handle("panes:readFile", path => readPaneFile(path));
	handle("panes:readBlob", async hash => readBlobImage(join(agentDir(await userEnv()), "blobs"), hash));
	handle("panes:openImage", async path => {
		// Only passive raster images: opening arbitrary paths would let chat content launch programs.
		const failure = await shell.openPath(await openableImagePath(path));
		if (failure) throw new Error(failure);
	});
	handle("panes:planFile", sessionFile => findPlanFile(sessionFile));
}
