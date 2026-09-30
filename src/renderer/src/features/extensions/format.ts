/** Pure formatting helpers shared by the extensions sheets. */

/** `$1.24`; sub-cent amounts show as `<$0.01`, zero as `$0.00`. */
export function formatUsd(value: number): string {
	if (value > 0 && value < 0.005) return "<$0.01";
	if (value >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
	return `$${value.toFixed(2)}`;
}

/** `950`, `12.4K`, `1.2M`, `3.4B`. */
export function formatCount(value: number): string {
	const abs = Math.abs(value);
	const units: [number, string][] = [
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "K"],
	];
	for (const [size, suffix] of units) {
		if (abs >= size) {
			const scaled = value / size;
			return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
		}
	}
	return String(Math.round(value));
}

/** `45s`, `12m`, `1h 12m`, `3d 4h`. Negative durations clamp to zero. */
export function formatDuration(ms: number): string {
	const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
	if (totalMinutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

/** Relative age for lists (`5 min. ago`, `yesterday`), then a short date after a week. Localized by `Intl`. */
export function formatAge(at: number, now: number = Date.now(), locale = "en"): string {
	const diff = now - at;
	const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
	if (diff < 60_000) return relative.format(0, "second");
	if (diff < 3_600_000) return relative.format(-Math.floor(diff / 60_000), "minute");
	if (diff < 86_400_000) return relative.format(-Math.floor(diff / 3_600_000), "hour");
	if (diff < 7 * 86_400_000) return relative.format(-Math.floor(diff / 86_400_000), "day");
	return new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}

/** One CSV field per RFC 4180: quoted when it holds a comma, quote or line break. */
function csvField(value: string | number): string {
	const text = String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
	return [header, ...rows].map(row => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/**
 * Error text for the UI. Electron wraps handler rejections as
 * `Error invoking remote method 'x': Error: <message>`; users only need `<message>`.
 */
export function errorText(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/, "");
}

/**
 * Split a typed command line into argv, honouring single/double quotes and backslash escapes
 * (so `npx -y "@scope/server" ~/My\ Files` works as expected).
 */
export function splitCommandLine(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let pending = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] ?? "";
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			pending = true;
		} else if (ch === "\\" && i + 1 < line.length) {
			current += line[++i];
			pending = true;
		} else if (/\s/.test(ch)) {
			if (pending || current) out.push(current);
			current = "";
			pending = false;
		} else {
			current += ch;
		}
	}
	if (pending || current) out.push(current);
	return out;
}

/** Inverse of {@link splitCommandLine}: quote only the parts that need it. */
export function joinCommandLine(argv: readonly string[]): string {
	return argv.map(arg => (arg === "" ? '""' : /[\s"'\\]/.test(arg) ? `"${arg.replace(/(["\\])/g, "\\$1")}"` : arg)).join(" ");
}

/**
 * Order two version strings by their numeric dot parts (`1.10.0` > `1.9.2`, leading `v` ignored).
 * A pre-release (`1.2.0-beta`) sorts before its release. Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core = "", pre] = v.trim().replace(/^v/i, "").split("-", 2);
		return { parts: core.split(".").map(part => Number.parseInt(part, 10) || 0), pre: pre ?? null };
	};
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i++) {
		const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
		if (diff !== 0) return diff;
	}
	if (left.pre === right.pre) return 0;
	if (left.pre === null) return 1;
	if (right.pre === null) return -1;
	return left.pre < right.pre ? -1 : 1;
}
