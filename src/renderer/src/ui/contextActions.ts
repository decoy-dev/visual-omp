import { useComposerDrafts } from "../chat/composer/drafts";
import { openInFiles } from "../features/panes/files-store";
import { useFileChangesRequest } from "../features/panes/git-store";
import { usePreview } from "../features/panes/preview-store";
import { errorText } from "../features/extensions/format";
import { i18n } from "../i18n";
import { dockKey, useApp } from "../state/app";
import { toast } from "./toast";
import { projectRelativePath, type ContextActionId, type ContextTarget } from "./contextTargets";

export interface ContextScope { projectPath: string | null; tabId: string | null }

export async function copyText(text: string, message = i18n.t("panes:context.copied")): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast({ tone: "ok", message });
	} catch (error) {
		toast({ tone: "err", message: i18n.t("panes:context.failed"), description: errorText(error) });
	}
}

export function revealLabel(t: (key: string) => string): string {
	return t(window.vomp.platform === "darwin" ? "files.revealMac" : "files.reveal");
}

export async function mentionInChat(projectPath: string, path: string, tabId: string | null): Promise<void> {
	const target = tabId ?? (await useApp.getState().newChat(projectPath));
	if (target) useComposerDrafts.getState().insert(target, `@${projectRelativePath(projectPath, path) ?? path} `);
}

export function openFile(path: string, projectPath: string | null, tabId: string | null = null): void {
	if (projectPath) openInFiles(projectPath, path, { tabId });
	else void window.vomp.invoke("app:showItem", path);
}

export function openWithDefaultApp(path: string, t: (key: string) => string): void {
	void window.vomp.invoke("app:openFile", path).catch((error: unknown) => toast({ tone: "err", message: t("outputs.openFailed"), description: errorText(error) }));
}

/** Rasterize in Chromium, including SVG and formats nativeImage cannot decode. Main receives PNG data only. */
async function imageData(source: string): Promise<string> {
	const image = new Image();
	if (/^https?:/i.test(source)) image.crossOrigin = "anonymous";
	image.src = source;
	await image.decode();
	if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error(i18n.t("panes:context.imageTooLarge"));
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const context = canvas.getContext("2d");
	if (!context) throw new Error(i18n.t("panes:outputs.unavailable"));
	context.drawImage(image, 0, 0);
	return canvas.toDataURL("image/png");
}

export async function runContextAction(id: ContextActionId, target: ContextTarget, scope: ContextScope): Promise<void> {
	const { projectPath, tabId } = scope;
	const app = useApp.getState();
	const dock = tabId ?? dockKey(app);
	try {
		if (target.kind === "link") {
			if (id === "copyLink") await copyText(target.url, i18n.t("panes:context.linkCopied"));
			else if (id === "openBrowser") await window.vomp.invoke("app:openExternal", target.url);
			else if (id === "openPreview" && projectPath) {
				usePreview.getState().go(dock, target.url);
				app.showPane("preview", dock);
			}
			return;
		}
		const path = target.path;
		if (target.kind === "image" && (id === "copyImage" || id === "saveImage")) {
			let source = target.source;
			if (!source && path) {
				const file = await window.vomp.invoke("panes:readFile", path);
				if (file.kind !== "image") throw new Error(i18n.t("panes:outputs.unavailable"));
				source = file.dataUrl;
			}
			const dataUrl = await imageData(source);
			if (id === "copyImage") {
				await window.vomp.invoke("app:copyImage", dataUrl);
				toast({ tone: "ok", message: i18n.t("panes:context.imageCopied") });
			} else {
				const name = path?.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, "") ?? "image";
				const saved = await window.vomp.invoke("app:saveImage", { dataUrl, name: `${name}.png`, title: i18n.t("panes:context.saveImage") });
				if (saved) toast({ tone: "ok", message: i18n.t("panes:context.imageSaved") });
			}
			return;
		}
		if (!path) return;
		switch (id) {
			case "open": openFile(path, projectPath, tabId); break;
			case "changes":
				if (projectPath) useFileChangesRequest.setState({ request: { projectPath, tabId, path } });
				app.showPane("diff", dock);
				break;
			case "openDefault": await window.vomp.invoke("app:openFile", path); break;
			case "reveal": await window.vomp.invoke("app:showItem", path); break;
			case "copyPath": await copyText(path, i18n.t("panes:files.copied")); break;
			case "copyRelative": {
				const relative = projectRelativePath(projectPath, path);
				if (relative !== null) await copyText(relative, i18n.t("panes:files.copied"));
				break;
			}
			case "mention": if (projectPath) await mentionInChat(projectPath, path, tabId); break;
		}
	} catch (error) {
		toast({ tone: "err", message: i18n.t("panes:context.failed"), description: error instanceof Error ? error.message : String(error) });
	}
}
