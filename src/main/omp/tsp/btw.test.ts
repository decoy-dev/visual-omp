import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BtwState, BtwTopic, BtwTopicRef, BtwTurn } from "../../../shared/contracts/btw";
import type { TspNode } from "../../../shared/tsp";
import type { TspHostSnapshot, TspSurfaceSnapshot } from "../../../shared/tsp-host";
import { mergeBtwTopics, projectBtw, resolveBtwTopic, sameBtwTopic, type BtwProjection } from "../../../shared/tsp/btw";
import { TSP_ACTIONS, TSP_ROLES } from "../../../shared/tsp/roles";
import { unclaimed } from "../../../shared/tsp/view-state";
import { listBtwHistory } from "../btw-history";
import { BtwDriver, type BtwOperation } from "./btw-driver";
import { BtwHistoryState } from "./btw-state";
import { composerFacts } from "./composer";
import { TspSession } from "./session";
import { TspStream } from "./stream";

interface Stage { stage: string; afterMessage: number; surfaceId?: string; overlay: TspNode | null; files: { path: string; text: string }[]; collab?: { working?: boolean; entries?: { message?: { stopReason?: string } }[] } }
interface Evidence { stages: Stage[]; files: string[]; observation?: string }
interface RecordedEvent { verb?: string; body?: { ev: string; [key: string]: unknown }; collab?: { t: string }; afterMessage: number }
const root = new URL("./fixtures/18.15.0/", import.meta.url);
const load = (name: string, suffix: string) => readFileSync(new URL(`${name}.${suffix}`, root), "utf8");
const evidence = (name: string): Evidence => JSON.parse(load(name, "btw.json"));
const fileTopics = (stage: Stage): BtwTopic[] => stage.files.filter(file => file.path.endsWith(".json")).map(file => {
	const record = JSON.parse(file.text) as BtwTurn & { id: string; followUps?: BtwTurn[] };
	const title = stage.files.find(file => file.path.endsWith(`/entry-${record.id}.title`))?.text ?? record.question;
	return { id: record.id, title, live: false, turns: [record, ...(record.followUps ?? [])].map(({ question, answer, status, createdAt, updatedAt, error }) => ({ question, answer, status, createdAt, updatedAt, ...(error ? { error } : {}) })) };
}).sort((a, b) => b.turns[0]!.createdAt - a.turns[0]!.createdAt || a.id.localeCompare(b.id));
const surfaceFor = (overlay: TspNode | null): TspSurfaceSnapshot & { documentGeneration: number } => ({ open: { id: "s:1", mode: "inline", role: TSP_ROLES.session }, sequence: 1, closed: false, suspended: false, documentGeneration: 1, focus: null, settled: [], document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: overlay ? [overlay] : [] }] } });
const hostSnapshot = (surfaces: (TspSurfaceSnapshot & { documentGeneration: number })[], epoch = 1): TspHostSnapshot => ({ hostId: "btw", generation: 1, epoch, revision: 1, closing: false, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: true, reason: null }, composer: composerFacts(surfaces), editorRestore: null, surfaces, questionMatches: [] });

const topicRef = ({ id, scope }: BtwTopicRef): BtwTopicRef => ({ id, ...(scope === undefined ? {} : { scope }) });
const answerContent = (turns: readonly BtwTurn[]) => turns.map(({ question, answer, status }) => ({ question, answer, status }));

async function writeStage(sessionFile: string, stage: Stage): Promise<void> {
	for (const file of stage.files) {
		const path = join(sessionFile.slice(0, -".jsonl".length), "btw-history", file.path.split("/btw-history/")[1]!);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.text);
	}
}

