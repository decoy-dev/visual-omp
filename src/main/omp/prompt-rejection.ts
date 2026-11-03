import type { TspNode } from "../../shared/tsp";
import { commandNodeText } from "../../shared/tsp/command-result";
import { TSP_ROLES } from "../../shared/tsp/roles";
import { liveSurfaces, type TspSurfaces } from "../../shared/tsp/view-state";

export interface PromptRejection {
	/** Compare before and after submission; a current diagnostic alone is not proof of rejection. */
	key: string;
	/** omp's complete message, without the classic renderer's presentation-only Error label. */
	text: string;
	kind: "preflight" | "resume";
}

const GUIDANCE = "Use /login, set an API key environment variable, or create ";
const MODEL_GUIDANCE = "Then use /model to select a model.";

function rejectionKind(text: string): PromptRejection["kind"] | null {
	// agent-session.resume currently omits the period; accept only these complete messages.
	if (text === "Nothing to resume" || text === "Nothing to resume.") return "resume";
	const paragraphs = text.split("\n\n");
	if (!paragraphs[1]?.startsWith(GUIDANCE)) return null;
	const path = paragraphs[1].slice(GUIDANCE.length);
	if (!path.trim() || /[\r\n\x00-\x1f]/.test(path)) return null;
	if (paragraphs[0] === "No model selected." && paragraphs.length === 3 && paragraphs[2] === MODEL_GUIDANCE) return "preflight";
	if (/^No API key found for [^\s\r\n]+\.$/.test(paragraphs[0] ?? "") && paragraphs.length === 2) return "preflight";
	return null;
}

/** Current, visible error notices only. The caller supplies generation-scoped surfaces. */
export function semanticPromptRejections(surfaces: TspSurfaces): PromptRejection[] {
	const result: PromptRejection[] = [];
	const visit = (node: TspNode, surfaceId: string): void => {
		if (node.p?.hidden) return;
		if (node.p?.role === TSP_ROLES.noticeError) {
			const text = commandNodeText(node);
			const kind = rejectionKind(text);
			if (kind) result.push({ key: JSON.stringify([surfaceId, node.id, text]), text, kind });
			return;
		}
		for (const child of node.c ?? []) visit(child, surfaceId);
	};
	for (const surface of liveSurfaces(surfaces)) visit(surface.document, surface.open.id);
	return result;
}

interface EditorBoundary { top: number; contentWidth: number | null }
export interface ClassicPromptAttachments { symbol: string; count: number }

/** Only the current submission's numbered attachment previews may separate its error from the editor. */
function beforeAttachmentPreviews(lines: readonly string[], end: number, attachments?: ClassicPromptAttachments): number {
	if (!attachments || !Number.isSafeInteger(attachments.count) || attachments.count < 1) return end;
	let cursor = end;
	for (let index = attachments.count; index >= 1; index--) {
		while (cursor > 0 && !lines[cursor - 1]?.trim()) cursor--;
		if (!/^\s*╰─\s+[1-9]\d*x[1-9]\d*\s+─+╯\s*$/u.test(lines[cursor - 1] ?? "")) return end;
		let top = cursor - 2;
		while (top >= 0 && /^\s*│.*│\s*$/u.test(lines[top] ?? "")) top--;
		const title = /^\s*╭─+\s*(.*?)\s*─+╮\s*$/u.exec(lines[top] ?? "")?.[1];
		if (title !== `${attachments.symbol} #${index}`) return end;
		cursor = top;
	}
	return cursor;
}


/** Same pinned status and adjacent composer context used by the classic screen readers. */
function editorBoundary(lines: readonly string[]): EditorBoundary | null {
	for (let top = lines.length - 1; top >= 0; top--) {
		const status = lines[top] ?? "";
		const framed = /^\s*(?:[╭┌]─+.*[╮┐]|\+-+.*\+)\s*$/u.test(status);
		const body = status.replace(/^\s*(?:[╭┌]─+|\+-+)\s*/u, "").trimStart();
		// A model-less narrow status retains its gauge; ordinary dialog borders do not qualify.
		if (!/^(?:π\s+[▶>\ue0b0]|🗑.*[▶>\ue0b0][─-])/u.test(body)) continue;
		let bottom = top + 1;
		if (framed) while (/^│.*[│█]\s*$/u.test(lines[bottom] ?? "")) bottom++;
		const last = lines[bottom] ?? "";
		if (framed ? !/^╰─(?:\s|$).*╯\s*$/u.test(last) : !/^╰─(?:\s|$)/u.test(last)) continue;
		// Boxed input is pinned in production. Its bottom border gives Text's cols - 2 width.
		return { top, contentWidth: framed ? Array.from(last.trimEnd()).length - 2 : null };
	}
	return null;
}

function unwrapParagraph(rows: readonly string[], contentWidth: number | null): string {
	let text = "";
	let previous = "";
	for (const row of rows) {
		// TranscriptNotice.line uses Text(..., 1, 0), including on continuation rows.
		const next = row.replace(/^ /, "").trimEnd();
		// Text moves an overlong token to its own row, then hard-splits it. Do not add spaces to paths.
		const hardWrap = contentWidth !== null && Array.from(previous).length === contentWidth && !/\s/.test(previous);
		text += (text && !hardWrap ? " " : "") + next;
		previous = next;
	}
	return text;
}

function insideCodeFence(lines: readonly string[], end: number): boolean {
	let fence: string | undefined;
	for (let index = 0; index < end; index++) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(lines[index] ?? "")?.[1];
		if (!marker) continue;
		if (!fence) fence = marker;
		else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
	}
	return fence !== undefined;
}

/**
 * The bottommost unframed Error block immediately above verified pinned editor chrome.
 * Input is physical headless-buffer lines, with left padding retained. Keys deliberately stay
 * unchanged for repeated identical errors; callers must also use their trusted input observation.
 */
export function classicPromptRejections(lines: readonly string[], attachments?: ClassicPromptAttachments): PromptRejection[] {
	const editor = editorBoundary(lines);
	if (!editor) return [];
	let end = beforeAttachmentPreviews(lines, editor.top, attachments);
	while (end > 0 && !lines[end - 1]?.trim()) end--;
	let start = end - 1;
	for (; start >= 0; start--) {
		const row = lines[start] ?? "";
		if (/^ ?Error: /.test(row)) break;
		// Never look through a transcript frame, quote, code fence, or different notice.
		if (/^\s*(?:[│┃╭╰┌└┏┗>]|```|~~~|Warning:)/u.test(row)) return [];
	}
	if (start < 0 || start > 0 && lines[start - 1]?.trim() || insideCodeFence(lines, start)) return [];
	const paragraphs: string[] = [];
	let rows: string[] = [];
	for (let index = start; index < end; index++) {
		const row = lines[index] ?? "";
		if (!row.trim()) {
			if (rows.length) { paragraphs.push(unwrapParagraph(rows, editor.contentWidth)); rows = []; }
			else return [];
		} else {
			if (!/^ ?\S/.test(row) || /^\s*[│┃>]/u.test(row)) return [];
			rows.push(row);
		}
	}
	if (rows.length) paragraphs.push(unwrapParagraph(rows, editor.contentWidth));
	const text = paragraphs.join("\n\n").replace(/^Error: /, "");
	const kind = rejectionKind(text);
	return kind ? [{ key: JSON.stringify([text]), text, kind }] : [];
}
