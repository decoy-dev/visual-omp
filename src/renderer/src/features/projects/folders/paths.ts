/** Pure path helpers for the in-app folder browser (renderer has no `node:path`). */

export interface PathSegment {
	/** Label shown in the breadcrumb. */
	name: string;
	/** Absolute path of this segment. */
	path: string;
}

/** Drive prefix of an already-absolute path from main (`C:` alone is the drive root). */
const DRIVE_PREFIX = /^[A-Za-z]:\\?/;
/** A typed absolute drive path needs the root separator: `C:foo` is relative to that drive's cwd. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;

/**
 * Breadcrumb segments of an absolute path, root first: `/Users/me` → `/`, `Users`, `me`;
 * `C:\Users\me` → `C:`, `Users`, `me`; `\\server\share\x` → `\\server\share`, `x`.
 */
export function pathSegments(path: string, windows: boolean): PathSegment[] {
	if (!windows) {
		const parts = path.split("/").filter(Boolean);
		const segments: PathSegment[] = [{ name: "/", path: "/" }];
		let current = "";
		for (const part of parts) {
			current += `/${part}`;
			segments.push({ name: part, path: current });
		}
		return segments;
	}
	const normalized = path.replace(/\//g, "\\");
	let root: string;
	let rest: string;
	if (normalized.startsWith("\\\\")) {
		const [server = "", share = "", ...tail] = normalized.slice(2).split("\\");
		root = `\\\\${server}\\${share}`;
		rest = tail.join("\\");
	} else {
		const drive = DRIVE_PREFIX.exec(normalized)?.[0] ?? "";
		root = drive.slice(0, 2);
		rest = normalized.slice(drive.length);
	}
	const segments: PathSegment[] = [{ name: root, path: `${root}\\` }];
	let current = root;
	for (const part of rest.split("\\").filter(Boolean)) {
		current += `\\${part}`;
		segments.push({ name: part, path: current });
	}
	return segments;
}

/**
 * Turn typed text into an absolute path when it looks like one (`/…`, `~`, `~/…`, `C:\…`, `\\server`);
 * null for plain filter text.
 */
export function typedPath(text: string, home: string, windows: boolean): string | null {
	const value = text.trim();
	if (value === "~") return home;
	if (value.startsWith("~/") || (windows && value.startsWith("~\\"))) {
		const separator = windows ? "\\" : "/";
		return `${home.replace(/[\\/]+$/, "")}${separator}${value.slice(2)}`;
	}
	if (!windows) return value.startsWith("/") ? value : null;
	return DRIVE_ROOT.test(value) || value.startsWith("\\\\") ? value : null;
}

/** Names containing `query` (case-insensitive), names that start with it first; order is otherwise kept. */
export function filterByName<T extends { name: string }>(items: readonly T[], query: string): T[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...items];
	const starts: T[] = [];
	const contains: T[] = [];
	for (const item of items) {
		const name = item.name.toLowerCase();
		if (name.startsWith(needle)) starts.push(item);
		else if (name.includes(needle)) contains.push(item);
	}
	return [...starts, ...contains];
}

/** `path` with the home folder shown as `~` (display only). */
export function tildePath(path: string, home: string | null): string {
	if (!home) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) || path.startsWith(`${home}\\`) ? `~${path.slice(home.length)}` : path;
}