function expectLiveState(state: BtwState, projection: BtwProjection | null): void {
	if (!projection) { expect(state.overlay).toBeNull(); return; }
	expect(state.overlay).toMatchObject({ surfaceId: projection.surfaceId, nodeId: projection.nodeId, followUp: !!projection.field, draft: projection.field?.text ?? null });
	if (!projection.turns.length) { expect(state.overlay?.selectedTopic).toBeNull(); return; }
	const selected = state.overlay!.selectedTopic!;
	expect(selected).toBeTruthy();
	expect(state.overlay!.topics.some(topic => sameBtwTopic(topic, selected))).toBe(true);
	const topic = state.topics.find(topic => sameBtwTopic(topic, selected))!;
	expect(topic?.live).toBe(true);
	for (const [index, turn] of projection.turns.entries()) {
		if (turn.status === "running") expect(answerContent([topic.turns[index]!])).toEqual(answerContent([turn]));
	}
}

/** Exact recorded inputs advance frames and sidecars through the production history state. */
async function replay(name: string) {
	const folder = await mkdtemp(join(tmpdir(), "vomp-btw-replay-"));
	scratch.push(folder);
	const sessionFile = join(folder, "session.jsonl");
	const messages: { verb: string; body: unknown }[] = [];
	const parser = new TspStream({ onData: () => {}, onMessage: message => messages.push({ verb: message.verb, body: JSON.parse(message.body) }) });
	const raw = readFileSync(new URL(`${name}.raw.bin`, root));
	for (let offset = 0; offset < raw.length; offset += 11) parser.push(raw.subarray(offset, offset + 11));
	parser.end();
	const expected = load(name, "events.jsonl").trim().split("\n").map(line => JSON.parse(line) as RecordedEvent).filter(event => event.collab || event.verb === "e" && event.body?.ev !== "ack");
	const stages = evidence(name).stages;
	const history = new BtwHistoryState(() => {}); states.push(history);
	let at = 0;
	let index = 0;
	let stageIndex = 0;
	let currentFiles: BtwTopic[] = [];
	let advancing = Promise.resolve();
	const outputs: object[] = [];
	const frames: { afterMessage: number; projection: BtwProjection | null; state: BtwState; files: BtwTopic[] }[] = [];
	const checkpoints: { stage: string; projection: BtwProjection | null; state: BtwState }[] = [];
	const errors: Error[] = [];
	const snapshot = () => hostSnapshot(session.snapshot().surfaces.map(surface => ({ ...surface, documentGeneration: 1 })), session.snapshot().epoch);
	const receive = async () => {
		const message = messages[at++]!;
		session.receive({ verb: message.verb, params: {}, body: JSON.stringify(message.body) });
		const projection = projectBtw(snapshot().surfaces);
		expectLiveState(history.state!, projection);
		frames.push({ afterMessage: at, projection, state: structuredClone(history.state!), files: currentFiles });
		while (stages[stageIndex]?.afterMessage === at) {
			const stage = stages[stageIndex++]!;
			expect(projection, `${name}: live document at ${stage.stage}`).toEqual(projectBtw([surfaceFor(stage.overlay)]));
			const files = fileTopics(stage);
			// Assert live terminal content before making this stage's completed sidecar visible.
			if (projection?.turns.length && projection.turns.every(turn => turn.status !== "running")) {
				const selected = resolveBtwTopic(projection, files);
				const persisted = files.find(topic => sameBtwTopic(topic, selected));
				expect(persisted, `${name}: independent terminal topic at ${stage.stage}`).toBeTruthy();
				expect(answerContent(projection.turns), `${name}: independent terminal content at ${stage.stage}`).toEqual(answerContent(persisted!.turns));
			}
			await writeStage(sessionFile, stage);
			currentFiles = files;
			const state = await history.refresh();
			expect(await listBtwHistory(sessionFile, { includeScopes: true })).toEqual(files);
			expectLiveState(state, projection);
			checkpoints.push({ stage: stage.stage, projection, state: structuredClone(state) });
		}
	};
	const advance = async () => {
		const boundary = expected[index]?.afterMessage ?? (name === "btw-empty" ? stages.at(-1)!.afterMessage : messages.length);
		while (at < boundary) await receive();
	};
	const schedule = () => { advancing = advancing.then(advance); };
	const consumed = (actual: object) => {
		const event = expected[index++];
		expect(actual, `${name}: application event ${index}`).toEqual(event?.collab ? { collab: event.collab } : { body: event?.body });
		outputs.push(actual);
		schedule();
	};
	const output = new TspStream({ onData: () => {}, onMessage: message => {
		const body = JSON.parse(message.body);
		if (message.verb === "e" && body.ev !== "ack") consumed({ body });
	} });
	const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => { output.push(Buffer.from(data)); },
		onUpdate: () => history.update(snapshot(), sessionFile, 0), onError: error => errors.push(error) });
	history.update(snapshot(), sessionFile, 0);
	await history.refresh();
	expect(history.state?.topics).toEqual([]);
	const driver = () => new BtwDriver({ session, snapshot, state: () => history.state!, assertCurrent: () => {} });
	const settle = async () => {
		let previous: Promise<void>;
		do { previous = advancing; await previous; await session.drain(); } while (previous !== advancing);
	};
	schedule();
	await settle();
	return { session, driver, snapshot, history, sessionFile, stages, outputs, frames, checkpoints,
		run: async (operation: BtwOperation, text = "", topic?: BtwTopicRef) => { await driver().run(operation, text, topic); await settle(); },
		submit: async (text: string) => { await session.submit(text); await settle(); },
		abort: async () => { consumed({ collab: { t: "abort" } }); await settle(); },
		finish: async () => {
			await settle();
			// An open-only recording kills omp after its captured UI was inspected.
			while (at < messages.length) await receive();
			expect(index).toBe(expected.length); expect(at).toBe(messages.length); expect(stageIndex).toBe(stages.length); expect(errors).toEqual([]);
			return history.refresh();
		} };
}

