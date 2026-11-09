import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TspRendererEvent } from "@shared/tsp-host";
import { isKnownAction, TSP_ACTIONS, TSP_ROLES } from "@shared/tsp/roles";
import { walkNodes } from "@shared/tsp/view-state";
import { TspSession } from "./session";
import { TspStream } from "./stream";

async function replay(version: string, name: string, stageName: string) {
	const directory = new URL(`./fixtures/${version}/`, import.meta.url);
	const evidence = JSON.parse(readFileSync(new URL(`${name}.ask.json`, directory), "utf8"));
	const stage = evidence.stages.find((item: { stage: string }) => item.stage === stageName);
	if (!stage) throw new Error(`Missing form stage ${stageName}`);
	const events: unknown[] = [];
	const decoder = new TspStream({ onData: () => {}, onMessage: message => {
		if (message.verb !== "e") return;
		const event = JSON.parse(message.body);
		// Cumulative acknowledgments are protocol housekeeping, not user input.
		if (event.ev !== "ack") events.push(event);
	} });
	const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => decoder.push(Buffer.from(data)) });
	const messages = readFileSync(new URL(`${name}.messages.jsonl`, directory), "utf8").trim().split("\n").map(line => JSON.parse(line));
	for (const message of messages.slice(0, stage.afterMessage)) session.receive({ verb: message.verb, params: {}, body: message.verb === "b" ? message.body : JSON.stringify(message.body) });
	await session.drain();
	const surface = session.snapshot().surfaces.find(surface => !surface.closed)!;
	return { session, surface, events, nodes: [...walkNodes(surface.document)] };
}

describe("guarded explicit omp form controls", () => {
	it.each([
		["opened", TSP_ACTIONS.next], ["review", TSP_ACTIONS.hide], ["hidden", TSP_ACTIONS.show],
	])("accepts the declared %s form action %s", async (stage, act) => {
		const { session, surface, nodes, events } = await replay("18.18.5", "ask-fixture-form-tabs", stage!);
		const node = nodes.find(node => node.k === "button" && node.p?.actions?.click === act)!;
		const event = { ev: "action", sf: surface.open.id, id: node.id, act } as TspRendererEvent;
		await session.send(event);
		expect(events).toEqual([event]);
	});
	it("accepts the recorded indexed text edit and rejects a different index", async () => {
		const { session, surface, nodes, events } = await replay("18.18.3", "ask-html-form", "radio");
		const node = nodes.find(node => node.k === "text" && node.p?.role === TSP_ROLES.askWell)!;
		if (node.k !== "text" || !node.p?.actions?.click) throw new Error("Missing recorded text edit control");
		const event: TspRendererEvent = { ev: "action", sf: surface.open.id, id: node.id, act: node.p.actions.click };
		await session.send(event);
		expect(events).toEqual([event]);
		await expect(session.send({ ...event, act: "edit:99" })).rejects.toThrow("no longer offers this action");
		expect(events).toHaveLength(1);
	});
	it("rejects form actions addressed to another control or outside the form", async () => {
		const { session, surface, nodes, events } = await replay("18.18.5", "ask-fixture-form-tabs", "opened");
		const cancel = nodes.find(node => node.k === "button" && node.p?.actions?.click === TSP_ACTIONS.cancel)!;
		await expect(session.send({ ev: "action", sf: surface.open.id, id: cancel.id, act: TSP_ACTIONS.next })).rejects.toThrow("no longer offers this action");
		session.receive({ verb: "f", params: {}, body: JSON.stringify({ sf: surface.open.id, s: surface.sequence + 1, ops: [["add", "outside-form", surface.document.id, null, { id: "outside-form", k: "button", p: { text: "Show", actions: { click: TSP_ACTIONS.show } } }]] }) });
		await session.drain();
		await expect(session.send({ ev: "action", sf: surface.open.id, id: "outside-form", act: TSP_ACTIONS.show })).rejects.toThrow("no longer offers this action");
		expect(events).toEqual([]);
	});
	it("rejects a removed tab item instead of guessing a native question", async () => {
		const { session, surface, nodes, events } = await replay("18.18.5", "ask-fixture-form-tabs", "opened");
		const tabs = nodes.find(node => node.k === "tabs" && node.p?.role === TSP_ROLES.askQuestions)!;
		await expect(session.send({ ev: "select", sf: surface.open.id, id: tabs.id, item: "not-a-question" })).rejects.toThrow("tab is no longer available");
		expect(events).toEqual([]);
	});
	it.each(["edit:", "edit:-1", "edit:01", "edit:1.5", "edit:no", "edit:9007199254740992", "edit:0\n"])("keeps malformed indexed action %s unavailable", action => {
		expect(isKnownAction(action)).toBe(false);
	});
});
