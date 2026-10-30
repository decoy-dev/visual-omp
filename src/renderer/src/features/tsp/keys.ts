export function rawKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">): string | null {
	if (event.metaKey || event.key === "Escape") return null;
	const keys: Record<string, string> = { Enter: "\r", Backspace: "\x7f", Tab: event.shiftKey ? "\x1b[Z" : "\t", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D", Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~", PageUp: "\x1b[5~", PageDown: "\x1b[6~" };
	let value = keys[event.key] ?? (event.key.length === 1 ? event.key : null);
	if (event.ctrlKey && event.key.length === 1) value = String.fromCharCode(event.key.toUpperCase().charCodeAt(0) & 31);
	return value && event.altKey ? `\x1b${value}` : value;
}
