/** Line comments on the Diff pane and the single chat message they turn into. */

export interface LineComment {
	id: string;
	/** Repo-relative path. */
	path: string;
	/** 1-based line in the new file, or in the old file for removed lines. */
	line: number;
	side: "new" | "old";
	/** The code on that line, quoted so omp sees what the comment is about. */
	excerpt: string;
	text: string;
}

/** One message for omp: numbered comments with `path:line` references and the quoted line. */
export function composeReviewMessage(comments: readonly LineComment[]): string {
	const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
	const items = sorted.map((comment, index) => {
		const where = `${comment.path}:${comment.line}${comment.side === "old" ? " (removed line)" : ""}`;
		const quote = comment.excerpt.trim() ? `\n   > ${comment.excerpt.trim()}` : "";
		const body = comment.text.trim().replace(/\n/g, "\n   ");
		return `${index + 1}. \`${where}\`${quote}\n   ${body}`;
	});
	const heading =
		sorted.length === 1
			? "I reviewed the current changes and left a comment. Please address it:"
			: `I reviewed the current changes and left ${sorted.length} comments. Please address each one:`;
	return `${heading}\n\n${items.join("\n\n")}`;
}
