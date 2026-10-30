import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TSP_KINDS, type TspEvent, type TspNode, type TspOp } from "../../../shared/tsp";
import { TspSession } from "./session";
import { TspStream, type TspMessage } from "./stream";

function harness(write?: (data: string) => void | Promise<void>) {
	const messages: TspMessage[] = [];
	const errors: Error[] = [];
	const output = new TspStream({ onMessage: message => messages.push(message), onData: () => {} });
	const session = new TspSession({ cols: 100, dark: false, reduceMotion: false, write: async data => {
		output.push(Buffer.from(data));
		await write?.(data);
	}, onError: error => errors.push(error) });
	const receive = (verb: string, body: unknown) => session.receive({ verb, body: JSON.stringify(body), params: {} });
	const hello = () => receive("q", { q: "hello", v: [1], features: ["edit", "undo", "send"] });
	const open = (id = "s:1", adopt = false) => receive("o", { id, mode: "inline", role: "omp.session", adopt });
	const frame = (s: number, ops: readonly TspOp[], sf = "s:1") => receive("f", { sf, s, ops });
	const flush = () => session.drain();
	const bodies = () => messages.map(message => JSON.parse(message.body));
	return { session, messages, errors, receive, hello, open, frame, flush, bodies };
}

const regions: readonly TspOp[] = [["add", "main", "s:1", null, { id: "main", k: "col" }], ["add", "dock", "s:1", null, { id: "dock", k: "col", p: { role: "omp.editor" }, c: [{ id: "editor", k: "editor", p: { text: "", sendable: false } }] }], ["focus", "editor"]];

function hasRole(node: TspNode, role: string): boolean {
	return node.p?.role === role || (node.c?.some(child => hasRole(child, role)) ?? false);
}

