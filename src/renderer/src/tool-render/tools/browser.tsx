/** `browser`: drive a browser tab (WebKit, Chromium, the relay or Tern): open/close named tabs, run puppeteer scripts. */
import type { ReactNode } from "react";
import { Badge, CodeBlock, ResultImages, ResultText, type Tone } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, num, shortenPath, str, truncate } from "../util";

interface BrowserDetails {
	action: string | null;
	name: string | null;
	url: string | null;
	browser: string | null;
}

function detailsOf(result: ToolRenderProps["result"]): BrowserDetails {
	const d = detailsRecord(result);
	return {
		action: d ? str(d.action) : null,
		name: d ? str(d.name) : null,
		url: d ? str(d.url) : null,
		browser: d ? str(d.browser) : null,
	};
}

interface AppArg {
	path: string | null;
	cdpUrl: string | null;
	/** A browser named by keyword (`relay`, `webkit`, `chromium`, ...); omp reports the one it used in `details.browser`. */
	keyword: string | null;
	target: string | null;
}

/** `app` keywords omp 18.19.0 accepts; any other string is a CDP endpoint URL or an executable path. */
const APP_KEYWORDS: Record<string, true> = { relay: true, tern: true, webkit: true, chromium: true, own: true, auto: true };
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** omp 18.19.0 takes `app` as one string and `target` at the top level; earlier versions take an `app` object. */
function appOf(args: Record<string, unknown>): AppArg | null {
	const target = str(args.target);
	const app = str(args.app);
	if (app !== null) {
		if (URL_SCHEME.test(app)) return { path: null, cdpUrl: app, keyword: null, target };
		if (Object.hasOwn(APP_KEYWORDS, app)) return { path: null, cdpUrl: null, keyword: app, target };
		return { path: app, cdpUrl: null, keyword: null, target };
	}
	if (isRecord(args.app)) return { path: str(args.app.path), cdpUrl: str(args.app.cdp_url), keyword: null, target: target ?? str(args.app.target) };
	return target !== null ? { path: null, cdpUrl: null, keyword: null, target } : null;
}

function actionTone(action: string): Tone | undefined {
	switch (action) {
		case "open":
			return "ok";
		case "run":
			return "accent";
		case "close":
			return "warn";
		default:
			return undefined;
	}
}

/** Mirrors the TUI's `describeBrowser`: an explicit endpoint or executable wins over the reported mode. */
function describeBrowser(app: AppArg | null, details: BrowserDetails): string | null {
	if (app?.cdpUrl) return `connected ${app.cdpUrl}`;
	if (app?.path) return `spawned ${shortenPath(app.path)}`;
	return details.browser ?? app?.keyword ?? null;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsOf(result);
	const action = str(args.action) ?? details.action ?? "?";
	const closeAll = action === "close" && (args.all === true || (str(args.name) === null && details.name === null));
	const tab = details.name ?? str(args.name) ?? "main";
	const url = details.url ?? str(args.url);
	return (
		<>
			<Badge tone={actionTone(action)}>{action}</Badge>
			<span>{closeAll ? "all tabs" : tab}</span>
			{args.kill === true && <Badge tone="err">kill</Badge>}
			{url && <span className="tv-faint">{truncate(shortenPath(url), 72)}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsOf(result);
	const action = str(args.action) ?? details.action;
	const app = appOf(args);
	const tab = details.name ?? str(args.name);
	const url = details.url ?? str(args.url);
	const browserDesc = describeBrowser(app, details);
	const viewport = isRecord(args.viewport) ? args.viewport : null;
	const vpWidth = viewport ? num(viewport.width) : null;
	const vpHeight = viewport ? num(viewport.height) : null;
	const vpScale = viewport ? num(viewport.scale) : null;
	const code = str(args.code);
	return (
		<>
			<span className="tv-badges">
				{tab !== null && <Badge>tab {tab}</Badge>}
				{url && <Badge tone="accent">{truncate(shortenPath(url), 120)}</Badge>}
				{browserDesc && <Badge>{browserDesc}</Badge>}
				{app?.target && <Badge>target {app.target}</Badge>}
				{args.all === true && <Badge tone="warn">all</Badge>}
				{args.kill === true && <Badge tone="err">kill</Badge>}
				{vpWidth !== null && vpHeight !== null && (
					<Badge>
						{vpWidth}×{vpHeight}
						{vpScale !== null ? `@${vpScale}x` : ""}
					</Badge>
				)}
			</span>
			{action === "run" && code !== null && <CodeBlock code={code.replace(/\s+$/, "")} lang="javascript" />}
			<ResultImages result={result} />
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const browserRenderer: ToolRenderer = { Summary, Body };
