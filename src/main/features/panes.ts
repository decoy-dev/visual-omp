import { handle } from "../ipc";
import { findPlanFile, readPaneFile } from "../services/panes";

export function register(): void {
	handle("panes:readFile", path => readPaneFile(path));
	handle("panes:planFile", sessionFile => findPlanFile(sessionFile));
}
