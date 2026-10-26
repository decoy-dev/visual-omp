import type { Platform } from "./ipc";

/** omp's unscoped working folder. macOS uses /tmp, rather than its per-user os.tmpdir(). */
export function defaultChatFolder(platform: Platform, systemTemp: string): string {
	return platform === "win32" ? systemTemp : "/tmp";
}

/** A command keeps an explicit chat's folder, or the overview's. Other screens start unscoped. */
export function commandChatFolder(view: "home" | "project" | "chat" | "page", sessionPath: string | null, projectPath: string | null): string | undefined {
	return sessionPath ?? (view === "project" ? projectPath ?? undefined : undefined);
}
