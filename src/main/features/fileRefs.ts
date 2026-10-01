import { homedir } from "node:os";
import { handle } from "../ipc";
import { resolveFileRefs } from "../services/fileRefs";

export function register(): void {
	handle("fs:resolveRefs", request => resolveFileRefs(request, homedir()));
}
