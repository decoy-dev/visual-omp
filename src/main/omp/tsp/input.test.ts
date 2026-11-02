import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { composerFacts } from "./composer";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import type { TspOp } from "../../../shared/tsp";

const fixture = (name: string, suffix: string) => readFileSync(new URL(`./fixtures/18.15.0/${name}.${suffix}`, import.meta.url), "utf8");
interface RecordedEvent { verb?: string; body?: { ev: string }; keys?: string; afterMessage: number }
interface RecordedMessage { verb: string; body: unknown }

/** The fake program advances only after the next recorded application event matches. */
function replay(name: string) {
	const incoming: RecordedMessage[] = [];
	const raw = readFileSync(new URL(`./fixtures/18.15.0/${name}.raw.bin`, import.meta.url));
	const integrity = JSON.parse(fixture(name, "integrity.json"));
	expect({ bytes: raw.length, carriageReturns: raw.filter(byte => byte === 13).length, sha256: createHash("sha256").update(raw).digest("hex") }).toEqual(integrity);
	expect(raw.toString()).not.toMatch(/\/Users\/|vomp-tsp-record-/);
	const parser = new TspStream({ onData: () => {}, onMessage: message => incoming.push({ verb: message.verb, body: message.verb === "b" ? message.body : JSON.parse(message.body) }) });
	for (let offset = 0; offset < raw.length; offset += 7) parser.push(raw.subarray(offset, offset + 7));
	parser.end();
	expect(incoming).toEqual(fixture(name, "messages.jsonl").trim().split("\n").map(line => JSON.parse(line)));
	const expected: RecordedEvent[] = fixture(name, "events.jsonl").trim().split("\n").map(line => JSON.parse(line))
		.filter((event: RecordedEvent) => event.keys !== undefined ? !/^\x1b\[(?:\?62;22c|1;1R)$/.test(event.keys) : event.verb === "e" && event.body?.ev !== "ack");
	let at = 0;
	let eventIndex = 0;
	let pending = false;
	let queued = false;
	let restored = "";
	const errors: Error[] = [];
	const writes: string[] = [];
	const advance = () => {
		pending = false;
		const boundary = expected[eventIndex]?.afterMessage ?? incoming.length;
		while (at < boundary) {
			const message = incoming[at++]!;
			session.receive({ verb: message.verb, params: {}, body: typeof message.body === "string" ? message.body : JSON.stringify(message.body) });
			const facts = composerFacts(session.snapshot().surfaces);
			queued ||= facts.queued.length > 0;
			if (name === "ask-replaces-editor" && facts.blockedBy === "ask" && eventIndex === expected.length) break;
			if (facts.text.includes("Fixture follow-up text")) restored = facts.text;
		}
	};
	const consumed = (actual: object) => {
		const next = expected[eventIndex++];
		expect(actual, `${name}: event ${eventIndex}`).toEqual(next?.keys !== undefined ? { keys: next.keys } : { body: next?.body });
		if (!pending) { pending = true; queueMicrotask(advance); }
	};
	const output = new TspStream({ onData: bytes => consumed({ keys: bytes.toString() }), onMessage: message => {
		const body = JSON.parse(message.body);
		if (message.verb === "e" && body.ev !== "ack") consumed({ body });
	} });
	const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => { writes.push(data); if (data === "\x1b") consumed({ keys: data }); else output.push(Buffer.from(data)); }, onError: error => errors.push(error) });
	advance();
	return { session, writes, facts: () => composerFacts(session.snapshot().surfaces), get queued() { return queued; }, get restored() { return restored; }, finish: async () => {
		await session.drain();
		while (at < incoming.length) { const message = incoming[at++]!; session.receive({ verb: message.verb, params: {}, body: typeof message.body === "string" ? message.body : JSON.stringify(message.body) }); }
		expect(eventIndex).toBe(expected.length);
		expect(at).toBe(incoming.length);
		expect(errors).toEqual([]);
	} };
}

