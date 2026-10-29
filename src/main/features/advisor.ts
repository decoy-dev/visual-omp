import { readFile, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isCollection, parseDocument, visit } from "yaml";
import { AdvisorDocSchema, AdvisorScopeSchema, type AdvisorDoc, type AdvisorFile, type AdvisorScope } from "@shared/contracts/advisor";
import { handle } from "../ipc";
import { pathExists, writeText } from "../files";
import { runGit } from "../git/run";
import { ompAgentDir } from "../omp/config-file";

/** Mirrors omp's configure editor: repo root for project scope, active agent dir for user scope. */
async function advisorPath(cwd: string, scope: AdvisorScope): Promise<string> {
	AdvisorScopeSchema.parse(scope);
	let dir: string;
	if (scope === "user") dir = await ompAgentDir();
	else {
		const root = await runGit(["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 5000 }).catch(() => null);
		dir = root?.code === 0 && root.stdout.trim() ? root.stdout.trim() : cwd;
	}
	const yml = join(dir, "WATCHDOG.yml");
	const yaml = join(dir, "WATCHDOG.yaml");
	return !(await pathExists(yml)) && await pathExists(yaml) ? yaml : yml;
}

export function parseAdvisorDocument(content: string): AdvisorDoc {
	const document = parseDocument(content);
	if (document.errors.length) throw new Error(document.errors.map(error => error.message).join("; "));
	const value: unknown = document.toJSON();
	return AdvisorDocSchema.parse(value === null ? { advisors: [] } : typeof value === "object" && !Array.isArray(value) ? { advisors: [], ...value } : value);
}

export async function readAdvisorFile(file: string): Promise<AdvisorFile> {
	let content: string;
	try { content = await readFile(file, "utf8"); }
	catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { file, content: "", exists: false, doc: { advisors: [] } };
		throw error;
	}
	try { return { file, content, exists: true, doc: parseAdvisorDocument(content) }; }
	catch (error) { return { file, content, exists: true, doc: { advisors: [] }, error: String(error) }; }
}

const applications = new Map<string, { file: AdvisorFile; prepared: AdvisorFile; target: string }>();
const applyingTargets = new Set<string>();

/** The fields omp's 18.14 canonical serializer retains, used only to recognize its second write. */
function appliedProjection(doc: AdvisorDoc): Record<string, unknown> {
	const instruction = (value: string) => value.includes("\n") && !value.split("\n").some(line => /^[ \t]/.test(line)) ? value.replaceAll("\r\n", "\n") : value;
	const result: Record<string, unknown> = {};
	if (doc.instructions?.trim()) result.instructions = instruction(doc.instructions);
	if (doc.maxNotesPerUpdate !== undefined) result.maxNotesPerUpdate = Math.trunc(doc.maxNotesPerUpdate);
	if (doc.advisors.length) result.advisors = doc.advisors.map(advisor => {
		const entry: Record<string, unknown> = { name: advisor.name };
		if (advisor.model?.trim()) entry.model = advisor.model;
		if (advisor.instructions?.trim()) entry.instructions = instruction(advisor.instructions);
		for (const key of ["tools", "reviewMode", "enabled", "reviewInterval", "scope", "includeReasoning"] as const) if (advisor[key] !== undefined) entry[key] = advisor[key];
		if (advisor.syncBacklog !== undefined) entry.syncBacklog = String(advisor.syncBacklog);
		if (advisor.maxNotesPerUpdate !== undefined) entry.maxNotesPerUpdate = Math.trunc(advisor.maxNotesPerUpdate);
		return entry;
	});
	return result;
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? "undefined";
}

export async function beginAdvisorApply(file: string): Promise<string> {
	const target = await realpath(file).catch(() => file);
	await edits.get(target);
	if (applyingTargets.has(target)) throw new Error("The advisor configuration is already being applied.");
	applyingTargets.add(target);
	try {
		const baseline = await readAdvisorFile(file);
		if (baseline.error) throw new Error(baseline.error);
		const token = randomUUID();
		let prepared = baseline;
		if (baseline.doc.advisors.length === 1 && baseline.doc.advisors[0]?.name === "default" && baseline.doc.advisors[0].reviewMode === undefined) {
			// omp treats a lone default row as synthetic. Materialize its existing turn cadence for the apply only.
			const document = parseDocument(baseline.content);
			document.setIn(["advisors", 0, "reviewMode"], "turn");
			const current = await readAdvisorFile(target);
			if (current.content !== baseline.content || current.exists !== baseline.exists) throw new Error("WATCHDOG.yml changed before applying. Reload it before editing.");
			await writeText(target, document.toString());
			prepared = await readAdvisorFile(file);
		}
		applications.set(token, { file: baseline, prepared, target });
		return token;
	} catch (error) { applyingTargets.delete(target); throw error; }
}

/** Restore preserved bytes only when omp's known serialization explains the complete intervening document. */
export async function finishAdvisorApply(token: string): Promise<AdvisorFile> {
	const transaction = applications.get(token);
	if (!transaction) throw new Error("The advisor application transaction is unavailable.");
	try {
		const current = await readAdvisorFile(transaction.target);
		if (current.content !== transaction.file.content || current.exists !== transaction.file.exists) {
			const document = parseDocument(current.content);
			let comments = Boolean(document.comment || document.commentBefore);
			visit(document, (_key, node) => {
				if (node && typeof node === "object" && ("comment" in node && node.comment || "commentBefore" in node && node.commentBefore)) comments = true;
			});
			const actual: unknown = document.toJSON() ?? {};
			const ownPreparation = current.content === transaction.prepared.content && current.exists === transaction.prepared.exists;
			if (!ownPreparation && (current.error || comments || stableJson(actual) !== stableJson(appliedProjection(transaction.prepared.doc)))) throw new Error("WATCHDOG.yml changed outside omp's expected apply write. The current file was retained; reload it before editing.");
			const unchanged = await readAdvisorFile(transaction.target);
			if (unchanged.content !== current.content || unchanged.exists !== current.exists) throw new Error("WATCHDOG.yml changed while applying. The current file was retained.");
			if (transaction.file.exists) await writeText(transaction.target, transaction.file.content);
			else await rm(transaction.target, { force: true });
		}
		return readAdvisorFile(transaction.file.file);
	} finally { applications.delete(token); applyingTargets.delete(transaction.target); }
}
const edits = new Map<string, Promise<unknown>>();
export async function saveAdvisorFile(file: string, original: string, input: AdvisorDoc): Promise<AdvisorFile> {
	const doc = AdvisorDocSchema.parse(input);
	const target = await realpath(file).catch(() => file);
	const previous = edits.get(target) ?? Promise.resolve();
	const pending = previous.catch(() => undefined).then(async () => {
		if (applyingTargets.has(target)) throw new Error("Wait for the advisor configuration to finish applying before saving.");
		const current = await readAdvisorFile(target);
		if (current.content !== original) throw new Error("WATCHDOG.yml changed outside this sheet. Reload it before saving.");
		if (current.error) throw new Error(`Repair the advisor configuration before saving: ${current.error}`);
		const document = parseDocument(current.content);
		// Retain unknown top-level fields and comments. omp accepts the raw instruction strings and expands imports itself.
		for (const key of ["instructions", "maxNotesPerUpdate", "advisors"]) {
			const next = doc[key];
			if (next === undefined || (key === "advisors" && Array.isArray(next) && next.length === 0)) document.delete(key);
			else if (key === "advisors" && Array.isArray(next)) {
				const sequence = document.get("advisors", true);
				if (isCollection(sequence) && "items" in sequence && Array.isArray(sequence.items)) {
					for (let index = 0; index < next.length; index++) {
						const previous = current.doc.advisors[index];
						const entry = next[index] as Record<string, unknown>;
						for (const field of new Set([...Object.keys(previous ?? {}), ...Object.keys(entry)])) {
							if (entry[field] === undefined) document.deleteIn(["advisors", index, field]);
							else if (stableJson(previous?.[field]) !== stableJson(entry[field])) document.setIn(["advisors", index, field], entry[field]);
						}
					}
					sequence.items.splice(next.length);
				} else document.set(key, next);
			} else document.set(key, next);
		}
		if (!doc.advisors.length && !doc.instructions?.trim() && doc.maxNotesPerUpdate === undefined && Object.keys(doc).every(key => ["advisors", "instructions", "maxNotesPerUpdate"].includes(key))) await rm(target, { force: true });
		else await writeText(target, document.toString());
		return readAdvisorFile(file);
	});
	edits.set(target, pending);
	try { return await pending; }
	finally { if (edits.get(target) === pending) edits.delete(target); }
}

export function register(): void {
	handle("advisor:read", async (cwd, scope) => readAdvisorFile(await advisorPath(cwd, scope)));
	handle("advisor:save", async (cwd, scope, original, doc) => saveAdvisorFile(await advisorPath(cwd, scope), original, doc));
	handle("advisor:beginApply", async (cwd, scope) => beginAdvisorApply(await advisorPath(cwd, scope)));
	handle("advisor:finishApply", finishAdvisorApply);
}
