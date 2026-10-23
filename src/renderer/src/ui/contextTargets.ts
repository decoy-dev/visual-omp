import { resolveOutputPath, type OutputContext } from "../features/panes/derive";

export type ContextTarget =
	| { kind: "link"; url: string }
	| { kind: "file" | "folder"; path: string; changes?: boolean }
	| { kind: "image"; source: string; path?: string };

/** Known filesystem paths retain their spelling. Only tool expressions carry selectors or globs. */
export function contextPath(raw: string, context: OutputContext, source: "literal" | "tool" = "literal"): string | null {
	if (source === "literal") {
		if (!raw || raw.includes("\0")) return null;
		if (/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(raw)) return raw;
		return context.cwd ? `${context.cwd.replace(/[\\/]+$/, "")}/${raw}` : null;
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return null;
	if (/[\0*?]/.test(raw)) return null;
	const absolute = resolveOutputPath(raw.replace(/(?::(?:raw|img|conflicts|[\d,+\-hms]+))+$/, ""), context);
	return absolute ? normalizePath(absolute) : null;
}

/** Lexical normalization is used for raw tool paths and project-containment comparisons only. */
function normalizePath(absolute: string): string {
	const windows = /^[a-z]:[\\/]|^\\\\/i.test(absolute);
	const path = windows ? absolute.replace(/\\/g, "/") : absolute;
	const root = /^[a-z]:\//i.exec(path)?.[0] ?? (path.startsWith("//") ? `//${path.split("/").slice(2, 4).join("/")}/` : "/");
	const parts: string[] = [];
	for (const part of path.slice(root.length).split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	const normalized = root + parts.join("/");
	return windows ? normalized.replace(/\//g, "\\") : normalized;
}

export function projectRelativePath(project: string | null, path: string): string | null {
	if (!project) return null;
	const projectPath = contextPath(project, { cwd: null, home: null });
	const literal = contextPath(path, { cwd: null, home: null });
	if (!projectPath || !literal) return null;
	const root = normalizePath(projectPath).replace(/[\\/]+$/, "");
	const full = normalizePath(literal);
	const windows = /^[a-z]:|^\\\\/i.test(root);
	const comparable = (value: string) => windows ? value.toLowerCase().replace(/\\/g, "/") : value;
	if (comparable(full).replace(/[\\/]+$/, "") === comparable(root)) return ".";
	return comparable(full).startsWith(`${comparable(root)}/`) ? full.slice(root.length + 1).replace(/\\/g, "/") : null;
}

export function localPreviewUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return ["http:", "https:"].includes(parsed.protocol) && ["localhost", "127.0.0.1"].includes(parsed.hostname);
	} catch { return false; }
}

export type ContextActionId = "openBrowser" | "openPreview" | "copyLink" | "open" | "changes" | "openDefault" | "reveal" | "copyPath" | "copyRelative" | "mention" | "copyImage" | "saveImage";

/** Item order is shared by transcript targets, pane rows and viewers. */
export function contextActionIds(target: ContextTarget, project: string | null): ContextActionId[] {
	if (target.kind === "link") return ["openBrowser", ...(project && localPreviewUrl(target.url) ? ["openPreview" as const] : []), "copyLink"];
	if (target.kind === "image") return ["copyImage", "saveImage", ...(target.path ? ["openDefault", "reveal", "copyPath"] as const : [])];
	return ["open", ...(target.changes ? ["changes" as const] : []), ...(target.kind === "file" ? ["openDefault" as const] : []), "reveal", "copyPath", ...(projectRelativePath(project, target.path) !== null ? ["copyRelative" as const] : []), ...(project ? ["mention" as const] : [])];
}
