import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { TspNode, TspOp } from "../../../shared/tsp";
import { advisorActionEvents, advisorOverlay, advisorScope } from "../../../shared/tsp/advisor";
import { isClaimable, isClaimed } from "../../../shared/tsp/roles";
import { unclaimed } from "../../../shared/tsp/view-state";
import { TspSession } from "./session";
import { TspStream } from "./stream";

function harness() {
	const events: object[] = []; const writes: string[] = [];
	const stream = new TspStream({ onData: () => {}, onMessage: message => { const event = JSON.parse(message.body); if (message.verb === "e" && event.ev !== "ack") events.push(event); } });
	const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => { writes.push(data); stream.push(Buffer.from(data)); } });
	const receive = (verb: string, body: unknown) => session.receive({ verb, body: JSON.stringify(body), params: {} });
	return { session, receive, events, writes };
}
function prefs(): TspNode {
	const recording = readFileSync(new URL("./fixtures/18.15.0/advisor-apply.messages.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
	return structuredClone(recording.flatMap(message => message.body.ops ?? []).find((op: TspOp) => op[0] === "add" && op[4].k === "prefs")[4]);
}
function openAdvisor(h: { receive(verb: string, body: unknown): void }) {
	h.receive("q", { q: "hello", v: [1], features: ["send", "edit"] });
	h.receive("o", { id: "s:2", mode: "screen", role: "omp.session" });
	h.receive("f", { sf: "s:2", s: 1, ops: [["add", "main", "s:2", null, { id: "main", k: "col", c: [prefs()] }]] });
}
it.each(["advisor-apply", "advisor-apply-project"])("replays %s using exact current ids through the scope-bound writer", async name => {
	const h = harness();
	const messages = readFileSync(new URL(`./fixtures/18.15.0/${name}.messages.jsonl`, import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
	const inputs = readFileSync(new URL(`./fixtures/18.15.0/${name}.events.jsonl`, import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(input => input.body?.ev === "action");
	let message = 0;
	for (let index = 0; index < inputs.length; index++) {
		const expected = inputs[index]!;
		while (message < expected.afterMessage) { const next = messages[message++]!; h.receive(next.verb, next.body); }
		const target = advisorOverlay(h.session.snapshot().surfaces)!;
		expect(target).not.toBeNull();
		const act = expected.body.act === "scope" ? "scope" : "apply";
		const eventCount = h.events.length;
		await h.session.advisorAction({ sf: target.surface.open.id, id: target.node.id, scope: target.scope, act }, () => {});
		const expectedEvents = act === "scope" ? [expected.body] : [expected.body, inputs[++index]!.body];
		expect(h.events.slice(eventCount)).toEqual(expectedEvents);
		if (act === "apply") expect(h.writes.at(-1)?.match(/tsp;e;/g)).toHaveLength(2);
	}
});
it("rechecks expected scope at the serialized writer and writes neither save nor close on a race", async () => {
	const h = harness(); openAdvisor(h); await h.session.drain();
	const applying = h.session.advisorAction({ sf: "s:2", id: "k", scope: "project", act: "apply" }, () => {});
	const node = prefs(); if (node.k !== "prefs") throw new Error("Expected prefs");
	h.receive("f", { sf: "s:2", s: 2, ops: [["set", "k", { sections: node.p?.sections?.map(section => section.id === "file" ? { ...section, title: "WATCHDOG.yml · user" } : section) }]] });
	await expect(applying).rejects.toThrow("scope changed");
	expect(h.events).toEqual([]);
});
it.each(["save", "scope"])("refuses an undeclared or disabled advisor %s action", async act => {
	for (const disabled of [false, true]) {
		const h = harness(); openAdvisor(h); await h.session.drain();
		const node = prefs(); if (node.k !== "prefs") throw new Error("Expected prefs");
		h.receive("f", { sf: "s:2", s: 2, ops: [["set", "k", { sections: node.p?.sections?.map(section => ({ ...section, rows: section.rows.flatMap(row => row.id !== act ? [row] : disabled ? [{ ...row, disabled: "Unavailable" }] : []) })) }]] });
		await expect(h.session.advisorAction({ sf: "s:2", id: "k", scope: "project", act: act === "save" ? "apply" : "scope" }, () => {})).rejects.toThrow(disabled ? `no longer offers the advisor ${act}` : "no longer available");
		expect(h.events).toEqual([]);
	}
});
it("repeats host authority checks at the actual writer and refuses stale surfaces", async () => {
	const h = harness(); openAdvisor(h); await h.session.drain();
	await expect(h.session.advisorAction({ sf: "s:2", id: "k", scope: "project", act: "apply" }, () => { throw new Error("room changed"); })).rejects.toThrow("room changed");
	h.receive("x", { id: "s:2", keep: true });
	await expect(h.session.advisorAction({ sf: "s:2", id: "k", scope: "project", act: "apply" }, () => {})).rejects.toThrow("no longer available");
	expect(h.events).toEqual([]);
});
it("keeps advisor prefs unclaimed outside the exact active consumer and preserves unrelated content", () => {
	const h = harness(); openAdvisor(h);
	const target = advisorOverlay(h.session.snapshot().surfaces)!;
	expect(isClaimable(target.node, target.surface)).toBe(true); expect(isClaimed(target.node)).toBe(false);
	expect(unclaimed(target.surface, "main")).toHaveLength(1);
	expect(unclaimed(target.surface, "main", new Set([target.node.id]))).toEqual([]);
	const editing = prefs(); if (editing.k !== "prefs") throw new Error("Expected prefs");
	editing.p = { ...editing.p!, editing: { row: "name", draft: "Changed" } };
	expect(advisorScope(editing, "screen")).toBeNull();
});
it("uses declared list item keys when omp does not offer prefs", () => {
	const root: TspNode = { id: "advisor", k: "overlay", p: { role: "omp.overlay.advisor" }, c: [{ id: "list", k: "list", c: [
		{ id: "row-99", k: "item", p: { key: "save", label: "Save & apply" } },
		{ id: "row-12", k: "item", p: { key: "scope", label: "Scope: user" } },
		{ id: "row-81", k: "item", p: { key: "close", label: "Close" } },
	] }] };
	const h = harness(); openAdvisor(h);
	expect(advisorActionEvents({ node: root, surface: h.session.snapshot().surfaces[0]! }, { sf: "screen", id: "advisor", scope: "user", act: "apply" })).toEqual([
		{ ev: "activate", sf: "screen", id: "list", item: "save" }, { ev: "activate", sf: "screen", id: "list", item: "close" },
	]);
});

it("refuses advisor writes while an approval exists behind the fullscreen prefs page", async () => {
	const h = harness(); openAdvisor(h); await h.session.drain();
	h.receive("o", { id: "s:1", mode: "inline", role: "omp.session" });
	h.receive("f", { sf: "s:1", s: 1, ops: [["add", "dock", "s:1", null, { id: "dock", k: "col", c: [{ id: "approval", k: "list", p: { role: "omp.approval.choices" } }] }]] });
	await expect(h.session.advisorAction({ sf: "s:2", id: "k", scope: "project", act: "apply" }, () => {})).rejects.toThrow("Answer the approval");
	expect(h.events).toEqual([]);
});

it.each(["foreign-role", "inline", "title", "file-id", "file-title", "missing-action", "wrong-action", "wrong-control", "duplicate-action", "editing", "editor-child"] as const)("leaves %s advisor-like prefs unclaimed and unavailable to the driver", invalid => {
	const h = harness(); openAdvisor(h);
	const surface = h.session.snapshot().surfaces[0]!;
	const node = surface.document.c![0]!.c![0]!;
	if (node.k !== "prefs" || !node.p) throw new Error("Expected recorded prefs");
	if (invalid === "foreign-role") node.p.role = "other.settings";
	if (invalid === "inline") surface.open.mode = "inline";
	if (invalid === "title") node.p.title = "Other advisors";
	if (invalid === "editing") node.p.editing = { row: "name", draft: "Changed" };
	if (invalid === "editor-child") node.c = [{ id: "editor", k: "input", p: { text: "Changed" } }];
	node.p.sections = node.p.sections.map(section => {
		if (section.id !== "file") return section;
		if (invalid === "file-id") return { ...section, id: "other-file" };
		if (invalid === "file-title") return { ...section, title: "OTHER.yml · project" };
		if (invalid === "missing-action") return { ...section, rows: section.rows.filter(row => row.id !== "save") };
		if (invalid === "duplicate-action") return { ...section, rows: [...section.rows, section.rows.find(row => row.id === "save")!] };
		return { ...section, rows: section.rows.map(row => row.id !== "save" ? row
			: invalid === "wrong-action" ? { ...row, control: { k: "action", label: "Save", act: "scope" } }
			: invalid === "wrong-control" ? { ...row, control: { k: "text", value: "save" } }
			: row) };
	});
	expect(advisorOverlay([surface])).toBeNull();
	expect(isClaimable(node, surface)).toBe(false);
	expect(unclaimed(surface, "main", new Set([node.id]))).toHaveLength(1);
});

it("refuses duplicate advisor candidates within a screen and across screens", () => {
	const h = harness(); openAdvisor(h);
	const surface = h.session.snapshot().surfaces[0]!;
	const duplicate = structuredClone(surface);
	duplicate.open.id = "s:3";
	expect(advisorOverlay([surface, duplicate])).toBeNull();
	const main = surface.document.c![0]!;
	main.c = [...main.c!, { ...prefs(), id: "duplicate" }];
	expect(advisorOverlay([surface])).toBeNull();
	expect(unclaimed(surface, "main")).toHaveLength(2);
});
