export type ClassValue = string | false | null | undefined;

/** Joins truthy class names with single spaces. */
export function cn(...parts: ClassValue[]): string {
	let out = "";
	for (const part of parts) {
		if (!part) continue;
		out = out ? `${out} ${part}` : part;
	}
	return out;
}
