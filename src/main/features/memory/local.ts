import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { JsonValue, MemoryEntry, MemoryEntryKind, MemoryScope } from "@shared/contracts/memory";
import { writeText } from "../../files";
import { mtimeMs, parseTimestamp, preview } from "./common";
import { type EntryRef, entryId, localScopeKey, scopeId } from "./paths";

/**
 * `local` backend: one folder per project under the memories root. Only `learned.md` lessons are
 * deletable — every other artifact is regenerated wholesale by omp's consolidation pass.
 */

const LEARNED_FILE = "learned.md";
const DOCUMENTS = [
	{ kind: "summary", file: "memory_summary.md", title: "Session-start summary" },
	{ kind: "memory", file: "MEMORY.md", title: "Long-term memory" },
	{ kind: "raw", file: "raw_memories.md", title: "Raw memories" },
] as const satisfies ReadonlyArray<{ kind: MemoryEntryKind; file: string; title: string }>;

export interface LearnedLesson {
	/** Stable key: hash of the trimmed bullet line. */
	key: string;
	/** Zero-based line index in the file. */
	line: number;
	content: string;
	context: string | null;
}

const lessonKey = (line: string): string => createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);

/** Bullets of `learned.md` in file order (newest first), exactly as omp's `learn` tool writes them. */
export function parseLearnedLessons(text: string): LearnedLesson[] {
	const lessons: LearnedLesson[] = [];
	for (const [index, raw] of text.split("\n").entries()) {
		if (!raw.trimStart().startsWith("- ")) continue;
		const body = raw.trim().slice(2);
		const match = /^(.*?) _\(context: (.*)\)_$/.exec(body);
		lessons.push({
			key: lessonKey(raw),
			line: index,
			content: (match?.[1] ?? body).trim(),
			context: match?.[2]?.trim() ?? null,
		});
	}
	return lessons;
}

/**
 * `learned.md` without the lesson `key`, keeping every other line byte-for-byte (omp's own
 * read-modify-write discipline). Null when no lesson has that key.
 */
