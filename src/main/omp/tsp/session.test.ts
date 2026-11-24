import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TSP_KINDS, type TspEvent, type TspNode, type TspOp } from "../../../shared/tsp";
import { openOverlay } from "../../../shared/tsp/view-state";
import { TSP_ROLES } from "../../../shared/tsp/roles";
import { composerFacts } from "./composer";
import { TspSession, TSP_ADVERTISED_KINDS } from "./session";
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

const askRegions: readonly TspOp[] = [
	["add", "main", "s:1", null, { id: "main", k: "col" }],
	["add", "dock", "s:1", null, { id: "dock", k: "col", c: [
		{ id: "ask", k: "col", p: { role: "omp.editor.ask" }, c: [
			{ id: "question", k: "md", p: { role: "omp.ask.question", text: "First smoke question?" } },
			{ id: "options", k: "list", p: { role: "omp.ask.options", selected: "sqlite" }, c: [{ id: "sqlite", k: "item", p: { label: "SQLite" } }] },
		] },
	] }],
	["add", "layer", "s:1", null, { id: "layer", k: "col" }],
	["focus", null],
];

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
		expect(h.bodies()[0]).toEqual({ r: "hello", v: 1, term: "visual-omp", kinds: [...TSP_ADVERTISED_KINDS], features: [], apc: 65536, credits: 2, cols: 110, dark: true, reduceMotion: true });
		expect(TSP_KINDS).toHaveLength(50);
		expect(TSP_KINDS).toContain("button");
		expect(TSP_KINDS).toContain("menu");
		expect(TSP_ADVERTISED_KINDS).toContain("menu");
		expect(TSP_ADVERTISED_KINDS).not.toContain("doc");
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

	it("asks omp to recreate an evicted inline document and ignores its already-in-flight frames", async () => {
		const h = harness();
		h.hello(); h.open(); h.frame(1, regions);
		await h.flush();
		h.session.refreshInlineSurface(() => true);
		await h.flush();
		expect(h.bodies().at(-1)).toEqual({ ev: "gone", ids: ["s:1"] });
		expect(h.session.snapshot().surfaces).toEqual([]);
		h.frame(2, [["set", "editor", { sendable: true }]]);
		expect(h.errors).toEqual([]);
		h.open("s:2");
		h.frame(1, [["add", "dock", "s:2", null, { id: "dock", k: "col", p: { role: "omp.editor" }, c: [{ id: "editor", k: "editor", p: { sendable: true, text: "" } }] }], ["focus", "editor"]], "s:2");
		expect(h.session.availability().available).toBe(true);
		await h.session.submit("Current native document");
		expect(h.bodies().at(-1)).toMatchObject({ ev: "send", sf: "s:2", id: "editor", text: "Current native document" });
	});

	it.each(["epoch", "scope"] as const)("cancels a queued inline refresh when its %s changes", async changed => {
		const h = harness();
		h.hello(); h.open(); h.frame(1, regions); await h.flush();
		let current = true;
		h.session.refreshInlineSurface(() => current);
		if (changed === "epoch") { h.hello(); h.open(); h.frame(1, regions); }
		else current = false;
		await h.flush();
		expect(h.bodies().some(body => body.ev === "gone")).toBe(false);
		expect(h.session.snapshot().surfaces[0]?.open.id).toBe("s:1");
		expect(h.errors).toEqual([]);
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

	it("never emits undo when omp did not advertise the capability", async () => {
		const h = harness();
		h.receive("q", { q: "hello", v: [1], features: ["send", "edit"] });
		h.open(); h.frame(1, regions); h.frame(2, [["set", "editor", { sendable: true }]]);
		await expect(h.session.send({ ev: "undo", sf: "s:1", id: "editor" })).rejects.toThrow("does not accept undo");
		expect(h.bodies().some(body => body.ev === "undo")).toBe(false);
	});

	it("distinguishes temporary editor unavailability and rejected additions from lifetime end", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }]]);
		const target = h.session.pinEditor();
		h.frame(3, [["add", "editor", "dock", null, { id: "editor", k: "editor", p: { text: "Rejected replacement", sendable: true } }]]);
		expect(target.ended()).toBe(false);
		expect(() => target.assertCurrent()).not.toThrow();
		h.frame(4, [["suspend"]]);
		expect(target.ended()).toBe(false);
		expect(() => target.assertCurrent()).toThrow("temporarily unavailable");
		h.frame(5, [["resume"]]);
		expect(() => target.assertCurrent()).not.toThrow();
		h.frame(6, [["del", "editor"], ["add", "editor", "dock", null, { id: "editor", k: "editor", p: { text: "Replacement", sendable: true } }], ["focus", "editor"]]);
		expect(target.ended()).toBe(true);
		await h.flush();
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
		const raw = readFileSync(new URL("./fixtures/18.15.0/btw-history.raw.bin", import.meta.url));
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
		const raw = readFileSync(new URL("./fixtures/18.15.0/btw-history.raw.bin", import.meta.url));
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
		]) await expect(h.session.send(event)).rejects.toThrow("omp screen:");
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
		await expect(h.session.submit("")).rejects.toThrow("Enter a message");
		for (const text of ["!pwd", "!!pwd", "$ print(1)"]) await h.session.submit(text);
		expect(h.bodies().filter(body => body.ev === "send").slice(-3).map(body => body.text)).toEqual(["!pwd", "!!pwd", "$ print(1)"]);
	});

	it("closes omp's editor suggestions with Escape before sending, instead of treating them as an open menu", async () => {
		const writes: string[] = [];
		const h = harness(data => { writes.push(data); });
		h.hello(); h.open(); h.frame(1, regions);
		// omp 19 offers GitHub references for `#30` and hoists the list into the layer, where it can hold the focus.
		h.frame(2, [["set", "editor", { sendable: true, text: "close #30" }], ["add", "layer", "s:1", null, { id: "layer", k: "col", c: [
			{ id: "complete", k: "overlay", p: { role: "omp.autocomplete", anchor: { caret: "input" } }, c: [
				{ id: "refs", k: "list", p: { selected: "pr" }, c: [{ id: "pr", k: "item", p: { label: [{ t: "PR #30" }] } }, { id: "issue", k: "item", p: { label: [{ t: "Issue #30" }] } }] },
			] },
		] }], ["focus", "refs"]]);
		expect(h.session.availability()).toEqual({ available: true, reason: null });
		expect(openOverlay(h.session.snapshot().surfaces)).toBeNull();
		const sent = h.session.submit("Close #29 and #30.");
		await vi.waitFor(() => expect(writes).toContain("\x1b"));
		expect(h.bodies().some(body => body.ev === "send")).toBe(false);
		h.frame(3, [["del", "complete"], ["focus", "editor"]]);
		await sent;
		expect(h.bodies().filter(body => body.ev === "send")).toEqual([{ ev: "send", sf: "s:1", id: "editor", text: "Close #29 and #30." }]);
	});

	const suggestionsLayer = (): TspOp => ["add", "layer", "s:1", null, { id: "layer", k: "col", c: [
		{ id: "complete", k: "overlay", p: { role: "omp.autocomplete" }, c: [{ id: "refs", k: "list", c: [{ id: "pr", k: "item", p: { label: [{ t: "PR #30" }] } }] }] },
	] }];

	it("sends no Escape when another omp overlay takes input before its suggestions can close", async () => {
		const writes: string[] = [];
		const h = harness(data => { writes.push(data); });
		h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }], suggestionsLayer()]);
		const sent = h.session.submit("hello");
		h.frame(3, [["add", "modal", "layer", null, { id: "modal", k: "overlay", p: { modal: true } }]]);
		await expect(sent).rejects.toThrow("not ready");
		expect(writes).not.toContain("\x1b");
		expect(h.bodies().some(body => body.ev === "send")).toBe(false);
	});

	it("sends no Escape when an approval prompt appears before its suggestions can close", async () => {
		const writes: string[] = [];
		const h = harness(data => { writes.push(data); });
		h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }], suggestionsLayer()]);
		const sent = h.session.submit("hello");
		h.frame(3, [["add", "approval", "dock", null, { id: "approval", k: "list", p: { role: TSP_ROLES.approvalChoices }, c: [{ id: "yes", k: "item", p: { label: [{ t: "Allow" }] } }] }]]);
		await expect(sent).rejects.toThrow("Answer omp's prompt");
		expect(writes).not.toContain("\x1b");
	});

	it.each(["submit", "followUp"] as const)("refuses %s when omp reopens its suggestions before the final write", async path => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }]]);
		const sent = path === "submit" ? h.session.submit("hello") : h.session.followUp("hello", () => {});
		h.frame(3, [suggestionsLayer()]);
		await expect(sent).rejects.toThrow("opened its suggestions");
		expect(h.bodies().some(body => body.ev === "send" || body.ev === "edit")).toBe(false);
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

	it.each(["expanded", "hidden", "Other", "series"] as const)("identifies the rich %s ask dock without enabling semantic send", async kind => {
		const h = harness(); h.hello(); h.open(); h.frame(1, askRegions);
		if (kind === "hidden") h.frame(2, [["set", "ask", { role: "omp.editor.ask.hidden" }]]);
		if (kind === "Other") h.frame(2, [["add", "custom", "ask", null, { id: "custom", k: "editor", p: { text: "", sendable: false } }], ["focus", "custom"]]);
		if (kind === "series") h.frame(2, [["add", "tabs", "ask", null, { id: "tabs", k: "tabs", p: { role: "omp.ask.questions", items: [{ id: "q1", label: "First" }, { id: "q2", label: "Second" }], active: "q1" } }]]);
		expect(h.session.availability()).toMatchObject({ available: false, reasonCode: "ask-editor" });
		await expect(h.session.submit("Use Postgres.")).rejects.toThrow("not ready");
		expect(h.bodies().some(body => body.ev === "send")).toBe(false);
	});

	it.each(["suspended", "stale", "screen", "menu", "hook", "shell", "PTY", "subagent", "foreign-focus", "approval-root", "sibling-approval", "other-surface"] as const)("does not authorize collab ask bypass for %s ownership", kind => {
		const h = harness(); h.hello(); h.open(); h.frame(1, askRegions);
		if (kind === "suspended") h.frame(2, [["suspend"]]);
		if (kind === "screen") h.receive("o", { id: "settings", mode: "screen" });
		if (kind === "menu") h.frame(2, [["add", "menu", "layer", null, { id: "menu", k: "overlay" }]]);
		if (kind === "hook") h.frame(2, [["add", "hook", "dock", null, { id: "hook", k: "col", p: { role: "omp.overlay.hook-input" } }]]);
		if (kind === "shell") h.frame(2, [["add", "shell", "dock", null, { id: "shell", k: "col", p: { role: "omp.editor.shell" } }]]);
		if (kind === "PTY") h.frame(2, [["add", "pty", "ask", null, { id: "pty", k: "editor", p: { mode: "PTY" } }]]);
		if (kind === "subagent") h.frame(2, [["add", "viewing", "dock", null, { id: "viewing", k: "row", p: { role: "omp.composer.focus" } }]]);
		if (kind === "foreign-focus") h.frame(2, [["add", "foreign", "dock", null, { id: "foreign", k: "input", p: { text: "" } }], ["focus", "foreign"]]);
		if (kind === "approval-root") h.frame(2, [["set", "ask", { role: "omp.editor.ask.approval" }]]);
		if (kind === "sibling-approval") h.frame(2, [["add", "approval", "dock", null, { id: "approval", k: "col", p: { role: "omp.editor.ask.approval" } }]]);
		if (kind === "other-surface") h.receive("o", { id: "other", mode: "inline" });
		expect(h.session.availability(kind === "stale" ? () => false : undefined).reasonCode).toBeUndefined();
	});

	it("treats omp 19's waiting ask card like the ask editor, and only while nothing else holds focus", () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }], ["add", "card", "main", null, { id: "card", k: "col", p: { role: "omp.ask.card" } }], ["focus", null]]);
		expect(h.session.availability()).toMatchObject({ available: false, reasonCode: "ask-editor" });
		h.frame(3, [["add", "viewing", "dock", null, { id: "viewing", k: "row", p: { role: "omp.composer.focus" } }]]);
		expect(h.session.availability().reasonCode).toBeUndefined();
		h.frame(4, [["del", "viewing"], ["focus", "editor"]]);
		expect(h.session.availability()).toMatchObject({ available: true });
		h.frame(5, [["del", "card"], ["focus", null]]);
		expect(h.session.availability().reasonCode).toBeUndefined();
	});

	it("sends omp 19's ask card fold and pill actions only for the declaring control inside a visible card", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		// Shapes from omp 19.0.0's recorded ask card: a fold opens its question and a pill picks its option.
		h.frame(2, [
			["add", "card", "main", null, { id: "card", k: "col", p: { role: "omp.ask.card" }, c: [
				{ id: "fold", k: "col", p: { role: "omp.ask.fold", title: "Answer this question", actions: { click: "open:2" } }, c: [{ id: "question", k: "text", p: { role: "omp.ask.fold.question", spans: [{ t: "Release note headline" }] } }] },
				{ id: "pill", k: "button", p: { role: "omp.ask.pill", text: "Linux", size: "sm", actions: { click: "pick:1:2" } } },
				{ id: "busy", k: "button", p: { role: "omp.ask.pill", text: "Quick", size: "sm", disabled: true, actions: { click: "pick:3:0" } } },
			] }],
			["add", "outside", "main", null, { id: "outside", k: "button", p: { text: "Linux", actions: { click: "pick:1:2" } } }],
		]);
		await h.flush();
		await h.session.send({ ev: "action", sf: "s:1", id: "fold", act: "open:2" });
		await h.session.send({ ev: "action", sf: "s:1", id: "pill", act: "pick:1:2" });
		for (const [id, act] of [["pill", "pick:1:0"], ["fold", "pick:1:2"], ["busy", "pick:3:0"], ["outside", "pick:1:2"]] as const) {
			await expect(h.session.send({ ev: "action", sf: "s:1", id, act })).rejects.toThrow("question card no longer offers this action");
		}
		h.frame(3, [["set", "card", { role: "omp.ask.card", hidden: true }]]);
		await h.flush();
		await expect(h.session.send({ ev: "action", sf: "s:1", id: "pill", act: "pick:1:2" })).rejects.toThrow("question card no longer offers this action");
		expect(h.bodies().filter(body => body.ev === "action")).toEqual([
			{ ev: "action", sf: "s:1", id: "fold", act: "open:2" },
			{ ev: "action", sf: "s:1", id: "pill", act: "pick:1:2" },
		]);
	});

	it("does not confuse missing, unnegotiated or send-unsupported surfaces with rich asks", () => {
		const h = harness();
		expect(h.session.availability().reasonCode).toBeUndefined();
		h.hello();
		expect(h.session.availability().reasonCode).toBeUndefined();
		h.open(); h.frame(1, [["add", "dock", "s:1", null, { id: "dock", k: "col" }]]);
		expect(h.session.availability().reasonCode).toBeUndefined();
		const unsupported = harness(); unsupported.receive("q", { q: "hello", v: [1] }); unsupported.open(); unsupported.frame(1, askRegions);
		expect(unsupported.session.availability().reasonCode).toBeUndefined();
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
	it("starts a new epoch and drops queued old events and credits on a second hello", async () => {
		const h = harness(); h.hello(); h.open(); h.frame(1, regions);
		h.frame(2, [["set", "editor", { sendable: true }]]);
		await h.flush();
		const epoch = h.session.snapshot().epoch;
		const sending = h.session.send({ ev: "send", sf: "s:1", id: "editor", text: "old" });
		const rejected = expect(sending).rejects.toThrow("restarted");
		h.frame(3, []);
		h.hello();
		expect(h.session.snapshot()).toMatchObject({ epoch: epoch + 1, surfaces: [] });
		h.open(); h.frame(1, regions);
		await rejected; await h.flush();
		expect(h.bodies().filter(body => body.ev === "send")).toEqual([]);
		expect(h.bodies().filter(body => body.ev === "ack").at(-1)).toEqual({ ev: "ack", sf: "s:1", s: 1 });
	});
	it("rechecks display-only hook state at the protocol writer after application input was queued", async () => {
		const gate = Promise.withResolvers<void>();
		let hold = false;
		const h = harness(async () => { if (hold) await gate.promise; });
		h.hello(); h.open(); h.frame(1, regions); await h.flush();
		hold = true;
		const blocking = h.session.send({ ev: "visible", sf: "s:1", visible: true });
		await Promise.resolve();
		const answering = h.session.send({ ev: "action", sf: "s:1", id: "editor", act: "submit" });
		const refused = expect(answering).rejects.toThrow("guarded question");
		h.frame(2, [["add", "layer", "s:1", null, { id: "layer", k: "col", c: [{ id: "hook", k: "overlay", p: { role: "omp.overlay.hook-select" } }] }]]);
		hold = false; gate.resolve(); await blocking; await refused; await h.flush();
		expect(h.bodies().filter(body => body.ev === "action")).toEqual([]);
	});
	it.each(["input", "editor"] as const)("writes a complete %s answer atomically using the declared submit target", async kind => {
		const writes: string[] = [];
		const h = harness(data => { writes.push(data); }); h.hello(); h.open();
		h.frame(1, [["add", "hook", "s:1", null, { id: "hook", k: "col", p: { role: `omp.overlay.hook-${kind}` }, c: [{ id: "field", k: kind, p: { text: "seed" } }, { id: "submit", k: "text", p: { text: "Send", actions: { click: "submit" } } }] }]]);
		await h.flush();
		const checked: string[] = [];
		await h.session.answerHook({ kind: "text", sf: "s:1", id: "hook", target: "field", text: "Answer 😀", len: 4 }, (sf, id) => { checked.push(`${sf}/${id}`); });
		expect(checked).toEqual(["s:1/hook"]);
		expect(h.bodies().slice(-2)).toEqual([
			{ ev: "edit", sf: "s:1", id: "field", from: 0, to: 4, text: "Answer 😀", cursor: 9, len: 4 },
			{ ev: "action", sf: "s:1", id: "submit", act: "submit" },
		]);
		expect(writes.at(-1)?.match(/tsp;e/g)).toHaveLength(2);
		await expect(h.session.answerHook({ kind: "text", sf: "s:1", id: "hook", target: "field", text: "stale", len: 0 }, () => {})).rejects.toThrow("field changed");
	});
	it("checks arbitration at the final writer and emits nothing when the node disappears", async () => {
		const gate = Promise.withResolvers<void>(); let hold = false;
		const h = harness(async () => { if (hold) await gate.promise; }); h.hello(); h.open();
		h.frame(1, [["add", "hook", "s:1", null, { id: "hook", k: "overlay", p: { role: "omp.overlay.hook-confirm" }, c: [{ id: "list", k: "list", c: [{ id: "yes", k: "item", p: { key: "yes", label: "Yes" } }] }] }]]);
		await h.flush(); hold = true;
		const blocking = h.session.send({ ev: "visible", sf: "s:1", visible: true }); await Promise.resolve();
		const answering = h.session.answerHook({ kind: "choose", sf: "s:1", id: "hook", target: "list", item: "yes" }, () => { throw new Error("must not be reached"); });
		const rejected = expect(answering).rejects.toThrow("node is no longer available");
		h.frame(2, [["del", "hook"]]); hold = false; gate.resolve(); await blocking; await rejected;
		expect(h.bodies().filter(body => body.ev === "activate")).toEqual([]);
	});
	it.each(["yes", "no"])("uses a confirmation's declared %s action", async act => {
		const h = harness(); h.hello(); h.open();
		h.frame(1, [["add", "hook", "s:1", null, { id: "hook", k: "overlay", p: { role: "omp.overlay.hook-confirm" }, c: [{ id: "choice", k: "text", p: { text: act, actions: { click: act } } }] }]]);
		await h.flush();
		await h.session.answerHook({ kind: "action", sf: "s:1", id: "hook", target: "choice", act }, () => {});
		expect(h.bodies().at(-1)).toEqual({ ev: "action", sf: "s:1", id: "choice", act });
	});
});

