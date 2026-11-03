import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TspNode } from "../../../shared/tsp";
import type { TspHostSnapshot } from "../../../shared/tsp-host";
import { btwTopicKey, projectBtw, resolveBtwTopic } from "../../../shared/tsp/btw";
import { TSP_ACTIONS, TSP_BTW_STATUS, TSP_ROLES } from "../../../shared/tsp/roles";
import { BtwDriver } from "./btw-driver";
import { BtwHistoryState } from "./btw-state";
import { composerFacts } from "./composer";
import { TspSession } from "./session";

const states: BtwHistoryState[] = [];
const roots: string[] = [];
afterEach(async () => { for (const state of states.splice(0)) state.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const question = "Why this approach?";
const record = (id: string, answer: string) => ({ id, question, answer, status: "complete", createdAt: 100, updatedAt: 150, leafId: null });
async function saved(root: string, id: string, answer: string, scope?: string) {
	const directory = join(root, "session", "btw-history", ...(scope ? ["sessions", scope] : []));
	await mkdir(directory, { recursive: true });
	const file = join(directory, `entry-${id}.json`);
	await writeFile(file, JSON.stringify(record(id, answer)) + "\n");
	return file;
}
function overlay(answer: string, options: { selected?: string | null; running?: boolean; items?: string[] } = {}): TspNode {
	const items = options.items ?? ["shared"];
	const list: TspNode[] = options.selected === null ? [] : [{ id: "records", k: "list", p: { role: TSP_ROLES.btwList, selected: `records/${options.selected ?? "shared"}` }, c: items.map(id => ({ id: `records/${id}`, k: "item", p: { label: question } })) }];
	return { id: "overlay", k: "overlay", p: { role: TSP_ROLES.btwHistory }, c: [...list, { id: "thread", k: "col", p: { role: TSP_ROLES.btwThread }, c: [
		{ id: "turn", k: "col", p: { role: TSP_ROLES.btwTurn }, c: [
			{ id: "question", k: "md", p: { role: TSP_ROLES.btwQuestion, text: question } },
			{ id: "meta", k: "text", p: { role: TSP_ROLES.btwMeta, spans: [{ t: options.running ? TSP_BTW_STATUS.running : "Nov 3, 2026" }] } },
			{ id: "answer", k: "col", p: { role: TSP_ROLES.btwAnswer }, c: [{ id: "markdown", k: "md", p: { text: answer, stream: options.running === true } }] },
		] },
	] }, { id: "follow-up", k: "button", p: { text: "Follow up", actions: { click: TSP_ACTIONS.btwFollowUp } } }, { id: "close", k: "button", p: { text: "Close", actions: { click: TSP_ACTIONS.close } } }] };
}
async function harness(root: string, initial: TspNode, focused = false) {
	const history = new BtwHistoryState(() => {}); states.push(history);
	const sessionFile = join(root, "session.jsonl");
	let session: TspSession;
	let sequence = 0;
	const writes: string[] = [];
	const snapshot = (): TspHostSnapshot => {
		const protocol = session.snapshot();
		const surfaces = protocol.surfaces.map(surface => ({ ...surface, documentGeneration: 1 }));
		return { ...protocol, hostId: "scoped", generation: 1, revision: sequence, surfaces, lifecycle: "live", closing: false, documentGeneration: 1, failure: null, availability: session.availability(), composer: composerFacts(surfaces), editorRestore: null, questionMatches: [] };
	};
	session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => { writes.push(data); }, onUpdate: () => history.update(snapshot(), sessionFile, 1) });
	const receive = (verb: string, body: unknown) => session.receive({ verb, params: {}, body: JSON.stringify(body) });
	receive("q", { q: "hello", v: [1], features: ["send", "edit"] });
	receive("o", { id: "s", mode: "inline", role: TSP_ROLES.session });
	receive("f", { sf: "s", s: ++sequence, ops: [
		["add", "dock", "s", null, { id: "dock", k: "col", c: [{ id: "main", k: "col", p: { role: TSP_ROLES.editor }, c: [{ id: "input", k: "editor", p: { text: "", sendable: true } }] }, { id: "focus", k: "col", p: { role: TSP_ROLES.composerFocus, hidden: !focused } }] }],
		["add", "layer", "s", null, { id: "layer", k: "col", c: [initial] }], ["focus", "input"],
	] });
	await history.refresh();
	const show = async (node: TspNode | null, helper = false) => {
		receive("f", { sf: "s", s: ++sequence, ops: [["set", "focus", { hidden: !helper }], ["del", "overlay"], ...(node ? [["add", "overlay", "layer", null, node]] : [])] });
		await session.drain();
	};
	return { session, snapshot, history, show, writes, driver: () => new BtwDriver({ session, snapshot, state: () => history.state!, assertCurrent: () => {} }) };
}

