/**
 * Background attention (DESIGN §4.22): the chats that finished a turn or started waiting for an
 * answer while the window was in the background, and the taskbar overlay badge that counts them.
 */

/** What a chat event did to the unseen set. */
export type UnseenResult =
	/** The window has focus or the notifications switch is off: no notification, badge or alert. */
	| "ignored"
	/** The chat was already unseen: notify again, but the count and the one-time alert stay as they are. */
	| "repeat"
	/** The chat became unseen: the count grew, so bounce the Dock icon or flash the taskbar button once. */
	| "new";

/** Counts chats, so a chat that finishes twice before the user looks counts once. */
export class UnseenChats {
	#chats = new Set<string>();

	get count(): number {
		return this.#chats.size;
	}

	/** Record that `chatId` finished or needs an answer. */
	record(chatId: string, context: { focused: boolean; enabled: boolean }): UnseenResult {
		if (context.focused || !context.enabled) return "ignored";
		if (this.#chats.has(chatId)) return "repeat";
		this.#chats.add(chatId);
		return "new";
	}

	/** Forget every chat (the window gained focus or the switch went off). True when the count changed. */
	clear(): boolean {
		if (this.#chats.size === 0) return false;
		this.#chats.clear();
		return true;
	}
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