const scratch: string[] = [];
const states: BtwHistoryState[] = [];
afterEach(async () => { for (const state of states.splice(0)) state.close(); for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }); vi.useRealTimers(); });

describe("BTW fixture replay", () => {
	it.each(["btw-empty", "btw-ask", "btw-ask-again", "btw-follow-up", "btw-cancel", "btw-open-main-abort"])("drives %s with declared production events and reconciles every final sidecar", async name => {
		const h = await replay(name);
		if (name === "btw-open-main-abort") await h.submit("Start the main fixture turn and keep it running.");
		await h.run("ask", name === "btw-empty" ? "" : "What is the first fixture side question?");
		if (name === "btw-ask-again") {
			await h.run("ask", "What is the second fixture side question?");
			const first = h.history.state!.topics.find(topic => topic.title === "What is the first fixture side question?")!;
			await h.run("select", "", topicRef(first));
		} else if (name === "btw-follow-up") {
			await h.run("followUp", "Explain the fixture answer in one more sentence.", h.history.state!.overlay!.selectedTopic!);
		} else if (name === "btw-open-main-abort") {
			const before = h.outputs.length;
			await h.abort();
			expect(h.outputs.slice(before)).toEqual([{ collab: { t: "abort" } }]);
			const afterAbort = h.stages.find(stage => stage.stage === "after-main-abort-side-running")!;
			expect(afterAbort.collab?.working).toBe(false);
			expect(afterAbort.collab?.entries?.some(entry => entry.message?.stopReason === "aborted")).toBe(true);
			const running = h.checkpoints.find(checkpoint => checkpoint.stage === afterAbort.stage)!;
			expect(running.projection?.turns.at(-1)?.status).toBe("running");
			expect(running.state.overlay?.actions).toContain(TSP_ACTIONS.btwStop);
			const selected = running.state.topics.find(topic => sameBtwTopic(topic, running.state.overlay?.selectedTopic))!;
			expect(selected.turns.at(-1)?.answer).toBe("Side answer continues ");
			expect(selected.turns.at(-1)?.status).toBe("running");
		}
		if (name !== "btw-empty") {
			if (name === "btw-cancel") await h.run("stop");
			else await h.run("close");
			await h.submit("/exit");
		}
		const final = await h.finish();
		expect(h.checkpoints.map(checkpoint => checkpoint.stage)).toEqual(h.stages.map(stage => stage.stage));
		expect(final.topics.map(topic => ({ ...topic, live: false }))).toEqual(fileTopics(h.stages.at(-1)!));
		if (name === "btw-empty") expect(final.topics).toEqual([]);
		else {
			const initial = h.frames.find(frame => frame.projection?.turns.length && frame.files.length === 0)!;
			expect(initial, `${name}: production snapshot before the first sidecar`).toBeTruthy();
			expect(initial.state.overlay?.selectedTopic?.id).toMatch(/^live:/);
			expect(initial.state.topics[0]?.turns[0]?.answer).toBe(initial.projection!.turns[0]?.answer);
			const terminal = h.checkpoints.filter(checkpoint => checkpoint.projection?.turns.length && checkpoint.projection.turns.every(turn => turn.status !== "running"));
			expect(terminal.length, `${name}: terminal production snapshot`).toBeGreaterThan(0);
		}
	});

	it("updates production snapshots from initial sidecars and never completes a quiet running document", async () => {
		const folder = await mkdtemp(join(tmpdir(), "vomp-btw-stream-"));
		scratch.push(folder);
		const sessionFile = join(folder, "session.jsonl");
		const stages = evidence("btw-open-main-abort").stages;
		const initial = stages.find(stage => stage.stage === "before-main-abort")!;
		const streaming = stages.find(stage => stage.stage === "after-main-abort-side-running")!;
		const final = stages.at(-1)!;
		const state = new BtwHistoryState(() => {}); states.push(state);
		state.update(hostSnapshot([surfaceFor(initial.overlay)]), sessionFile, 0);
		await state.refresh();
		expect(state.state?.overlay?.selectedTopic?.id).toBe("live:1");
		expect(state.state?.topics[0]?.turns[0]?.status).toBe("running");
		await writeStage(sessionFile, initial);
		await state.refresh();
		const ref = topicRef(fileTopics(initial)[0]!);
		expect(state.state?.overlay?.selectedTopic).toEqual(ref);
		expect(state.state?.topics[0]?.turns[0]?.answer).toBe("Side answer continues ");
		state.update(hostSnapshot([surfaceFor(streaming.overlay)]), sessionFile, 0);
		const quiet = structuredClone(state.state!);
		expect(quiet.topics[0]?.turns[0]?.answer).toBe("Side answer continues ");
		expect(quiet.topics[0]?.turns[0]?.status).toBe("running");
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(state.state).toEqual(quiet);
		expect((await state.refresh()).topics[0]?.turns[0]?.status).toBe("running");
		vi.useRealTimers();
		const projection = projectBtw([surfaceFor(final.overlay)])!;
		expect(answerContent(projection.turns)).toEqual(answerContent(fileTopics(final)[0]!.turns));
		state.update(hostSnapshot([surfaceFor(final.overlay)]), sessionFile, 0);
		expect(state.state?.topics[0]?.turns[0]?.status).toBe("complete");
		await writeStage(sessionFile, final);
		const completed = await state.refresh();
		expect(completed.topics.map(topic => ({ ...topic, live: false }))).toEqual(fileTopics(final));
	});

	it("keeps completed file authority separate from the independent live projection comparison", () => {
		const stage = evidence("btw-ask").stages[0]!;
		const files = fileTopics(stage);
		const view = projectBtw([surfaceFor(stage.overlay)])!;
		const stale = { ...view, turns: view.turns.map(turn => ({ ...turn, answer: "An older completed document." })) };
		expect(mergeBtwTopics(files, stale, { id: "live:1" })[0]?.turns).toEqual(files[0]!.turns);
	});

	it("normalizes physical topic paths and keeps a lone topic temporary until its file appears", () => {
		const multi = evidence("btw-ask-again").stages.find(stage => (projectBtw([surfaceFor(stage.overlay)])?.topics.length ?? 0) > 1)!;
		const projection = projectBtw([surfaceFor(multi.overlay)])!;
		for (const topic of projection.topics) expect(topic.itemId).toBe(`${projection.list!.nodeId}/${topic.id}`);
		expect(projection.topics.some(topic => topic.id === projection.selectedId)).toBe(true);
		const lone = evidence("btw-ask").stages[0]!;
		const live = projectBtw([surfaceFor(lone.overlay)])!;
		expect(mergeBtwTopics([], live, { id: "live:7" })[0]?.id).toBe("live:7");
		const files = fileTopics(lone);
		expect(resolveBtwTopic(live, files)).toEqual(topicRef(files[0]!));
		expect(mergeBtwTopics(files, live, { id: "live:7" })[0]?.id).toBe(files[0]?.id);
	});

	it("leaves the overlay readable without an active pane claim", () => {
		const stage = evidence("btw-ask").stages[0]!;
		const surface = surfaceFor(stage.overlay);
		expect(unclaimed(surface, "layer")).toContainEqual(stage.overlay);
		expect(unclaimed(surface, "layer", new Set([stage.overlay!.id]))).toEqual([]);
	});
});

