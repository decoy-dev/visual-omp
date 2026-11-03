import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import type { TspRendererEvent } from "../../../shared/tsp-host";
import { hookQuestions } from "../../../shared/tsp/question-match";
import { hookAnswerEvents, type TspHookAnswer } from "../../../shared/tsp/dialogs";
import { isHookNode } from "../../../shared/tsp/roles";
import { openOverlay, walkNodes } from "../../../shared/tsp/view-state";

const fixtures = new URL("./fixtures/18.15.0/", import.meta.url);
interface Recording { verb: string; body: Record<string, unknown>; afterMessage?: number }
const records = (name: string, kind: string): Recording[] => readFileSync(new URL(`${name}.${kind}.jsonl`, fixtures), "utf8").split("\n").filter(line => line.trim() !== "").map(line => JSON.parse(line));
function replay(messages: Recording[]) {
	const output: TspRendererEvent[] = [];
	const stream = new TspStream({ onData: () => {}, onMessage: message => { if (message.verb === "e") output.push(JSON.parse(message.body)); } });
	const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => { stream.push(Buffer.from(data)); } });
	for (const message of messages) session.receive({ verb: message.verb, params: {}, body: JSON.stringify(message.body) });
	return { session, output };
}

describe("recorded omp hook answers", () => {
	it("classifies hook, worktree, tree summary and cleanse instruction recordings across every committed document replay", () => {
		const names = readdirSync(fixtures).filter(name => name.endsWith(".messages.jsonl")).map(name => name.replace(".messages.jsonl", ""));
		expect(names).toEqual(expect.arrayContaining(["hook-select", "hook-confirm", "hook-input", "hook-editor", "model-picker", "settings-screen", "jobs", "session", "tools", "changelog", "hotkeys", "tree-open"]));
		for (const name of names) {
			const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: () => {} });
			let found = false;
			for (const message of records(name, "messages")) {
				session.receive({ verb: message.verb, params: {}, body: JSON.stringify(message.body) });
				if (session.snapshot().surfaces.some(surface => [...walkNodes(surface.document)].some(isHookNode))) found = true;
			}
			expect(found, name).toBe(name.startsWith("hook-") || name.startsWith("worktree-") || name === "cleanse" || name === "tree-navigate-summary");
		}
	});
	it.each(["hook-select", "hook-confirm", "hook-input", "hook-editor", "hook-select-cancel", "hook-confirm-cancel", "hook-input-cancel", "hook-editor-cancel"])("emits the exact accepted answer events for %s", async name => {
		const events = records(name, "events").filter(record => record.verb === "e");
		const accepted = events.filter(record => ["activate", "edit", "action"].includes(String(record.body.ev)));
		// Input's first edit seeds its default value. The final edit is the answer.
		const start = accepted.findLastIndex(record => record.body.ev === "edit");
		const expected = name.endsWith("cancel") ? accepted.slice(-1) : start >= 0 ? accepted.slice(start) : accepted;
		const before = expected[0]!;
		const h = replay(records(name, "messages").slice(0, before.afterMessage));
		await h.session.drain();
		const surfaces = h.session.snapshot().surfaces;
		const question = hookQuestions(surfaces, 1)[0]!;
		expect(question, name).toBeDefined();
		expect(openOverlay(surfaces, true)?.node.id, name).toBe(question.nodeId);
		expect(openOverlay(surfaces)?.node.id, "no mounted renderer consumer claims the replay").toBe(question.nodeId);
		expect(h.session.availability().available, "claimed hooks retain composer ownership").toBe(false);
		const root = [...walkNodes(surfaces.find(surface => surface.open.id === question.surfaceId)!.document)].find(node => node.id === question.nodeId)!;
		const event = before.body;
		const base = { sf: question.surfaceId, id: question.nodeId };
		const answer: TspHookAnswer = event.ev === "edit" ? { ...base, kind: "text", target: String(event.id), text: String(event.text), len: Number(event.len) }
			: event.ev === "activate" ? { ...base, kind: "choose", target: String(event.id), item: String(event.item) }
			: { ...base, kind: "cancel" };
		expect(hookAnswerEvents(root, answer)).toEqual(expected.map(record => record.body));
		h.output.length = 0;
		await h.session.answerHook(answer, () => {});
		expect(h.output).toEqual(expected.map(record => record.body));
		for (const message of records(name, "messages").slice(before.afterMessage)) h.session.receive({ verb: message.verb, params: {}, body: JSON.stringify(message.body) });
		expect(hookQuestions(h.session.snapshot().surfaces, 1)).toEqual([]);
		expect(openOverlay(h.session.snapshot().surfaces)).toBeNull();
	});
});
