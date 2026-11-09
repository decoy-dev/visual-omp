import type { TspNode, TspText } from "../tsp";
import { TSP_ROLES } from "./roles";

/** Plain panel copy omits font icons and keyboard-only dismissal hints. */
export function panelText(node: TspNode): string {
	if (node.p?.hidden || node.p?.role === TSP_ROLES.overlayHints) return "";
	const value: TspText | undefined = node.k === "text" ? node.p?.spans ?? node.p?.text : node.k === "md" ? node.p?.text : node.k === "rule" ? node.p?.label : undefined;
	const own = typeof value === "string" ? value : value?.filter(span => !span.s?.split(" ").some(token => token === "icon" || token === "hide")).map(span => span.t).join("") ?? "";
	return [own, ...(node.c?.map(panelText) ?? [])].filter(Boolean).join("\n");
}
export interface SettledCommandPanel {
	command: string;
	status: "success" | "warning" | "cancelled" | "error";
	lines: string[];
	path?: string;
}

/** The footer is the outcome contract. A stopped spinner alone never establishes completion. */
export function settledCommandPanel(node: TspNode): SettledCommandPanel | null {
	const role = node.p?.role;
	if (node.k !== "col" || node.p?.hidden || role !== TSP_ROLES.cleanse && role !== TSP_ROLES.omfg) return null;
	const supported = (child: TspNode): boolean => child.p?.hidden === true || !child.p?.actions && !child.p?.href && !child.p?.hovercard
		&& ["col", "row", "text", "md", "kbd", "icon", "spacer", "rule"].includes(child.k)
		&& !(child.k === "text" && child.p?.spans?.some(span => span.href))
		&& !(child.k === "rule" && Array.isArray(child.p?.label) && child.p.label.some(span => span.href))
		&& !(child.k === "md" && child.p?.stream) && (child.c?.every(supported) ?? true);
	if (!supported(node)) return null;
	const head = node.c?.find(child => child.p?.role === TSP_ROLES.sheetHead);
	const footer = node.c?.at(-1);
	if (!head || !footer || footer === head) return null;
	const outcome = panelText(footer).trim();
	const command = panelText(head);
	const body = node.c?.filter(child => child !== head && child !== footer).map(panelText).filter(Boolean) ?? [];
	if (role === TSP_ROLES.cleanse) {
		const status = outcome === "Clean" ? "success" : outcome === "Diagnostics remain" || outcome === "No runnable checker" ? "warning" : outcome === "Cancelled" ? "cancelled" : outcome === "Error" ? "error" : null;
		return status ? { command, status, lines: [outcome, ...body].flatMap(text => text.split("\n")) } : null;
	}
	const status = outcome.startsWith("Registered live") ? "success" : outcome === "Not saved" ? "warning" : outcome === "Cancelled" ? "cancelled" : outcome === "Error" ? "error" : null;
	if (!status) return null;
	const saved = status === "success" ? body.find(text => text.startsWith("Saved "))?.slice(6) : undefined;
	if (status === "success" && (!saved || !outcome.includes(saved))) return null;
	return { command, status, lines: [outcome, ...body].flatMap(text => text.split("\n")), ...(saved ? { path: saved } : {}) };
}
