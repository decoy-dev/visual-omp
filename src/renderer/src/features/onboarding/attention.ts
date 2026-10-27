/** Unopened chat results and the taskbar overlay that counts them (DESIGN §4.22). */
export type UnseenKind = "finished" | "needsInput";
export type UnseenChats = Record<string, UnseenKind>;

export interface ChatVisibility {
	focused: boolean;
	openChatIds: readonly string[];
	shownChatIds: readonly string[];
}

/** Both split halves count as shown, unless a page, overview or expanded side panel covers them. */
export function shownChatIds(view: string, primary: string | null, secondary: string | null, covered = false): string[] {
	return view === "chat" && !covered ? [primary, secondary].filter((id): id is string => id !== null) : [];
}

/** A closed chat is forgotten; a shown chat is read only while the window has focus. */
export function reconcileUnseen(chats: UnseenChats, context: ChatVisibility): UnseenChats {
	let next = chats;
	for (const id of Object.keys(chats)) {
		if (context.openChatIds.includes(id) && !(context.focused && context.shownChatIds.includes(id))) continue;
		if (next === chats) next = { ...chats };
		delete next[id];
	}
	return next;
}

/** The badge tracks results independently of the background-alert preference. */
export function recordUnseen(chats: UnseenChats, chatId: string, kind: UnseenKind, context: ChatVisibility): UnseenChats {
	if (!context.openChatIds.includes(chatId) || (context.focused && context.shownChatIds.includes(chatId))) return chats;
	if (chats[chatId] === kind) return chats;
	return { ...chats, [chatId]: kind };
}

/** Disk data is checked per entry and restricted to the tabs that can be restored. */
export function restoreUnseen(value: unknown, openChatIds: readonly string[]): UnseenChats {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(([id, kind]) => openChatIds.includes(id) && (kind === "finished" || kind === "needsInput")),
	) as UnseenChats;
}

/** Text of the taskbar overlay badge: the count up to nine, then "9+" so it stays legible at 16px. */
export function overlayLabel(count: number): string {
	return count > 9 ? "9+" : String(count);
}

/** `text` cut to at most `max` UTF-16 units with an ellipsis, never splitting a surrogate pair (main rejects longer notifications). */
export function shorten(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}…`;
}

/** Pixel size of the overlay image. Windows draws overlays at 16px per 100% scale, so 32px stays sharp up to 200%. */
export const OVERLAY_SIZE = 32;

/**
 * Draw the overlay badge (a filled circle with `label` centered on it) and return it as a PNG data
 * URL for `win.setOverlayIcon`. Colors and font are CSS values, normally the app's accent tokens.
 */
export function drawOverlayBadge(label: string, style: { fill: string; ink: string; font: string }): string {
	const canvas = document.createElement("canvas");
	canvas.width = OVERLAY_SIZE;
	canvas.height = OVERLAY_SIZE;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("2D canvas unavailable");
	const center = OVERLAY_SIZE / 2;
	context.fillStyle = style.fill;
	context.beginPath();
	context.arc(center, center, center, 0, Math.PI * 2);
	context.fill();
	// Shrink the text until it fits inside the circle with a margin ("9+" is wider than a digit).
	const maxWidth = OVERLAY_SIZE * 0.72;
	let size = OVERLAY_SIZE * 0.62;
	context.font = `700 ${size}px ${style.font}`;
	while (context.measureText(label).width > maxWidth && size > 8) {
		size -= 1;
		context.font = `700 ${size}px ${style.font}`;
	}
	context.fillStyle = style.ink;
	context.textAlign = "center";
	// Center the glyphs' ink box: "middle" uses the em box, which leaves digits sitting high.
	context.textBaseline = "alphabetic";
	const metrics = context.measureText(label);
	const offset = (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
	context.fillText(label, center, center + offset);
	return canvas.toDataURL("image/png");
}
