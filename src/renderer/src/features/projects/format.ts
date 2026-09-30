import { BookOpen, Brush, Bug, FlaskConical, type LucideIcon, Palette, Sparkles } from "lucide-react";

/** DESIGN §8.3 example prompts; `label` and `text` are keys under `projects:prompts.<id>`. */
export const EXAMPLE_PROMPTS: readonly { id: string; icon: LucideIcon }[] = [
	{ id: "fix", icon: Bug },
	{ id: "build", icon: Sparkles },
	{ id: "explain", icon: BookOpen },
	{ id: "cleanup", icon: Brush },
	{ id: "tests", icon: FlaskConical },
	{ id: "mobile", icon: Palette },
];

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$4.10"; tiny non-zero amounts read "<$0.01" instead of a misleading "$0.00". */
export function formatUsd(value: number): string {
	return value > 0 && value < 0.005 ? "<$0.01" : dollars.format(value);
}

/** "812 B", "1.2 KB", "3.4 MB" (UTF-8 bytes of text). */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Last path segment, for showing a folder by name. */
export function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