describe("BTW writer ownership", () => {
	it("refuses main sends while the follow-up field owns the overlay", async () => {
		const h = await replay("btw-follow-up");
		await h.run("ask", "What is the first fixture side question?");
		const overlay = projectBtw(h.snapshot().surfaces)!;
		await h.session.send({ ev: "action", sf: overlay.surfaceId, id: overlay.actions[TSP_ACTIONS.btwFollowUp]!, act: TSP_ACTIONS.btwFollowUp });
		await h.session.waitFor(() => !!projectBtw(h.snapshot().surfaces)?.field, () => {}, 8000, "The fixture did not open its follow-up field.");
		const before = h.outputs.length;
		await expect(h.session.submit("Do not swallow the main prompt")).rejects.toThrow();
		expect(h.outputs).toHaveLength(before);
	});

	it("never assumes inject on 18.15, and refuses an action removed before the writer", async () => {
		const h = await replay("btw-ask");
		await h.run("ask", "What is the first fixture side question?");
		const before = h.outputs.length;
		await expect(h.driver().run("inject", "", h.history.state!.overlay!.selectedTopic!)).rejects.toThrow("no longer offers");
		expect(h.outputs).toHaveLength(before);
		const overlay = projectBtw(h.snapshot().surfaces)!;
		await expect(h.session.send({ ev: "action", sf: overlay.surfaceId, id: overlay.actions[TSP_ACTIONS.close]!, act: TSP_ACTIONS.btwInject })).rejects.toThrow("no longer offers");
		expect(h.outputs).toHaveLength(before);
	});

	it("renders optional steering and sends only a declared inject, waiting for omp's sent mark", async () => {
		const stage = structuredClone(evidence("btw-ask").stages[0]!);
		const visit = (node: TspNode): TspNode | undefined => node.p?.role === TSP_ROLES.btwAnswer ? node : node.c?.map(visit).find(Boolean);
		const answer = visit(stage.overlay!)!;
		answer.c = [{ id: "inject-answer", k: "col", c: [{ id: "prose", k: "md", p: { text: "A useful answer." } }, { id: "inject", k: "card", p: { role: TSP_ROLES.btwInject, tone: "user" }, c: [{ id: "prompt", k: "text", p: { text: "Continue with the smaller change." } }, { id: "label", k: "text", p: { text: "Inject into main session" } }] }] }];
		const view = projectBtw([surfaceFor(stage.overlay)])!;
		expect(view.turns[0]?.inject).toEqual({ text: "Continue with the smaller change.", sent: false });
		expect(view.turns[0]?.answer).toContain("<inject>\nContinue with the smaller change.\n</inject>");
		expect(view.actions).not.toHaveProperty(TSP_ACTIONS.btwInject);
		expect(view.supported).toBe(true);
		stage.overlay!.c = [...(stage.overlay!.c ?? []), { id: "inject-button", k: "button", p: { text: "Inject into main", actions: { click: TSP_ACTIONS.btwInject } } }];
		const actions: object[] = [];
		const output = new TspStream({ onData: () => {}, onMessage: message => {
			const body = JSON.parse(message.body);
			if (message.verb === "e" && body.ev === "action") actions.push(body);
		} });
		const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => output.push(Buffer.from(data)),
			onUpdate: () => history.update(snapshot(), null, 0) });
		const history = new BtwHistoryState(() => {}); states.push(history);
		const snapshot = () => hostSnapshot(session.snapshot().surfaces.map(surface => ({ ...surface, documentGeneration: 1 })));
		const receive = (verb: string, body: unknown) => session.receive({ verb, params: {}, body: JSON.stringify(body) });
		receive("q", { q: "hello", v: [1], features: ["send", "edit"] });
		receive("o", { id: "s:1", mode: "inline", role: TSP_ROLES.session });
		receive("f", { sf: "s:1", s: 1, ops: [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [stage.overlay] }]] });
		const driver = new BtwDriver({ session, snapshot, state: () => history.state!, assertCurrent: () => {} });
		let done = false;
		const sending = driver.run("inject", "", history.state!.overlay!.selectedTopic!).then(() => { done = true; });
		await vi.waitFor(() => expect(actions).toHaveLength(1));
		receive("f", { sf: "s:1", s: 2, ops: [["set", "inject-button", { disabled: true }]] });
		await session.drain();
		expect(done).toBe(false);
		receive("f", { sf: "s:1", s: 3, ops: [["set", "inject", { tone: "success" }]] });
		await sending;
		expect(actions).toEqual([{ ev: "action", sf: "s:1", id: "inject-button", act: TSP_ACTIONS.btwInject }]);
	});
});

