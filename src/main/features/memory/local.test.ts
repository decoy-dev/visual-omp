import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLearnedLessons, parseRolloutSummary, parseSkillFrontmatter, removeLearnedLesson } from "./local";

/** Files written by omp's `learn` tool / consolidation pipeline in a throwaway agent dir. */
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8").replace(/\r\n/g, "\n");

describe("learned.md", () => {
	const learned = fixture("learned.md");

	it("parses bullets newest first and splits the context suffix", () => {
		const lessons = parseLearnedLessons(learned);
		expect(lessons.map(lesson => [lesson.content, lesson.context])).toEqual([
			["Never edit package.json without approval.", null],
			["Use Promise.withResolvers instead of new Promise.", "project rule"],
		]);
		expect(new Set(lessons.map(lesson => lesson.key)).size).toBe(2);
	});

	it("parses CRLF bullets and removes one without changing the line ending", () => {
		const text = "- keep this lesson\r\n- remove this lesson\r\n";
		const [lesson] = parseLearnedLessons(text);
		expect(lesson?.content).toBe("keep this lesson");
		expect(removeLearnedLesson(text, lesson?.key ?? "")).toBe("- remove this lesson\r\n");
	});

	it("removes exactly one lesson and keeps hand-written lines", () => {
		const text = `# Lessons\n\nKeep these short.\n${learned}`;
		const [first, second] = parseLearnedLessons(text);
		expect(removeLearnedLesson(text, first?.key ?? "")).toBe(
			"# Lessons\n\nKeep these short.\n- Use Promise.withResolvers instead of new Promise. _(context: project rule)_\n",
		);
		const onlyHeading = removeLearnedLesson(removeLearnedLesson(text, first?.key ?? "") ?? "", second?.key ?? "");
		expect(onlyHeading).toBe("# Lessons\n\nKeep these short.\n");
	});

	it("returns null for an unknown key and empties a file with one lesson", () => {
		expect(removeLearnedLesson(learned, "0000000000000000")).toBeNull();
		const single = "- only lesson\n";
		expect(removeLearnedLesson(single, parseLearnedLessons(single)[0]?.key ?? "")).toBe("");
	});
});

describe("consolidation artifacts", () => {
	it("parses a rollout summary header and body", () => {
		expect(parseRolloutSummary(fixture("rollout-summary.md"))).toEqual({
			threadId: "019a-thread-1",
			updatedAt: 1790700000,
			body: "Session set up IPC contracts and zod parsers.",
		});
	});

	it("parses CRLF rollout summaries", () => {
		expect(parseRolloutSummary("thread_id: 019a-thread-1\r\nupdated_at: 1790700000\r\n\r\nSummary body.\r\n")).toEqual({
			threadId: "019a-thread-1",
			updatedAt: 1790700000,
			body: "Summary body.",
		});
	});

	it("reads generated skill frontmatter and tolerates its absence", () => {
		expect(parseSkillFrontmatter(fixture("SKILL.md"))).toEqual({
			name: "run-parser-tests",
			description: "Run vitest for parser modules",
		});
		expect(parseSkillFrontmatter("# No frontmatter\n")).toEqual({});
		expect(parseSkillFrontmatter("---\n: [broken\n---\n")).toEqual({});
	});
});
