/** macOS exposes these system folders both directly and below /private. No filesystem access is needed. */
const MAC_PRIVATE_FOLDER = /^\/private\/(tmp|var|etc)(?=\/|$)/;
const MAC_FOLDER = /^\/(tmp|var|etc)(?=\/|$)/;

/** Comparison identity only; other platforms can have distinct files at these paths. */
export function outputPathKey(path: string, platform?: string): string {
	return platform === "darwin" ? path.replace(MAC_PRIVATE_FOLDER, "/$1") : path;
}

/** Keep the chat folder's spelling when a tool reports the other macOS system-folder alias. */
export function outputPathInFolder(path: string, folder: string | null, platform?: string): string {
	if (platform !== "darwin" || !folder) return path;
	const key = outputPathKey(path, platform);
	const root = MAC_FOLDER.exec(outputPathKey(folder, platform));
	if (!root || !(key === root[0] || key.startsWith(`${root[0]}/`))) return path;
	return MAC_PRIVATE_FOLDER.test(folder) ? `/private${key}` : key;
}