const scenarios = ["send-busy-steer", "follow-up-queue", "queue-escape-restore", "shell-bang", "python-dollar", "paste-large", "image-attach", "approval-send-denies", "ask-replaces-editor", "prediction-ghost", "paste-follow-up"];
describe("recorded TSP composer input", () => {
	it.each(scenarios)("drives %s through the production composer input path", async name => {
		const h = replay(name);
		if (name === "shell-bang") {
			await h.session.submit("!printf fixture-shell");
			await h.session.submit("!!printf fixture-shell-excluded");
		} else if (name === "python-dollar") await h.session.submit("$ 1+1");
		else if (name === "paste-large") await h.session.submit("Fixture large paste line.\n".repeat(5000));
		else if (name === "image-attach") await h.session.submitImages("Fixture image prompt", "/tmp/vomp-fixture/fixture.png", () => {});
		else if (name === "approval-send-denies") {
			await h.session.submit("Fixture approval prompt");
			expect(h.facts().blockedBy).toBe("approval");
			await h.session.submit("Fixture deny and steer");
		} else if (name === "ask-replaces-editor") {
			await h.session.submit("Fixture ask prompt");
			expect(h.facts()).toMatchObject({ blockedBy: "ask", sendable: false, editorId: null });
			await expect(h.session.submit("Do not type into the question")).rejects.toThrow("question card");
		} else if (name === "prediction-ghost") {
			await h.session.submit("Fixture prediction prompt");
			expect(h.facts().ghost).toBe("Run the fixture tests");
			h.session.terminalReply("\t");
			await h.session.drain();
			expect(h.facts().text).toBe("Run the fixture tests");
			await h.session.editAndKeys(0, h.facts().text.length, "", 0, "", () => {});
			expect(h.facts().text).toBe("");
		} else {
			await h.session.submit("Fixture initial prompt");
			if (name === "send-busy-steer") await h.session.submit("Fixture busy steer");
			else {
				if (name === "paste-follow-up") await h.session.paste("/tmp/vomp-fixture/fixture.png", () => {}, () => true);
				await h.session.followUp("Fixture follow-up text", () => {});
				expect(h.queued).toBe(true);
				if (name === "queue-escape-restore") {
					h.session.terminalReply("\x1b");
					await h.session.drain();
					expect(h.facts().text).toContain("Fixture follow-up text");
					await h.session.editAndKeys(0, h.facts().text.length, "", 0, "", () => {});
					expect(h.facts().text).toBe("");
				}
			}
		}
		if (name !== "ask-replaces-editor") await h.session.submit("/exit");
		await h.finish();
	});

	it("retains the original image in omp's collab user message", () => {
		const entries = JSON.parse(fixture("image-attach", "collab.json"));
		const user = entries.find((entry: { type: string; message?: { role: string } }) => entry.type === "message" && entry.message?.role === "user");
		expect(user.message.content).toContainEqual(expect.objectContaining({ type: "image", mimeType: expect.stringMatching(/^image\//), data: expect.any(String) }));
		expect(user.message.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("Fixture image prompt") }));
	});

	it("keeps edit and image paste atomic when an ack arrives during that write", async () => {
		const writes: string[] = [];
		let submitted = false;
		const session = new TspSession({ cols: 100, dark: false, reduceMotion: true, write: data => {
			writes.push(data);
			if (data.includes('"ev":"edit"')) {
				expect(data).toContain('\x1b[200~/fixture.png\x1b[201~');
				receive("f", { sf: "s", s: 2, ops: [["add", "image", "chips", null, { id: "image", k: "image", p: { alt: "Attached image" } }]] });
			}
			if (data.includes('"act":"submit"')) submitted = true;
		} });
		const receive = (verb: string, body: unknown) => session.receive({ verb, params: {}, body: JSON.stringify(body) });
		receive("q", { q: "hello", v: [1], features: ["send", "edit", "undo"] });
		receive("o", { id: "s", mode: "inline", role: "omp.session" });
		const ops: TspOp[] = [["add", "dock", "s", null, { id: "dock", k: "col", c: [{ id: "main-editor", k: "col", p: { role: "omp.editor" }, c: [{ id: "input", k: "editor", p: { text: "old draft", sendable: true } }] }, { id: "chips", k: "row", p: { role: "omp.composer.chips" } }] }], ["focus", "input"]];
		receive("f", { sf: "s", s: 1, ops });
		await session.submitImages("Image question", "/fixture.png", () => {});
		expect(submitted).toBe(true);
		const edit = writes.findIndex(data => data.includes('"ev":"edit"'));
		const ack = writes.findIndex(data => data.includes('"s":2'));
		expect(ack).toBeGreaterThan(edit);
		expect(writes[edit]).toContain('"len":9');
		expect(writes[edit + 1]).toContain('"ev":"ack"');
		expect(writes.some(data => data.includes('"ev":"send"'))).toBe(false);
	});

	it.each(["complete", "replace"] as const)("keeps credits flowing while all attachments wait (%s)", async outcome => {
		const writes: string[] = [];
		const session = new TspSession({ cols: 100, dark: false, reduceMotion: true, write: data => { writes.push(data); } });
		const receive = (verb: string, body: unknown) => session.receive({ verb, params: {}, body: JSON.stringify(body) });
		receive("q", { q: "hello", v: [1], features: ["send", "edit"] });
		receive("o", { id: "s", mode: "inline", role: "omp.session" });
		receive("f", { sf: "s", s: 1, ops: [["add", "dock", "s", null, { id: "dock", k: "col", p: { role: "omp.editor" }, c: [{ id: "input", k: "editor", p: { text: "", sendable: true } }, { id: "chips", k: "row", p: { role: "omp.composer.chips" } }] }], ["focus", "input"]] });
		const sending = session.submitImages("", "/first.png /second\\ image.png", () => {});
		const rejected = outcome === "replace" ? expect(sending).rejects.toThrow("Image submission needs recovery") : null;
		await session.drain();
		receive("f", { sf: "s", s: 2, ops: [["add", "first", "chips", null, { id: "first", k: "image", p: { alt: "First image" } }]] });
		await session.drain();
		expect(writes.some(data => data.includes('"ev":"ack","sf":"s","s":2'))).toBe(true);
		expect(writes.some(data => data.includes('"act":"submit"'))).toBe(false);
		if (outcome === "replace") {
			receive("o", { id: "s", mode: "inline", role: "omp.session" });
			await rejected;
			expect(writes.some(data => data.includes('"act":"submit"'))).toBe(false);
		} else {
			receive("f", { sf: "s", s: 3, ops: [["add", "second", "chips", null, { id: "second", k: "image", p: { alt: "Second image" } }]] });
			await sending;
			expect(writes.filter(data => data.includes('"act":"submit"'))).toHaveLength(1);
		}
	});
});
