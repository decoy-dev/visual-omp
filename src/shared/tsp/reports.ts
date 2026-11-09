import type { TspNode, TspText } from "../tsp";
import { TSP_ROLES } from "./roles";

const plain = (value: TspText | undefined): string => typeof value === "string" ? value : value?.filter(span => !span.s?.split(" ").some(token => token === "hide" || token === "icon")).map(span => span.t).join("") ?? "";
export interface CommandReport { title: string; lines: string[]; markdown: boolean; close: { id: string; act: "close" } }

/** Only read-only text and its one declared Close action can transfer to a Result row. */
export function commandReport(node: TspNode): CommandReport | null {
	if (node.k !== "overlay" || node.p?.role !== TSP_ROLES.report || node.p.hidden) return null;
	if (Array.isArray(node.p.head) && node.p.head.some(span => span.href)) return null;
	const title = plain(node.p.head);
	const bodies: TspNode[] = [];
	const closes: string[] = [];
	let hasMarkdown = false;
	let hasPlainText = false;
	const read = (current: TspNode, inBody: boolean): string[] | null => {
		if (current.p?.hidden) return [];
		const body = current.p?.role === TSP_ROLES.reportBody;
		if (body) bodies.push(current);
		const actions = current.p?.actions;
		if (current.k === "button") {
			if (inBody || !actions || Array.isArray(actions) || actions.click !== "close" || actions.dblclick || actions.menu?.length || current.p?.disabled || current.p?.busy || current.p?.href || current.p?.hovercard || current.c?.length) return null;
			closes.push(current.id); return [];
		}
		if (actions || current.p?.href || current.p?.hovercard) return null;
		if (!["overlay", "col", "row", "text", "md", "spacer", "rule"].includes(current.k)) return null;
		if (current.k === "md" && current.p?.stream) return null;
		let own = "";
		if (current.k === "text") own = plain(current.p?.spans ?? current.p?.text);
		else if (current.k === "md") own = current.p?.text ?? "";
		else if (current.k === "rule") own = plain(current.p?.label);
		if (own && !inBody && !body) return null;
		if (current.k === "text" && current.p?.spans?.some(span => span.href)) return null;
		if (current.k === "rule" && Array.isArray(current.p?.label) && current.p.label.some(span => span.href)) return null;
		if (own && (inBody || body)) {
			if (current.k === "md") hasMarkdown = true;
			else hasPlainText = true;
		}
		const lines: string[] = own && (inBody || body) ? own.split("\n") : [];
		for (const child of current.c ?? []) {
			const content = read(child, inBody || body);
			if (content === null) return null;
			lines.push(...content);
		}
		return lines;
	};
	const lines = read(node, false);
	return title.trim() && lines && bodies.length === 1 && closes.length === 1
		? { title, lines, markdown: hasMarkdown && !hasPlainText, close: { id: closes[0]!, act: "close" } } : null;
}
