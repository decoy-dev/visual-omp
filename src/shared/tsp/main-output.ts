import type { TspNode, TspText } from "../tsp";
import type { TspHostSnapshot } from "../tsp-host";
import { isReplicatedRole, TSP_CLAIMS, TSP_NOTICE_ROLES, TSP_ROLES } from "./roles";

export interface OutputLocation { kind: "url" | "path"; value: string }
export interface MainOutput {
	surfaceId: string;
	nodeId: string;
	text: string;
	/** Native Result body when a declared dashboard control is already represented by its offered URL. */
	resultText?: string;
	title?: string;
	/** A same-frame replacement of an unchanged root, rather than a new printed item. */
	previousNodeId?: string;
	tone: "info" | "warn" | "err";
	locations: OutputLocation[];
	fingerprint: string;
}
const visibleSpans = (value: TspText | undefined) => typeof value === "string" ? [{ t: value }] : value?.filter(span => !span.s?.split(" ").some(token => token === "hide" || token === "icon")) ?? [];
const excluded = (node: TspNode): boolean => {
	const role = node.p?.role;
	// Collab's asynchronous session notices never belong to the command being watched.
	if (node.k === "toast" && role === TSP_ROLES.toastStatus && node.p?.text?.startsWith("collab: ")) return true;
	return !!node.p?.hidden || isReplicatedRole(role) || !!role && (
		role === TSP_ROLES.activity || role === TSP_ROLES.compaction || role === TSP_ROLES.userShell || role === TSP_ROLES.userPython ||
		/^omp\.(?:overlay|plan|btw|hook|editor|composer)(?:\.|$)/.test(role) || !!TSP_CLAIMS[role] && !TSP_NOTICE_ROLES[role]);
};
const readable: Readonly<Record<string, true>> = { col: true, row: true, text: true, md: true, rows: true, toast: true, button: true, icon: true, spacer: true, rule: true };
const supportedActions: Readonly<Record<string, true>> = { open: true, copy: true };
function containsForm(node: TspNode): boolean {
	return !node.p?.hidden && (node.k === "input" || node.k === "editor" || (node.c?.some(containsForm) ?? false));
}
function supportedOutput(node: TspNode): boolean {
	if (node.p?.hidden) return true;
	if (excluded(node) || !readable[node.k] || node.k === "button" && !node.p?.href) return false;
	const actions = node.p?.actions;
	if (actions && [actions.click, actions.dblclick, ...(actions.menu ?? [])].some(action => action && !supportedActions[action])) return false;
	return node.c?.every(supportedOutput) ?? true;
}
function actionContent(node: TspNode): unknown[] {
	if (excluded(node)) return [];
	return [
		...(node.p?.actions ? [[node.p.actions, node.k === "button" ? [node.p?.disabled, node.p?.busy] : null]] : []),
		...(node.c?.flatMap(actionContent) ?? []),
	];
}
/** Literal public output by default; offered Result locations can replace the redundant dashboard control label. */
export function mainOutputText(node: TspNode, offered?: readonly OutputLocation[]): string {
	if (excluded(node)) return "";
	if (node.p?.actions?.click === "open" && offered?.some(location => location.kind === "url" && location.value === node.p?.href)
		&& /^Open dashboard(?: ↗)?$/.test(mainOutputText(node).trim())) return "";
	let own = "";
	if (node.k === "text") own = visibleSpans(node.p?.spans ?? node.p?.text).map(span => span.t).join("");
	else if (node.k === "md" || node.k === "toast") own = node.p?.text ?? "";
	else if (node.k === "rows") own = node.p?.lines.join("\n") ?? "";
	else if (node.k === "button") own = node.p?.text ?? "";
	const children = node.c?.map(child => mainOutputText(child, offered)).filter(Boolean) ?? [];
	return [own, ...children].filter(Boolean).join("\n");
}
/** Paths are kept whole when omp prints its move/worktree sentence or a labelled path line. */
export function outputLocations(text: string): OutputLocation[] {
	const result: OutputLocation[] = [];
	const add = (kind: OutputLocation["kind"], value: string) => {
		if (value && !result.some(item => item.kind === kind && item.value === value)) result.push({ kind, value });
	};
	for (const match of text.matchAll(/https?:\/\/[^\s<>"`]+/g)) add("url", match[0]);
	for (const line of text.split("\n")) {
		const path = /^(?:Moved to (?:worktree )?|(?:Session exported to|LLM request JSON|Wrote todos to|Path|File|Output|Saved to|Recording to):?\s*)(\/[^\r\n]+|[A-Za-z]:[\\/][^\r\n]+)/i.exec(line.trim())?.[1]
			?? /^(\/[^\r\n]+|[A-Za-z]:[\\/][^\r\n]+)$/.exec(line.trim())?.[1];
		if (path) {
			const branch = line.trim().startsWith("Moved to worktree ") ? path.lastIndexOf(" on branch ") : -1;
			add("path", branch < 0 ? path : path.slice(0, branch));
		}
	}
	return result;
}
function details(node: TspNode): { tone: MainOutput["tone"]; locations: OutputLocation[] } {
	let tone: MainOutput["tone"] = "info";
	const locations = outputLocations(mainOutputText(node));
	const addUrl = (value: string | undefined) => {
		if (value && /^https?:\/\//.test(value) && !locations.some(item => item.value === value)) locations.push({ kind: "url", value });
	};
	const visit = (part: TspNode) => {
		if (excluded(part)) return;
		if (part.p?.tone === "error" || part.p?.role === TSP_ROLES.noticeError) tone = "err";
		else if (tone !== "err" && (part.p?.tone === "warning" || part.p?.role === TSP_ROLES.noticeWarning)) tone = "warn";
		addUrl(part.p?.href);
		if (part.k === "text") for (const span of visibleSpans(part.p?.spans ?? part.p?.text)) {
			const styles = span.s?.split(" ") ?? [];
			if (styles.includes("error")) tone = "err";
			else if (tone !== "err" && styles.includes("warning")) tone = "warn";
			addUrl(span.href);
		}
		part.c?.forEach(visit);
	};
	visit(node);
	return { tone, locations };
}
/** Eligibility is checked again at fallback suppression, including newly added controls. */
export function mainOutputFingerprint(node: TspNode): string | null {
	if (containsForm(node) || !supportedOutput(node)) return null;
	const detail = details(node);
	const text = mainOutputText(node);
	const resultText = mainOutputText(node, detail.locations);
	return JSON.stringify([text, detail, node.p?.title?.trim() || null, actionContent(node), resultText !== text ? resultText : null]);
}
/** Whole readable subtrees give grouped notices one stable identity across progress updates. */
export function mainOutputNodes(snapshot: TspHostSnapshot): MainOutput[] {
	if (!snapshot.negotiated || snapshot.lifecycle !== "live" || snapshot.closing) return [];
	const result: MainOutput[] = [];
	for (const surface of snapshot.surfaces) {
		if (surface.closed || surface.suspended || surface.open.mode !== "inline" || surface.open.role !== TSP_ROLES.session || surface.documentGeneration !== snapshot.generation) continue;
		const visit = (node: TspNode) => {
			if (excluded(node) || containsForm(node)) return;
			if (!supportedOutput(node)) { if (!node.p?.actions && (node.k === "col" || node.k === "row")) node.c?.forEach(visit); return; }
			const text = mainOutputText(node);
			if (!text.trim()) return;
			const detail = details(node);
			const resultText = mainOutputText(node, detail.locations);
			result.push({ surfaceId: surface.open.id, nodeId: node.id, text, ...(resultText !== text ? { resultText } : {}), ...(node.p?.title?.trim() ? { title: node.p.title } : {}), ...detail, fingerprint: mainOutputFingerprint(node)! });
		};
		surface.document.c?.find(node => node.id === "main")?.c?.forEach(visit);
	}
	return result;
}
