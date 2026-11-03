import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { composerFacts } from "./composer";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import type { TspOp } from "../../../shared/tsp";

const fixture = (name: string, suffix: string, version = "18.15.0") => readFileSync(new URL(`./fixtures/${version}/${name}.${suffix}`, import.meta.url), "utf8");
interface RecordedEvent { verb?: string; body?: { ev: string }; keys?: string; afterMessage: number }
interface RecordedMessage { verb: string; body: unknown }

/** The fake program advances only after the next recorded application event matches. */
function replay(name: string, version = "18.15.0") {
	const incoming: RecordedMessage[] = [];
	const raw = readFileSync(new URL(`./fixtures/${version}/${name}.raw.bin`, import.meta.url));
	const integrity = JSON.parse(fixture(name, "integrity.json", version));
	expect({ bytes: raw.length, carriageReturns: raw.filter(byte => byte === 13).length, sha256: createHash("sha256").update(raw).digest("hex") }).toEqual(integrity);
	expect(raw.toString()).not.toMatch(/\/Users\/|vomp-tsp-record-/);
	const parser = new TspStream({ onData: () => {}, onMessage: message => incoming.push({ verb: message.verb, body: message.verb === "b" ? message.body : JSON.parse(message.body) }) });
	for (let offset = 0; offset < raw.length; offset += 7) parser.push(raw.subarray(offset, offset + 7));
	parser.end();
	expect(incoming).toEqual(fixture(name, "messages.jsonl", version).trim().split("\n").map(line => JSON.parse(line)));
	const expected: RecordedEvent[] = fixture(name, "events.jsonl", version).trim().split("\n").map(line => JSON.parse(line))
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

	it("replays image markers before text with omp's separator intact", async () => {
		const h = replay("image-attach");
		await h.session.submitImages("Fixture image prompt", "/tmp/vomp-fixture/fixture.png", () => {});
		const application: RecordedEvent[] = [];
		const output = new TspStream({
			onData: bytes => application.push({ keys: bytes.toString(), afterMessage: 0 }),
			onMessage: message => {
				const body = JSON.parse(message.body);
				if (message.verb === "e" && body.ev !== "ack") application.push({ body, afterMessage: 0 });
			},
		});
		for (const write of h.writes) output.push(Buffer.from(write));
		expect(application.map(({ afterMessage: _, ...event }) => event)).toEqual([
			{ body: { ev: "edit", sf: "s:1", id: "g.line/input", from: 0, to: 0, text: "", cursor: 0, len: 0 } },
			{ keys: "\x1b[200~/tmp/vomp-fixture/fixture.png\x1b[201~" },
			{ body: { ev: "edit", sf: "s:1", id: "g.line/input", from: 5, to: 5, text: "Fixture image prompt", cursor: 25, len: 5 } },
			{ body: { ev: "action", sf: "s:1", id: "g.line/input", act: "submit" } },
		]);
		const append = h.writes.find(write => write.includes('"text":"Fixture image prompt"'));
		expect(append).toContain('"act":"submit"');
		await h.session.submit("/exit");
		await h.finish();
	});

	it("retains the original image in omp's collab user message", () => {
		const entries = JSON.parse(fixture("image-attach", "collab.json"));
		const user = entries.find((entry: { type: string; message?: { role: string } }) => entry.type === "message" && entry.message?.role === "user");
		expect(user.message.content).toContainEqual(expect.objectContaining({ type: "image", mimeType: expect.stringMatching(/^image\//), data: expect.any(String) }));
		expect(user.message.content).toContainEqual({ type: "text", text: "[Image #1, 200x200] Fixture image prompt" });
		const provider = JSON.parse(fixture("image-attach", "provider.json"));
		const content = provider[0].messages.filter((message: { role: string; content: unknown }) => message.role === "user" && Array.isArray(message.content))
			.flatMap((message: { content: unknown[] }) => message.content);
		expect(content).toContainEqual({ type: "text", text: "[Image #1, 200x200] Fixture image prompt" });
	});

	it.each(["18.15.0", "18.16.0"])("replays rejected bad-CRC image recovery from omp %s", async version => {
		const h = replay("image-reject", version);
		await h.session.editAndKeys(0, 0, "Keep café 🧭 draft", 5, "", () => {});
		await expect(h.session.submitImages("Fixture rejected image prompt", "./live-check.png", () => {}))
			.rejects.toMatchObject({ recovery: "restored", message: "TSP preview: Image submission was restored. Failed to read pasted image path" });
		expect(h.facts()).toMatchObject({ text: "Keep café 🧭 draft", cursor: 5, blockedBy: null });
		expect(h.session.imageCount(h.facts().surfaceId!)).toBe(0);
		expect(h.writes.some(write => write.includes('"act":"submit"'))).toBe(false);
		expect(JSON.parse(fixture("image-reject", "provider.json", version))).toEqual([]);
		await h.session.submit("/exit");
		await h.finish();
	});

	it.each(["restored", "retained", "replaced", "unconfirmed", "generation"] as const)("retains actionable failure classification with autocomplete (%s)", async outcome => {
		vi.useFakeTimers();
		try {
			const writes: string[] = [];
			let sequence = 1;
			let generation = 1;
			const session = new TspSession({ cols: 100, dark: false, reduceMotion: true, write: data => {
				writes.push(data);
				if (data.includes("\x1b[200~")) {
					if (outcome === "replaced") {
						receive("f", { sf: "s", s: ++sequence, ops: [["del", "input"], ["add", "input", "editor", null, { id: "input", k: "editor", p: { text: "Replacement draft", sendable: true } }], ["focus", "input"]] });
					} else {
						if (outcome === "generation") generation++;
						receive("f", { sf: "s", s: ++sequence, ops: [
							["set", "input", { text: "/bad.png", cursor: 8 }],
							outcome === "retained"
								? ["set", "failure", { text: "Failed to read pasted image path" }]
								: ["add", "failure", "main", null, { id: "failure", k: "toast", p: { role: "omp.toast.status", text: "Failed to read pasted image path" } }],
							["add", "complete", "layer", null, { id: "complete", k: "overlay", p: { role: "omp.autocomplete" } }],
						] });
					}
				} else if (data.includes('"text":"Keep café 🧭 draft"') && (outcome === "restored" || outcome === "retained")) {
					receive("f", { sf: "s", s: ++sequence, ops: [["set", "input", { text: "Keep café 🧭 draft", cursor: 5 }], ["del", "complete"]] });
				}
			} });
			const receive = (verb: string, body: unknown) => session.receive({ verb, params: {}, body: JSON.stringify(body) });
			receive("q", { q: "hello", v: [1], features: ["send", "edit"] });
			receive("o", { id: "s", mode: "inline", role: "omp.session" });
			receive("f", { sf: "s", s: sequence, ops: [
				["add", "main", "s", null, { id: "main", k: "col", ...(outcome === "retained" ? { c: [{ id: "failure", k: "toast", p: { role: "omp.toast.status", text: "Failed to read pasted image path" } }] } : {}) }],
				["add", "layer", "s", null, { id: "layer", k: "col" }],
				["add", "dock", "s", null, { id: "dock", k: "col", c: [{ id: "editor", k: "col", p: { role: "omp.editor" }, c: [{ id: "input", k: "editor", p: { text: "Keep café 🧭 draft", cursor: 5, sendable: true } }] }, { id: "chips", k: "row", p: { role: "omp.composer.chips" } }] }],
				["focus", "input"],
			] });
			const sending = session.submitImages("Question", "/bad.png", () => { if (generation !== 1) throw new Error("Connection changed"); });
			const rejected = expect(sending).rejects.toMatchObject({ recovery: outcome === "restored" || outcome === "retained" ? "restored" : "required" });
			await vi.runAllTimersAsync();
			await rejected;
			expect(writes.some(write => write.includes('"act":"submit"'))).toBe(false);
			if (outcome === "restored" || outcome === "retained") {
				expect(composerFacts(session.snapshot().surfaces)).toMatchObject({ text: "Keep café 🧭 draft", cursor: 5, blockedBy: null });
				expect(writes.find(write => write.includes('"text":"Keep café 🧭 draft"'))).toContain('"to":8');
			} else if (outcome === "replaced") expect(composerFacts(session.snapshot().surfaces).text).toBe("Replacement draft");
			else if (outcome === "generation") expect(writes.some(write => write.includes('"text":"Keep café 🧭 draft"'))).toBe(false);
		} finally { vi.useRealTimers(); }
	});

	it.each(["", "Keep draft"])("removes staged images and stops later paths after rejection (draft %j)", async draft => {
		const writes: string[] = [];
		let sequence = 1;
		const session = new TspSession({ cols: 100, dark: false, reduceMotion: true, write: data => {
			writes.push(data);
			if (data.includes("\x1b[200~/first.png")) {
				receive("f", { sf: "s", s: ++sequence, ops: [["set", "input", { text: "\uf03e #1 ", cursor: 5 }], ["add", "first", "chips", null, { id: "first", k: "image", p: { alt: "First image" } }]] });
			} else if (data.includes("\x1b[200~/bad.png")) {
				receive("f", { sf: "s", s: ++sequence, ops: [
					["set", "input", { text: "\uf03e #1 /bad.png", cursor: 13 }],
					["add", "failure", "main", null, { id: "failure", k: "toast", p: { role: "omp.toast.status", text: "Failed to read pasted image path" } }],
				] });
			} else if (data.includes('"ev":"edit"')) {
				receive("f", { sf: "s", s: ++sequence, ops: [["set", "input", { text: draft, cursor: draft.length }], ["del", "first"]] });
			}
		} });
		const receive = (verb: string, body: unknown) => session.receive({ verb, params: {}, body: JSON.stringify(body) });
		receive("q", { q: "hello", v: [1], features: ["send", "edit"] });
		receive("o", { id: "s", mode: "inline", role: "omp.session" });
		receive("f", { sf: "s", s: sequence, ops: [
			["add", "main", "s", null, { id: "main", k: "col" }],
			["add", "dock", "s", null, { id: "dock", k: "col", p: { role: "omp.editor" }, c: [{ id: "input", k: "editor", p: { text: draft, cursor: draft.length, sendable: true } }, { id: "chips", k: "row", p: { role: "omp.composer.chips" } }] }],
			["focus", "input"],
		] });
		await expect(session.submitImages("", "/first.png /bad.png /never.png", () => {}))
			.rejects.toMatchObject({ recovery: "restored", message: "TSP preview: Image submission was restored. Failed to read pasted image path" });
		expect(composerFacts(session.snapshot().surfaces)).toMatchObject({ text: draft, cursor: draft.length });
		expect(session.imageCount("s")).toBe(0);
		expect(writes.some(write => write.includes("/never.png") || write.includes('"act":"submit"'))).toBe(false);
	});

	it("keeps image staging and the later append plus submit atomic around acknowledgments", async () => {
		const writes: string[] = [];
		let submitted = false;
		const session = new TspSession({ cols: 100, dark: false, reduceMotion: true, write: data => {
			writes.push(data);
			if (data.includes("\x1b[200~")) {
				expect(data).toContain('"text":"","cursor":0,"len":9');
				expect(data).toContain('\x1b[200~/fixture.png\x1b[201~');
				receive("f", { sf: "s", s: 2, ops: [["set", "input", { text: "IMAGE #1 ", cursor: 9 }], ["add", "image", "chips", null, { id: "image", k: "image", p: { alt: "Attached image" } }]] });
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
		const append = writes.find(data => data.includes('"text":"Image question"'));
		expect(append).toContain('"from":9,"to":9');
		expect(append).toContain('"act":"submit"');
		expect(writes.some(data => data.includes('"ev":"send"'))).toBe(false);
	});

	it.each(["complete", "replace"] as const)("keeps credits flowing while all attachments wait (%s)", async outcome => {
		const writes: string[] = [];
		const secondPasteWritten = Promise.withResolvers<void>();
		const session = new TspSession({ cols: 100, dark: false, reduceMotion: true, write: data => {
			writes.push(data);
			if (data.includes("\x1b[200~/second\\ image.png\x1b[201~")) secondPasteWritten.resolve();
		} });
		const receive = (verb: string, body: unknown) => session.receive({ verb, params: {}, body: JSON.stringify(body) });
		receive("q", { q: "hello", v: [1], features: ["send", "edit"] });
		receive("o", { id: "s", mode: "inline", role: "omp.session" });
		receive("f", { sf: "s", s: 1, ops: [["add", "dock", "s", null, { id: "dock", k: "col", p: { role: "omp.editor" }, c: [{ id: "input", k: "editor", p: { text: "", sendable: true } }, { id: "chips", k: "row", p: { role: "omp.composer.chips" } }] }], ["focus", "input"]] });
		const sending = session.submitImages("", "/first.png /second\\ image.png", () => {});
		const rejected = outcome === "replace" ? expect(sending).rejects.toThrow("Image submission needs recovery") : null;
		await session.drain();
		receive("f", { sf: "s", s: 2, ops: [["set", "input", { text: "\uf03e #1 ", cursor: 5 }], ["add", "first", "chips", null, { id: "first", k: "image", p: { alt: "First image" } }]] });
		await session.drain();
		expect(writes.some(data => data.includes('"ev":"ack","sf":"s","s":2'))).toBe(true);
		expect(writes.some(data => data.includes('"act":"submit"'))).toBe(false);
		if (outcome === "replace") {
			receive("o", { id: "s", mode: "inline", role: "omp.session" });
			await rejected;
			expect(writes.some(data => data.includes('"act":"submit"'))).toBe(false);
		} else {
			await secondPasteWritten.promise;
			expect(writes.find(data => data.includes("\x1b[200~/second\\ image.png\x1b[201~"))).toContain('"from":5,"to":5,"text":"","cursor":5,"len":5');
			receive("f", { sf: "s", s: 3, ops: [["set", "input", { text: "\uf03e #1 \uf03e #2 ", cursor: 10 }], ["add", "second", "chips", null, { id: "second", k: "image", p: { alt: "Second image" } }]] });
			await sending;
			expect(writes.filter(data => data.includes('"act":"submit"'))).toHaveLength(1);
			const submit = writes.find(data => data.includes('"act":"submit"'));
			expect(submit).toContain('"from":10,"to":10,"text":"","cursor":10,"len":10');
			expect(writes.some(data => data.includes("\x1b[200~\x1b[201~"))).toBe(false);
		}
	});
});