describe("scoped BTW topic identity", () => {
	it("keeps the reader's main/helper shared ids distinct through live reconciliation and native selection", async () => {
		const root = await mkdtemp(join(tmpdir(), "vomp-btw-scopes-")); roots.push(root);
		const mainFile = await saved(root, "shared", "Because it preserves the journal.");
		const helperFile = await saved(root, "shared", "Helper answer", "helper_1");
		await saved(root, "other", "Sibling answer", "helper-2");
		const mainBefore = await readFile(mainFile, "utf8"); const helperBefore = await readFile(helperFile, "utf8");
		const h = await harness(root, overlay("Because it preserves the journal.", { items: ["shared", "other"] }));
		expect(h.history.state!.topics.filter(topic => topic.id === "shared").map(topic => [topic.scope, topic.turns[0]!.answer])).toEqual([[undefined, "Because it preserves the journal."], ["helper_1", "Helper answer"]]);
		expect(h.history.state!.overlay!.selectedTopic).toEqual({ id: "shared" });
		expect(h.history.state!.overlay!.topics).toEqual([{ id: "shared" }]);
		await expect(h.driver().run("select", "", { id: "shared", scope: "helper_1" })).rejects.toThrow("unavailable in the current omp view");
		await h.show(overlay("Helper ", { running: true, items: ["shared", "other"] }), true);
		expect(h.history.state!.overlay!.selectedTopic).toEqual({ id: "shared", scope: "helper_1" });
		expect(h.history.state!.overlay!.topics).toEqual([{ id: "shared", scope: "helper_1" }]);
		expect(h.history.state!.topics.find(topic => topic.id === "shared" && topic.scope === undefined)?.turns[0]!.answer).toBe("Because it preserves the journal.");
		expect(h.history.state!.topics.find(topic => topic.scope === "helper_1")?.turns[0]).toMatchObject({ answer: "Helper ", status: "running" });
		await expect(h.driver().run("followUp", "Do not send to the helper", { id: "shared" })).rejects.toThrow("unavailable in the current omp view");
		expect(h.writes.some(data => /"ev":"(?:select|edit)"|"act":"follow-up"/.test(data))).toBe(false);
		expect(await readFile(mainFile, "utf8")).toBe(mainBefore); expect(await readFile(helperFile, "utf8")).toBe(helperBefore);
	});

	it("retains a helper live alias without redirecting the main topic with the same id", async () => {
		const root = await mkdtemp(join(tmpdir(), "vomp-btw-alias-")); roots.push(root);
		await saved(root, "shared", "Because it preserves the journal.");
		const h = await harness(root, overlay("Helper answer", { selected: null }), true);
		const live = h.history.state!.overlay!.selectedTopic!;
		expect(live.id).toMatch(/^live:/);
		await h.show(null, true);
		await saved(root, "shared", "Helper answer", "helper_1");
		const current = await h.history.refresh();
		expect(current.topics).toHaveLength(2);
		expect(new Set(current.topics.map(btwTopicKey)).size).toBe(2);
		expect(h.history.resolveTopicRef(live)).toEqual({ id: "shared", scope: "helper_1" });
		expect(h.history.resolveTopicRef({ id: "shared" })).toEqual({ id: "shared" });
		expect(current.topics.find(topic => topic.scope === undefined)?.turns[0]!.answer).toBe("Because it preserves the journal.");
	});

	it("does not guess a helper scope when duplicate ids and questions have no distinguishing answer", async () => {
		const root = await mkdtemp(join(tmpdir(), "vomp-btw-ambiguous-")); roots.push(root);
		await saved(root, "shared", "Same answer", "helper_1"); await saved(root, "shared", "Same answer", "helper_2");
		const h = await harness(root, overlay("", { selected: null, running: true }), true);
		const projected = projectBtw(h.snapshot().surfaces)!;
		expect(resolveBtwTopic(projected, h.history.state!.topics.filter(topic => !topic.id.startsWith("live:")))).toBeNull();
		expect(h.history.state!.topics.filter(topic => topic.id === "shared")).toHaveLength(2);
		expect(h.history.state!.overlay!.selectedTopic!.id).toMatch(/^live:/);
		expect(h.history.state!.overlay!.topics).toEqual([h.history.state!.overlay!.selectedTopic]);
	});

	it("refuses an action if the same raw id changes owning scope before the write", async () => {
		const root = await mkdtemp(join(tmpdir(), "vomp-btw-action-scope-")); roots.push(root);
		await saved(root, "shared", "Because it preserves the journal."); await saved(root, "shared", "Helper answer", "helper_1");
		const h = await harness(root, overlay("Because it preserves the journal."));
		const sending = h.driver().run("followUp", "Main-only follow-up", { id: "shared" });
		const rejected = expect(sending).rejects.toThrow("unavailable in the current omp view");
		await h.show(overlay("Helper answer"), true);
		await rejected;
		expect(h.writes.some(data => data.includes('"act":"follow-up"') || data.includes('"ev":"edit"'))).toBe(false);
	});
});
