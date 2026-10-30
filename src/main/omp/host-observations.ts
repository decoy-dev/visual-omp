import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { HostNotice, ProgramStatus } from "@shared/ipc";

/** OSC 7501 replaces the root record. Ignore child records and foreign applications. */
export function parseProgramStatus(body: string): ProgramStatus | null | undefined {
	const fields = new Map<string, string>();
	for (const field of body.split(":")) {
		const at = field.indexOf("=");
		if (at <= 0) return undefined;
		const key = field.slice(0, at);
		if (fields.has(key)) return undefined;
		fields.set(key, field.slice(at + 1));
	}
	if (fields.has("id")) return undefined;
	const app = fields.get("app");
	if (app !== undefined && app !== "omp") return undefined;
	if (fields.get("state") === "clear") return null;
	if (app !== "omp") return undefined;
	const state = fields.get("state");
	if (state !== "idle" && state !== "working" && state !== "blocked" && state !== "done" && state !== "error") return undefined;
	const kind = fields.get("kind");
	if (state === "blocked" && kind !== "permission" && kind !== "question") return undefined;
	const encoded = fields.get("msg");
	let msg: string | undefined;
	if (encoded !== undefined) {
		if (encoded.length > 2732 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
		const bytes = Buffer.from(encoded, "base64");
		try { msg = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
		if (bytes.length > 2048 || /[\x00-\x1f\x7f-\x9f]/.test(msg)) return undefined;
	}
	return { state, ...(state === "blocked" ? { kind: kind as "permission" | "question" } : {}), ...(msg ? { msg } : {}) };
}

/** A prior launch's exit marker must not hide a later crash in a resumed file. */
export async function crashedWithoutExit(file: string | null, spawnedAt: number): Promise<boolean> {
	if (!file) return false;
	const input = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let session = false;
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			let entry: { type?: string; customType?: string; data?: { recordedAt?: string } };
			try { entry = JSON.parse(line); } catch { continue; }
			if (entry === null || typeof entry !== "object") continue;
			if (entry.type === "session") session = true;
			if (entry.type === "custom" && entry.customType === "session_exit" &&
				Date.parse(entry.data?.recordedAt ?? "") >= spawnedAt) return false;
		}
		return session;
	} catch { return false; }
	finally { lines.close(); input.destroy(); }
}

/**
 * The chat's latest recap. omp journals every idle recap outside JSONL; visual-omp shows only the newest one, so
 * older journal rows stay in the journal. Opens omp's store read-only, without migrations.
 */
export function readSessionRecaps(file: string, sessionId: string): HostNotice[] | null {
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
		// Newest first, stopping at the first row that is non-blank by JavaScript's trim, without loading the journal.
		for (const row of db.prepare("SELECT id, recap, created_at FROM session_recaps WHERE session_id = ? ORDER BY id DESC").iterate(sessionId)) {
			if (typeof row.id !== "number" || typeof row.recap !== "string" || !row.recap.trim() || typeof row.created_at !== "number") continue;
			return [{ id: `recap:${sessionId}:${row.id}`, kind: "recap" as const, text: row.recap, timestamp: row.created_at * 1000 }];
		}
		return [];
	} catch { return null; }
	finally { db?.close(); }
}

/** Only omp's startup model substitutions, never arbitrary transcript or editor text. */
export function startupModelWarning(line: string): string | null {
	const text = line.trim().replace(/^(?:[!⚠▲]\s*|Warning:\s*)/, "");
	return /^(?:Default model .+ (?:is unavailable|not found)|Could not restore model .+|(?:Dictation|dictation|STT|stt) model .+ (?:unavailable|not found)|Configured (?:default|dictation) model .+)/.test(text) ? text : null;
}

/** Text components wrap at word boundaries, independently of terminal auto-wrap. */
export function startupModelWarnings(lines: readonly string[]): string[] {
	const warnings: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const start = lines[index] ?? "";
		if (!/^\s*Warning:\s*(?:Default model|Could not restore model|Dictation model)\b/.test(start)) continue;
		let text = start.trim();
		while (index + 1 < lines.length) {
			const next = lines[index + 1] ?? "";
			if (!/^\s+\S/.test(next) || /^\s*(?:Warning:|[╭╰│π])/.test(next)) break;
			text += ` ${next.trim()}`;
			index++;
		}
		const warning = startupModelWarning(text);
		if (warning) warnings.push(warning.slice(0, 1200));
	}
	return warnings;
}

/** Read only the two worktree confirmations, preserving omp's risk description. */
export function worktreeConfirmation(lines: readonly string[]): { title: string; detail: string; selectedYes: boolean } | null {
	const top = lines.findLastIndex(line => /^\s*╭─ (?:Create a worktree for this session\?|Remove worktree\?) ─*╮\s*$/.test(line));
	if (top < 0) return null;
	const title = /╭─ (.+?) ─*╮/.exec(lines[top]!)?.[1];
	const bottom = lines.findIndex((line, index) => index > top && /^\s*╰─+╯\s*$/.test(line));
	if (!title || bottom < 0) return null;
	const body = lines.slice(top + 1, bottom).map(line => /^\s*│ ?(.*?) ?│\s*$/.exec(line)?.[1]?.trim() ?? "");
	const yes = body.findIndex(line => /^(?:❯ )?Yes$/.test(line));
	const no = body.findIndex(line => /^(?:❯ )?No$/.test(line));
	if (yes < 0 || no < 0 || !body.some(line => /navigate.*select.*cancel/.test(line))) return null;
	return { title, detail: body.slice(0, yes).filter(Boolean).join("\n"), selectedYes: body[yes] === "❯ Yes" };
}