describe("BTW resume reconciliation", () => {
	it("replaces live:N after a sidecar appears while the overlay is closed", async () => {
		const folder = await mkdtemp(join(tmpdir(), "vomp-btw-identity-"));
		scratch.push(folder);
		const sessionFile = join(folder, "session.jsonl");
		const stage = evidence("btw-ask").stages[0]!;
		const state = new BtwHistoryState(() => {}); states.push(state);
		state.update(hostSnapshot([surfaceFor(stage.overlay)]), null, 1);
		const temporary = state.state!.overlay!.selectedTopic!;
		expect(temporary).toEqual({ id: "live:1" });
		state.update(hostSnapshot([surfaceFor(stage.overlay)]), sessionFile, 1);
		expect(state.state!.overlay!.selectedTopic).toEqual(temporary);
		state.update(hostSnapshot([surfaceFor(null)]), sessionFile, 1);
		const directory = join(folder, "session", "btw-history");
		await mkdir(directory, { recursive: true });
		const record = stage.files.find(file => file.path.endsWith(".json"))!;
		await writeFile(join(directory, record.path.split("/").at(-1)!), record.text);
		const current = await state.refresh();
		expect(current.topics).toEqual(fileTopics(stage));
		expect(state.resolveTopicRef(temporary)).toEqual(topicRef(fileTopics(stage)[0]!));
	});
	it("reads previous topics after process restart, shows interrupted checkpoints and writes no sidecars", async () => {
		const folder = await mkdtemp(join(tmpdir(), "vomp-btw-resume-"));
		scratch.push(folder);
		const sessionFile = join(folder, "session.jsonl");
		const directory = join(folder, "session", "btw-history");
		await mkdir(directory, { recursive: true });
		const running = evidence("btw-open-main-abort").stages.find(stage => stage.stage === "after-main-abort-side-running")!;
		const record = running.files.find(file => file.path.endsWith(".json"))!;
		const file = join(directory, record.path.split("/").at(-1)!);
		await writeFile(file, record.text);
		const state = new BtwHistoryState(() => {});
		states.push(state);
		state.update(hostSnapshot([surfaceFor(null)]), sessionFile, Date.now() + 1000);
		const resumed = await state.refresh();
		expect(resumed.topics[0]?.turns[0]?.status).toBe("interrupted");
		expect(resumed.topics[0]?.id).toBe(JSON.parse(record.text).id);
		expect(await readFile(file, "utf8")).toBe(record.text);
		state.update(hostSnapshot([surfaceFor(running.overlay)]), sessionFile, Date.now() + 1000);
		expect(state.state?.topics[0]?.turns[0]?.status).toBe("running");
		expect(state.state?.topics[0]?.turns[0]?.answer).toBe("Side answer continues ");
		expect(await readFile(file, "utf8")).toBe(record.text);
	});
});