it.each(["expand", "future-action"])("refuses unsupported action %s at the serialized writer without blocking known Close", async act => {
	const h = harness(); h.hello(); h.open();
	h.frame(1, [["add", "picker", "s:1", null, { id: "picker", k: "picker", p: { title: "Extensions", noun: "extensions", layout: "rows", query: null, items: [], actions: [{ id: act, label: "Unsupported" }, { id: "close", label: "Close" }] } }]]);
	await h.flush(); h.messages.length = 0;
	await expect(h.session.send({ ev: "action", sf: "s:1", id: "picker", act })).rejects.toThrow(`action ${act} is not supported`);
	expect(h.messages).toEqual([]);
	await h.session.send({ ev: "action", sf: "s:1", id: "picker", act: "close" });
	expect(h.bodies()).toEqual([{ ev: "action", sf: "s:1", id: "picker", act: "close" }]);
});

it.each(["status.model", "thinking.cycle"])("revalidates the live %s declaration after an action was queued", async act => {
	const gate = Promise.withResolvers<void>(); let hold = false;
	const h = harness(async () => { if (hold) await gate.promise; }); h.hello(); h.open();
	h.frame(1, [["add", "control", "s:1", null, { id: "control", k: "row", p: { actions: { click: act } } }]]);
	await h.flush();
	await h.session.send({ ev: "action", sf: "s:1", id: "control", act });
	h.messages.length = 0; hold = true;
	const blocking = h.session.send({ ev: "visible", sf: "s:1", visible: true }); await Promise.resolve();
	const pending = h.session.send({ ev: "action", sf: "s:1", id: "control", act });
	const refused = expect(pending).rejects.toThrow("no longer offers");
	h.frame(2, [["set", "control", { actions: {} }]]);
	hold = false; gate.resolve(); await blocking; await refused; await h.flush();
	expect(h.bodies().filter(body => body.ev === "action")).toEqual([]);
});

