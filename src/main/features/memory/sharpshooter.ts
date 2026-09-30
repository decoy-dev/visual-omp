import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { JsonValue, MemoryEntry, MemoryScope } from "@shared/contracts/memory";
import { mtimeMs, preview } from "./common";
import { type EntryRef, entryId, projectBankSegment, scopeId } from "./paths";

/**
 * `sharpshooter` backend: `<memories>/sharpshooter/<bank>/` holds three consolidated decision files
 * and a queue of per-session decision deltas awaiting the next consolidation pass. Queued deltas are
 * deletable (omp's consolidator tolerates vanished queue files); decision files are rewritten
 * wholesale by consolidation and stay read-only.
 */

const DECISION_FILES = {
	"architecture.md": "Architecture decisions",
	"product.md": "Product decisions",
	"style.md": "Style decisions",
} as const;
const SESSION_DIR = /^[A-Za-z0-9_-]+$/;
const QUEUE_FILE = /^[0-9a-z]+-[0-9a-z]+\.json$/;

export const SharpshooterDeltaSchema = z.object({
	v: z.literal(1),
	kind: z.enum([
		"architecture_decision",
		"product_decision",
		"style_decision",
		"constraint",
		"rejected_approach",
		"correction",
	]),
	statement: z.string(),
	rejectedAlternative: z.string().optional(),
	rationale: z.string().optional(),
	source: z.enum(["explicit_user", "contextual_resolution"]),
	evidence: z.string(),
	friction: z.object({ corrective: z.boolean(), regression: z.boolean(), subtle: z.boolean() }),
	sessionId: z.string(),
	ts: z.number(),
});

export type SharpshooterDelta = z.infer<typeof SharpshooterDeltaSchema>;

export const SharpshooterStateSchema = z.object({
	v: z.literal(1),
	lastConsolidatedAt: z.number(),
	lastResult: z.object({ at: z.number(), sessions: z.number(), deltas: z.number(), model: z.string() }).optional(),
	lastError: z.object({ at: z.number(), message: z.string() }).optional(),
});

/** Parse one queued delta file; null for torn/foreign JSON (omp skips those too). */
export function parseSharpshooterDelta(text: string): SharpshooterDelta | null {
	try {
		const parsed = SharpshooterDeltaSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Human title of a delta kind, e.g. `architecture_decision` → `Architecture decision`. */
export function deltaTitle(kind: SharpshooterDelta["kind"]): string {
	const words = kind.replaceAll("_", " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Tags of a delta: kind, provenance and the friction flags that are set. */
export function deltaTags(delta: SharpshooterDelta): string[] {
	const tags: string[] = [delta.kind, delta.source];
	for (const flag of ["corrective", "regression", "subtle"] as const) if (delta.friction[flag]) tags.push(flag);
	return tags;
}

type EntryFields = Omit<MemoryEntry, "id" | "scopeId" | "backend" | "kind" | "preview" | "length" | "deletable">;

function makeEntry(key: string, kind: "decisions" | "delta", item: string, rest: EntryFields): MemoryEntry {
	const ref: EntryRef = { backend: "sharpshooter", key, kind, item };
	return {
		...rest,
		id: entryId(ref),
		scopeId: scopeId(ref),
		backend: "sharpshooter",
		kind,
		preview: preview(rest.text),
		length: rest.text.length,
		deletable: kind === "delta",
	};
}

async function readState(bankDir: string): Promise<z.infer<typeof SharpshooterStateSchema> | null> {
	try {
		const parsed = SharpshooterStateSchema.safeParse(JSON.parse(await readFile(join(bankDir, "state.json"), "utf8")));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Decision files (injection order) followed by queued deltas, newest first. */
export async function sharpshooterEntries(root: string, key: string): Promise<MemoryEntry[]> {
	const bankDir = join(root, key);
	const entries: MemoryEntry[] = [];
	for (const [file, title] of Object.entries(DECISION_FILES)) {
		const path = join(bankDir, file);
		const text = await readFile(path, "utf8").catch(() => null);
		if (text === null) continue;
		const updatedAt = await mtimeMs(path);
		const fields = { title, text, path, createdAt: null, updatedAt, tags: [], metadata: {} };
		entries.push(makeEntry(key, "decisions", file, fields));
	}
	const queueDir = join(bankDir, "queue");
	const deltas: MemoryEntry[] = [];
	for (const session of await readdir(queueDir, { withFileTypes: true }).catch(() => [])) {
		if (!session.isDirectory() || !SESSION_DIR.test(session.name)) continue;
		for (const name of await readdir(join(queueDir, session.name)).catch(() => [])) {
			if (!QUEUE_FILE.test(name)) continue;
			const path = join(queueDir, session.name, name);
			const delta = parseSharpshooterDelta(await readFile(path, "utf8").catch(() => ""));
			if (!delta) continue;
			const metadata: Record<string, JsonValue> = {
				sessionId: delta.sessionId,
				source: delta.source,
				evidence: delta.evidence,
			};
			if (delta.rationale) metadata.rationale = delta.rationale;
			if (delta.rejectedAlternative) metadata.rejectedAlternative = delta.rejectedAlternative;
			metadata.friction = delta.friction;
			deltas.push(
				makeEntry(key, "delta", `${session.name}/${name}`, {
					title: deltaTitle(delta.kind),
					text: delta.statement,
					path,
					createdAt: delta.ts,
					updatedAt: null,
					tags: deltaTags(delta),
					metadata,
				}),
			);
		}
	}
	deltas.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	entries.push(...deltas);
	return entries;
}

/** Bank folders, with their project directory when it is a known one. */
export async function sharpshooterScopes(root: string, knownCwds: readonly string[], active: boolean): Promise<MemoryScope[]> {
	const byBank = new Map(knownCwds.map(cwd => [projectBankSegment(cwd), cwd]));
	const scopes: MemoryScope[] = [];
	for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (!dir.isDirectory() || !SESSION_DIR.test(dir.name)) continue;
		const key = dir.name;
		const entries = await sharpshooterEntries(root, key);
		const state = await readState(join(root, key));
		const times = entries.map(entry => entry.updatedAt ?? entry.createdAt ?? 0);
		const updatedAt = Math.max(0, state?.lastConsolidatedAt ?? 0, ...times);
		const cwd = byBank.get(key) ?? null;
		scopes.push({
			id: scopeId({ backend: "sharpshooter", key }),
			backend: "sharpshooter",
			active,
			// Bank ids are `<basename>-<hash>`; without a known project the basename is the best label.
			name: cwd ? basename(cwd) || cwd : key.replace(/-[0-9a-z]+$/, ""),
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

/** Drop one queued delta before consolidation applies it. */
export async function deleteSharpshooterEntry(root: string, ref: EntryRef): Promise<void> {
	if (ref.kind !== "delta") throw new Error("Decision files are rewritten by omp's consolidation and cannot be deleted");
	const [session, file, ...rest] = ref.item.split("/");
	if (!session || !file || rest.length > 0 || !SESSION_DIR.test(session) || !QUEUE_FILE.test(file)) {
		throw new Error(`Invalid sharpshooter delta id: ${ref.item}`);
	}
	const path = join(root, ref.key, "queue", session, file);
	if (!(await readFile(path, "utf8").then(parseSharpshooterDelta, () => null))) throw new Error("Queued decision not found");
	await rm(path);
}