export function removeLearnedLesson(text: string, key: string): string | null {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const index = lines.findIndex(line => line.trimStart().startsWith("- ") && lessonKey(line) === key);
	if (index === -1) return null;
	lines.splice(index, 1);
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export interface RolloutSummary {
	threadId: string | null;
	/** Epoch seconds of the source session's last update. */
	updatedAt: number | null;
	body: string;
}

/** `rollout_summaries/<thread>[-slug].md`: `thread_id:` / `updated_at:` header, blank line, summary. */
export function parseRolloutSummary(text: string): RolloutSummary {
	const threadMatch = /^thread_id: (.+)$/m.exec(text);
	const updatedMatch = /^updated_at: (\d+)$/m.exec(text);
	const split = text.indexOf("\n\n");
	return {
		threadId: threadMatch?.[1]?.trim() ?? null,
		updatedAt: updatedMatch?.[1] ? Number(updatedMatch[1]) : null,
		body: (split === -1 ? text : text.slice(split + 2)).trim(),
	};
}

const SkillFrontmatter = z.object({ name: z.string().optional(), description: z.string().optional() });

/** `name`/`description` from a generated SKILL.md's YAML frontmatter, when present and valid. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match?.[1]) return {};
	try {
		const parsed = SkillFrontmatter.safeParse(parseYaml(match[1]));
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

async function readOptional(file: string): Promise<string | null> {
	return readFile(file, "utf8").catch(() => null);
}

async function listNames(dir: string, kind: "file" | "dir"): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter(entry => (kind === "dir" ? entry.isDirectory() : entry.isFile()))
		.map(entry => entry.name)
		.sort((a, b) => a.localeCompare(b));
}

type EntryInit = Omit<MemoryEntry, "id" | "scopeId" | "backend" | "preview" | "length" | "deletable"> & {
	item: string;
};

function makeEntry(key: string, init: EntryInit): MemoryEntry {
	const { item, ...rest } = init;
	const ref: EntryRef = { backend: "local", key, kind: init.kind, item };
	return {
		...rest,
		id: entryId(ref),
		scopeId: scopeId(ref),
		backend: "local",
		preview: preview(init.text),
		length: init.text.length,
		deletable: init.kind === "lesson",
	};
}

/** Every entry of one project folder, documents first, then lessons (newest first), rollouts, skills. */
export async function localEntries(root: string, key: string): Promise<MemoryEntry[]> {
	const dir = join(root, key);
	const entries: MemoryEntry[] = [];
	for (const doc of DOCUMENTS) {
		const path = join(dir, doc.file);
		const text = await readOptional(path);
		if (text === null) continue;
		const updatedAt = await mtimeMs(path);
		const { kind, file: item, title } = doc;
		entries.push(makeEntry(key, { kind, item, title, text, path, createdAt: null, updatedAt, tags: [], metadata: {} }));
	}

	const learnedPath = join(dir, LEARNED_FILE);
	const learned = await readOptional(learnedPath);
	if (learned !== null) {
		for (const lesson of parseLearnedLessons(learned)) {
			const metadata: Record<string, JsonValue> = { line: lesson.line + 1 };
			if (lesson.context) metadata.context = lesson.context;
			entries.push(
				makeEntry(key, {
					kind: "lesson",
					item: lesson.key,
					title: "Lesson",
					text: lesson.content,
					path: learnedPath,
					createdAt: null,
					updatedAt: null,
					tags: [],
					metadata,
				}),
			);
		}
	}

	const rolloutDir = join(dir, "rollout_summaries");
	const rollouts: MemoryEntry[] = [];
	for (const name of await listNames(rolloutDir, "file")) {
		if (!name.endsWith(".md")) continue;
		const path = join(rolloutDir, name);
		const text = await readOptional(path);
		if (text === null) continue;
		const summary = parseRolloutSummary(text);
		const stem = name.slice(0, -3);
		const { threadId } = summary;
		const slug = threadId && stem.startsWith(`${threadId}-`) ? stem.slice(threadId.length + 1) : null;
		const metadata: Record<string, JsonValue> = { threadId, slug };
		rollouts.push(
			makeEntry(key, {
				kind: "rollout",
				item: stem,
				title: slug ? slug.replaceAll("_", " ") : (summary.threadId ?? stem),
				text: summary.body,
				path,
				createdAt: null,
				updatedAt: parseTimestamp(summary.updatedAt),
				tags: [],
				metadata,
			}),
		);
	}
	rollouts.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	entries.push(...rollouts);

	const skillsDir = join(dir, "skills");
	for (const name of await listNames(skillsDir, "dir")) {
		const path = join(skillsDir, name, "SKILL.md");
		const text = await readOptional(path);
		if (text === null) continue;
		const frontmatter = parseSkillFrontmatter(text);
		const metadata: Record<string, JsonValue> = {};
		if (frontmatter.description) metadata.description = frontmatter.description;
		entries.push(
			makeEntry(key, {
				kind: "skill",
				item: name,
				title: frontmatter.name ?? name,
				text,
				path,
				createdAt: null,
				updatedAt: await mtimeMs(path),
				tags: [],
				metadata,
			}),
		);
	}
	return entries;
}

/** Project folders under the memories root, with their project directory when it is a known one. */
export async function localScopes(root: string, knownCwds: readonly string[], active: boolean): Promise<MemoryScope[]> {
	const byKey = new Map(knownCwds.map(cwd => [localScopeKey(cwd), cwd]));
	const scopes: MemoryScope[] = [];
	for (const key of await listNames(root, "dir")) {
		if (!/^--.*--$/.test(key)) continue;
		const entries = await localEntries(root, key);
		const cwd = byKey.get(key) ?? null;
		const times = await Promise.all([...new Set(entries.map(entry => entry.path))].map(mtimeMs));
		const updatedAt = Math.max(0, ...times.map(time => time ?? 0));
		scopes.push({
			id: scopeId({ backend: "local", key }),
			backend: "local",
			active,
			name: cwd ? basename(cwd) || cwd : key.slice(2, -2),
			cwd,
			global: false,
			path: join(root, key),
			exists: true,
			entryCount: entries.length,
			updatedAt: updatedAt || null,
		});
	}
	return scopes;
}

/** Remove one `learned.md` lesson; rejects for non-lesson entries or when the lesson is gone. */
export async function deleteLocalEntry(root: string, ref: EntryRef): Promise<void> {
	if (ref.kind !== "lesson") throw new Error(`${ref.kind} entries are regenerated by omp and cannot be deleted`);
	const path = join(root, ref.key, LEARNED_FILE);
	const text = await readOptional(path);
	const next = text === null ? null : removeLearnedLesson(text, ref.item);
	if (next === null) throw new Error("Lesson not found; learned.md changed since it was listed");
	await writeText(path, next);
}