it.each(["removed", "disabled"] as const)("revalidates a picker item that became %s before activation was written", async change => {
	const gate = Promise.withResolvers<void>(); let hold = false;
	const h = harness(async () => { if (hold) await gate.promise; }); h.hello(); h.open();
	const item = { id: "provider/model", label: "Exact model" };
	h.frame(1, [["add", "picker", "s:1", null, { id: "picker", k: "picker", p: { items: [item] } }]]);
	await h.flush(); hold = true;
	const blocking = h.session.send({ ev: "visible", sf: "s:1", visible: true }); await Promise.resolve();
	const event = { ev: "activate", sf: "s:1", id: "picker", item: item.id } as const;
	const pending = h.session.send(event);
	const refused = expect(pending).rejects.toThrow("item is no longer available");
	h.frame(2, [["set", "picker", { items: change === "removed" ? [] : [{ ...item, disabled: true }] }]]);
	hold = false; gate.resolve(); await blocking; await refused; await h.flush();
	expect(h.bodies().filter(body => body.ev === "activate")).toEqual([]);
	h.frame(3, [["set", "picker", { items: [item] }]]);
	await h.session.send(event);
	expect(h.bodies().filter(body => body.ev === "activate")).toEqual([event]);
});

it("advertises menu while keeping buttons, web and doc excluded from TSP hello", async () => {
	const h = harness();
	h.hello();
	await h.flush();
	const hello = h.bodies().find(body => body.r === "hello") as { kinds?: string[] } | undefined;
	expect(hello?.kinds).toEqual([...TSP_ADVERTISED_KINDS]);
	expect(hello?.kinds).toContain("menu");
	expect(hello?.kinds).not.toContain("buttons");
	expect(hello?.kinds).not.toContain("web");
	expect(hello?.kinds).not.toContain("doc");
	expect(hello?.kinds).toHaveLength(47);
});

