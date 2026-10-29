export interface ChangelogSection {
	version: string;
	date: string | null;
	body: string;
}

/** Keep each version's Markdown intact, including summary categories and detailed subheadings. */
export function parseChangelog(source: string): ChangelogSection[] {
	const sections: ChangelogSection[] = [];
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	let current: { version: string; date: string | null; start: number } | null = null;
	let fence: { marker: string; length: number } | null = null;
	const finish = (end: number) => {
		if (current && current.version !== "Unreleased") {
			sections.push({ version: current.version.replace(/^v/, ""), date: current.date, body: lines.slice(current.start, end).join("\n").trim() });
		}
	};
	for (const [index, line] of lines.entries()) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (marker) {
			const run = marker[1]!;
			if (!fence) fence = { marker: run[0]!, length: run.length };
			else if (run[0] === fence.marker && run.length >= fence.length && !marker[2]?.trim()) fence = null;
			continue;
		}
		if (fence) continue;
		const heading = /^## \[([^\]]+)\](?:[ \t]+-[ \t]+(\d{4}-\d{2}-\d{2}))?[ \t]*$/.exec(line);
		if (!heading) continue;
		finish(index);
		current = { version: heading[1]!, date: heading[2] ?? null, start: index + 1 };
	}
	finish(lines.length);
	return sections;
}