describe("TSP session", () => {
	it("negotiates only v1, all inspectable kinds, no terminal features, and two credits", async () => {
		const h = harness();
		h.receive("q", { q: "hello", v: [2] });
		expect(h.session.snapshot().negotiated).toBe(false);
		await h.session.resize(110);
		await h.session.theme(true);
		await h.session.motion(true);
		expect(h.messages).toEqual([]);
		h.hello();
		await h.flush();
		expect(h.bodies()[0]).toEqual({ r: "hello", v: 1, term: "visual-omp", kinds: [...TSP_KINDS], features: [], apc: 65536, credits: 2, cols: 110, dark: true, reduceMotion: true });
		expect(TSP_KINDS).toHaveLength(44);
		await h.session.resize(120);
		await h.session.theme(false);
		await h.session.motion(false);
		expect(h.bodies().slice(-3)).toEqual([{ ev: "resize", cols: 120 }, { ev: "theme", dark: false }, { ev: "motion", reduce: false }]);
	});

	it("serializes hello, ordinary DA1 replies and acknowledgments", async () => {
		const writes: string[] = [];
		const h = harness(data => { writes.push(data); });
		h.hello();
		h.session.terminalReply("\x1b[?62;22c");
		h.open();
		h.frame(1, regions);
		await h.flush();
		expect(writes[0]).toContain('"r":"hello"');
		expect(writes[1]).toBe("\x1b[?62;22c");
		expect(writes[2]).toContain('"ev":"ack"');
	});

	it("applies two in-flight frames and returns the latest cumulative ack while output is queued", async () => {
		const gate = Promise.withResolvers<void>();
		let first = true;
		const h = harness(async () => { if (first) { first = false; await gate.promise; } });
		h.hello();
		h.open();
		h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }]]);
		expect(h.session.snapshot().surfaces[0]?.sequence).toBe(2);
		expect(h.session.snapshot().surfaces[0]?.document.c?.[1]?.c?.[0]?.p).toMatchObject({ sendable: true });
		gate.resolve();
		await h.flush();
		expect(h.bodies().filter(body => body.ev === "ack")).toEqual([{ ev: "ack", sf: "s:1", s: 2 }]);
		h.frame(3, [["text", "editor", "append", "ready"]]);
		await h.flush();
		expect(h.bodies().filter(body => body.ev === "ack").at(-1)).toEqual({ ev: "ack", sf: "s:1", s: 3 });
	});

	it("keeps sequence and acknowledgments independent per surface and never reapplies old frames", async () => {
		const h = harness();
		h.hello(); h.open(); h.open("screen:1");
		h.frame(1, regions);
		h.frame(1, [["add", "main", "screen:1", null, { id: "main", k: "col" }]], "screen:1");
		h.frame(2, [["text", "editor", "append", "once"]]);
		h.frame(2, [["text", "editor", "append", "twice"]]);
		await h.flush();
		expect(h.bodies().filter(body => body.ev === "ack")).toEqual([{ ev: "ack", sf: "s:1", s: 2 }, { ev: "ack", sf: "screen:1", s: 1 }]);
		expect(h.session.snapshot().surfaces[0]?.document.c?.[1]?.c?.[0]?.p).toMatchObject({ text: "once" });
		expect(h.errors).toEqual([]);
	});

	it("reports rejected operations while applying later ops and still returning credits", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["del", "missing"], ["set", "editor", { sendable: true }]]);
		await h.flush();
		expect(h.errors.map(error => error.message)).toEqual(["unknown id missing"]);
		expect(h.bodies()).toContainEqual({ ev: "error", sf: "s:1", s: 2, op: 0, msg: "unknown id missing" });
		expect(h.bodies()).toContainEqual({ ev: "ack", sf: "s:1", s: 2 });
	});

	it("gates sends on live addressed sendable nodes and rechecks generation at the writer", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		const send: TspEvent = { ev: "send", sf: "s:1", id: "editor", text: "/btw" };
		await expect(h.session.send(send)).rejects.toThrow("not ready");
		h.frame(2, [["set", "editor", { sendable: true }]]);
		await h.session.send(send);
		expect(h.bodies()).toContainEqual(send);
		await expect(h.session.send(send, () => { throw new Error("generation changed"); })).rejects.toThrow("generation changed");
		h.receive("x", { id: "s:1", keep: true });
		await expect(h.session.send(send)).rejects.toThrow("no longer available");
	});

	it("does not claim program send support when hello omits it", async () => {
		const h = harness(); h.receive("q", { q: "hello", v: [1] }); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }]]);
		await expect(h.session.send({ ev: "send", sf: "s:1", id: "editor", text: "/btw" })).rejects.toThrow("does not accept");
	});

	it("retains main for keep-close and adopts it without resetting sequence", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.receive("x", { id: "s:1", keep: true });
		expect(h.session.snapshot().surfaces[0]).toMatchObject({ closed: true, focus: null, sequence: 1 });
		expect(h.session.snapshot().surfaces[0]?.document.c?.map(node => node.id)).toEqual(["main"]);
		h.open("s:1", true);
		h.frame(2, [["add", "dock", "s:1", null, { id: "dock", k: "col" }]]);
		await h.flush();
		expect(h.session.snapshot().surfaces[0]).toMatchObject({ closed: false, sequence: 2 });
		h.receive("x", { id: "s:1", keep: false });
		expect(h.session.snapshot().surfaces).toEqual([]);
		h.open("s:missing", true);
		await h.flush();
		expect(h.bodies()).toContainEqual({ ev: "gone", ids: ["s:missing"] });
	});

	it("returns the last applied credit even if close removes the document before output drains", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.receive("x", { id: "s:1", keep: false });
		await h.flush();
		expect(h.session.snapshot().surfaces).toEqual([]);
		expect(h.bodies()).toContainEqual({ ev: "ack", sf: "s:1", s: 1 });
	});

	it("ignores future verbs and recovers from malformed envelopes", async () => {
		const h = harness(); h.hello();
		h.session.receive({ verb: "future", params: {}, body: "not JSON" });
		h.session.receive({ verb: "f", params: {}, body: "not JSON" });
		h.receive("f", { sf: "s:1", s: -1, ops: [] });
		h.open(); h.frame(1, regions);
		await h.flush();
		expect(h.errors.map(error => error.message)).toEqual(["Invalid TSP JSON", "Invalid TSP frame"]);
		expect(h.bodies()).toContainEqual({ ev: "ack", sf: "s:1", s: 1 });
	});

	it("replays the pinned live capture through negotiation, BTW overlay, acks and retained close", async () => {
		const raw = readFileSync(new URL("./fixtures/omp-18.14.bin", import.meta.url));
		const h = harness();
		let sawBtw = false;
		const stream = new TspStream({ onData: () => {}, onMessage: message => {
			h.session.receive(message);
			sawBtw ||= h.session.snapshot().surfaces.some(surface => hasRole(surface.document, "omp.overlay.btwHistory"));
		} });
		for (let at = 0; at < raw.length; at += 7) stream.push(raw.subarray(at, at + 7));
		stream.end();
		await h.flush();
		expect(h.session.snapshot().negotiated).toBe(true);
		expect(sawBtw).toBe(true);
		expect(h.session.snapshot().surfaces[0]?.closed).toBe(true);
		expect(h.bodies().filter(body => body.ev === "ack").length).toBeGreaterThan(0);
		expect(h.errors).toEqual([]);
	});

	it("submits through the fixture's id-based dock and nested main composer", async () => {
		const raw = readFileSync(new URL("./fixtures/omp-18.14.bin", import.meta.url));
		const incoming: TspMessage[] = [];
		const stream = new TspStream({ onData: () => {}, onMessage: message => incoming.push(message) });
		stream.push(raw);
		stream.end();
		const h = harness();
		let target: { sf: string; id: string } | undefined;
		for (const message of incoming) {
			h.session.receive(message);
			for (const surface of h.session.snapshot().surfaces) {
				const focusedReady = (node: TspNode): boolean => (node.id === surface.focus && node.k === "editor" && node.p?.sendable === true) || (node.c?.some(focusedReady) ?? false);
				if (surface.focus && focusedReady(surface.document)) target = { sf: surface.open.id, id: surface.focus };
			}
			if (target) break;
		}
		expect(target).toBeDefined();
		await h.session.submit("/btw");
		expect(h.bodies().filter(body => body.ev === "send")).toEqual([{ ev: "send", ...target, text: "/btw" }]);
		expect(h.errors).toEqual([]);
	});

	it("rejects malformed renderer events and foreign visible surfaces without writing", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions); await h.flush();
		const before = h.messages.length;
		for (const event of [
			{ ev: "ack", sf: "s:1", s: 99 },
			{ ev: "visible", visible: true },
			{ ev: "visible", sf: "foreign", visible: true },
			{ ev: "send", sf: "s:1", id: "editor", text: "hello", extra: true },
			{ ev: "change", sf: "s:1", id: "editor", item: "x" },
			{ ev: "change", sf: "s:1", id: "editor", item: "x", value: {} },
			{ ev: "action", sf: "s:1", id: "editor", act: "test", mods: 3 },
			{ ev: "edit", sf: "s:1", id: "editor", from: -1, to: 0, text: "", cursor: 0, len: 0 },
			{ ev: "edit", sf: "s:1", id: "editor", from: 0, to: 0, text: "", cursor: Infinity, len: 0 },
			{ ev: "edit", sf: "s:1", id: "editor", from: 1, to: 0, text: "", cursor: 0, len: 0 },
		]) await expect(h.session.send(event)).rejects.toThrow("TSP preview:");
		expect(h.messages).toHaveLength(before);
	});

	it("encodes the parsed renderer event rather than a subsequently mutated caller object", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions); await h.flush();
		const event = { ev: "visible", sf: "s:1", visible: true };
		const sending = h.session.send(event);
		event.sf = "foreign";
		await sending;
		expect(h.bodies().at(-1)).toEqual({ ev: "visible", sf: "s:1", visible: true });
	});

	it("rejects structurally unsafe frame ops without escaping the byte-stream callback", async () => {
		const h = harness(); h.hello(); h.open();
		const ordinary: Buffer[] = [];
		const stream = new TspStream({ onMessage: message => h.session.receive(message), onData: bytes => ordinary.push(bytes) });
		for (const ops of [[["add"]], [["add", "bad", "s:1", null, { id: "bad", k: "col", c: [null] }]]]) {
			expect(() => stream.push(Buffer.from(`\x1b_tsp;f;${JSON.stringify({ sf: "s:1", s: 1, ops })}\x1b\\ordinary`))).not.toThrow();
		}
		await h.flush();
		expect(Buffer.concat(ordinary).toString()).toBe("ordinaryordinary");
		expect(h.errors.map(error => error.message)).toEqual(["Invalid TSP frame", "Invalid TSP frame"]);
	});

	it("submits text atomically through the main focused sendable composer without editing its draft", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		await expect(h.session.submit("hello")).rejects.toThrow("not ready");
		h.frame(2, [["set", "editor", { sendable: true, text: "existing draft" }]]);
		await h.session.submit("/btw");
		expect(h.bodies().filter(body => body.ev === "send")).toEqual([{ ev: "send", sf: "s:1", id: "editor", text: "/btw" }]);
		expect(h.session.snapshot().surfaces[0]?.document.c?.[1]?.c?.[0]?.p).toMatchObject({ text: "existing draft" });
		for (const text of ["", "!pwd", "$print(1)"]) await expect(h.session.submit(text)).rejects.toThrow("not available");
	});

	it("refuses hook, shell, modal and subagent composers as main app submission targets", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }], ["set", "dock", { role: "omp.field" }]]);
		await expect(h.session.submit("hello")).rejects.toThrow("main editor");
		h.frame(3, [["set", "dock", { role: "omp.editor.shell" }]]);
		await expect(h.session.submit("hello")).rejects.toThrow("main editor");
		h.frame(4, [["set", "dock", { role: "omp.editor" }], ["add", "layer", "s:1", null, { id: "layer", k: "col", c: [{ id: "modal", k: "overlay", p: { modal: true } }] }]]);
		await expect(h.session.submit("hello")).rejects.toThrow("main editor");
		h.frame(5, [["del", "layer"], ["add", "viewing", "dock", null, { id: "viewing", k: "row", p: { role: "omp.composer.focus" } }]]);
		await expect(h.session.submit("hello")).rejects.toThrow("main editor");
		expect(h.bodies().filter(body => body.ev === "send")).toEqual([]);
	});

	it("rechecks sendable and selected target identity at the serialized writer", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }]]);
		const sending = h.session.submit("hello");
		const rejected = expect(sending).rejects.toThrow("not ready");
		h.frame(3, [["set", "editor", { sendable: false }]]);
		await rejected;
		h.frame(4, [["set", "editor", { sendable: true }]]);
		const replaced = h.session.submit("hello");
		const stale = expect(replaced).rejects.toThrow("changed");
		h.open();
		await stale;
		expect(h.bodies().filter(body => body.ev === "send")).toEqual([]);
	});

	it("excludes stale surfaces when selecting the main composer and rechecks that predicate", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }]]);
		h.open("s:2");
		h.frame(1, [["add", "dock", "s:2", null, { id: "dock", k: "col", p: { role: "omp.editor" }, c: [{ id: "new-editor", k: "editor", p: { sendable: true } }] }], ["focus", "new-editor"]], "s:2");
		let current = true;
		await h.session.submit("hello", undefined, sf => sf === "s:2");
		expect(h.bodies().filter(body => body.ev === "send")).toEqual([{ ev: "send", sf: "s:2", id: "new-editor", text: "hello" }]);
		const sending = h.session.submit("again", undefined, sf => current && sf === "s:2");
		current = false;
		await expect(sending).rejects.toThrow("changed");
	});
});