it("guards jobs source:<id> menu actions against enabled, string, separator, disabled, hidden and non-menu nodes", async () => {
	const h = harness(); h.hello(); h.open();
	h.frame(1, [
		["add", "src-menu", "s:1", null, {
			id: "src-menu", k: "menu", p: {
				items: [
					"-",
					{ header: "Streams" },
					{ id: "source:stdout", label: "stdout" },
					"source:stderr",
					{ id: "source:disabled", label: "disabled", disabled: true },
					{ id: "source:nested", label: "more", items: [{ id: "source:child", label: "child" }] },
				],
			},
		}],
		["add", "hidden-menu", "s:1", null, { id: "hidden-menu", k: "menu", p: { hidden: true, items: [{ id: "source:stdout", label: "stdout" }] } }],
		["add", "not-menu", "s:1", null, { id: "not-menu", k: "button", p: { text: "stdout", actions: { click: "source:stdout" } } }],
	]);
	await h.flush(); h.messages.length = 0;

	await h.session.send({ ev: "action", sf: "s:1", id: "src-menu", act: "source:stdout" });
	await h.session.send({ ev: "action", sf: "s:1", id: "src-menu", act: "source:stderr" });
	await h.session.send({ ev: "action", sf: "s:1", id: "src-menu", act: "source:child" });
	expect(h.bodies()).toEqual([
		{ ev: "action", sf: "s:1", id: "src-menu", act: "source:stdout" },
		{ ev: "action", sf: "s:1", id: "src-menu", act: "source:stderr" },
		{ ev: "action", sf: "s:1", id: "src-menu", act: "source:child" },
	]);
	h.messages.length = 0;

	await expect(h.session.send({ ev: "action", sf: "s:1", id: "src-menu", act: "source:missing" })).rejects.toThrow("no longer available");
	await expect(h.session.send({ ev: "action", sf: "s:1", id: "src-menu", act: "source:disabled" })).rejects.toThrow("no longer available");
	await expect(h.session.send({ ev: "action", sf: "s:1", id: "hidden-menu", act: "source:stdout" })).rejects.toThrow("no longer available");
	await expect(h.session.send({ ev: "action", sf: "s:1", id: "not-menu", act: "source:stdout" })).rejects.toThrow("no longer available");
	expect(h.messages).toEqual([]);
});

it("reads the dock queue as the main chat's only while the main editor is there and no helper is focused", async () => {
	const h = harness(); h.hello(); h.open();
	h.frame(1, [
		["add", "dock", "s:1", null, {
			id: "dock", k: "col", p: { role: "omp.editor" }, c: [
				{
					id: "queue", k: "col", p: { role: "omp.queue" }, c: [
						{ id: "q1", k: "row", p: { role: "omp.queue.item", title: "Steering" }, c: [{ id: "t1", k: "text", p: { text: "Main steer" } }] },
						{ id: "q2", k: "row", p: { role: "omp.queue.item", title: "After yield" }, c: [{ id: "t2", k: "text", p: { text: "Main follow-up" } }] },
					],
				},
				{ id: "editor", k: "editor", p: { sendable: true, text: "" } },
			],
		}],
		["focus", "editor"],
	]);
	await h.flush();
	expect(composerFacts(h.session.snapshot().surfaces).queuedItems).toEqual([
		{ text: "Main steer", kind: "steer" },
		{ text: "Main follow-up", kind: "followUp" },
	]);

	// A focused helper's header means the pills are that helper's queue.
	h.frame(2, [["add", "focus-bar", "dock", null, { id: "focus-bar", k: "row", p: { role: "omp.composer.focus" } }]]);
	await h.flush();
	const focused = composerFacts(h.session.snapshot().surfaces);
	expect(focused.queued).toEqual(["Main steer", "Main follow-up"]);
	expect(focused.queuedItems).toBeUndefined();

	// A selector that replaces the editor also removes the header while the helper stays focused: the owner is unknown.
	h.frame(3, [["del", "focus-bar"], ["del", "editor"]]);
	await h.flush();
	const replaced = composerFacts(h.session.snapshot().surfaces);
	expect(replaced.queued).toEqual(["Main steer", "Main follow-up"]);
	expect(replaced.queuedItems).toBeUndefined();
});
