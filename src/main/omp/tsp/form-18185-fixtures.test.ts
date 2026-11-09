import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TspSurfaceSnapshot } from "@shared/tsp-host";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { walkNodes } from "@shared/tsp/view-state";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import { decodedOscPayloads } from "./sanitize-fixture";

const names = ["ask-fixture-form-tabs", "ask-four-fieldsets-tabs", "ask-fixture-form-guest", "ask-fixture-colors", "ask-tall-form"];
const fixture = (name: string, extension: string) => readFileSync(new URL(`./fixtures/18.18.5/${name}.${extension}`, import.meta.url));
interface Stage { stage: string; afterMessage: number; surfaces: TspSurfaceSnapshot[]; request: CollabUiRequest | null }
interface Capture { version: string; stages: Stage[]; sessions: { path: string; text: string }[] }
function capture(name: string): Capture { return JSON.parse(fixture(name, "ask.json").toString()); }
function nodes(stage: Stage) { return stage.surfaces.flatMap(surface => [...walkNodes(surface.document)]); }

describe("omp 18.18.5 recorded ask forms", () => {
	it.each(names)("retains exact sanitized bytes and replays %s", async name => {
		const raw = fixture(name, "raw.bin");
		const integrity = JSON.parse(fixture(name, "integrity.json").toString());
		expect({ bytes: raw.length, carriageReturns: raw.filter(byte => byte === 13).length, sha256: createHash("sha256").update(raw).digest("hex") }).toEqual(integrity);
		const errors: Error[] = [], messages: object[] = [];
		const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: () => {}, onError: error => errors.push(error) });
		const stream = new TspStream({ onData: () => {}, onMessage: message => {
			messages.push({ verb: message.verb, body: JSON.parse(message.body) });
			session.receive(message);
		} });
		for (let offset = 0; offset < raw.length; offset += 13) stream.push(raw.subarray(offset, offset + 13));
		stream.end(); await session.drain();
		expect(errors).toEqual([]);
		expect(messages).toEqual(fixture(name, "messages.jsonl").toString().trim().split("\n").map(line => JSON.parse(line)));
		expect(session.snapshot().surfaces.every(surface => surface.closed)).toBe(true);
		const data = capture(name);
		expect(data.version).toBe("omp/18.18.5");
		expect(JSON.parse(fixture(name, "provider.json").toString())).toHaveLength(2);
		const privatePaths = /\/Users\/|\/private\/var\/folders\/|\/tmp\/vomp-tsp-record-/;
		for (const extension of ["raw.bin", "jsonl", "messages.jsonl", "events.jsonl", "provider.json", "collab.json", "ask.json"]) {
			const text = fixture(name, extension).toString();
			expect(text).not.toMatch(privatePaths);
			for (const payload of decodedOscPayloads(text)) expect(payload).not.toMatch(privatePaths);
		}
	});

	it.each(["ask-fixture-form-tabs", "ask-four-fieldsets-tabs"])("records tab navigation, Review, Hide and submission for %s", name => {
		const stages = capture(name).stages;
		const active = (stage: string) => nodes(stages.find(item => item.stage === stage)!).find(node => node.k === "tabs");
		expect(stages.map(stage => stage.stage)).toEqual(["opened", "second-tab", "page-down", "page-up", "right-arrow", "left-arrow", "review", "hidden", "shown", "next", "submitted"]);
		for (const [stage, tab] of [["opened", "t0"], ["second-tab", "t1"], ["page-down", "t2"], ["page-up", "t1"], ["right-arrow", "t2"], ["left-arrow", "t0"], ["review", "review"], ["next", "t1"]]) expect(active(stage!)?.p).toMatchObject({ active: tab });
		expect(active("opened")?.p?.items).toHaveLength(name === "ask-fixture-form-tabs" ? 4 : 5);
		const review = nodes(stages.find(stage => stage.stage === "review")!);
		expect(review.some(node => node.p?.role === "omp.ask.answers")).toBe(true);
		expect(review.some(node => node.p?.role === "omp.ask.form")).toBe(false);
		expect(review.some(node => node.k === "button" && node.p?.actions?.click === "submit")).toBe(true);
		const hidden = nodes(stages.find(stage => stage.stage === "hidden")!);
		expect(hidden.some(node => node.p?.role === "omp.editor.ask.hidden")).toBe(true);
		expect(hidden.some(node => node.k === "button" && node.p?.actions?.click === "show")).toBe(true);
	});

	it("completes guest answers independently of the native question tab", () => {
		const data = capture("ask-fixture-form-guest");
		expect(data.stages.flatMap(stage => stage.request ? [stage.request.title] : [])).toEqual(["Release channel", "Platforms to check", "Platforms to check", "Release note headline", "Review depth"]);
		for (const stage of data.stages.filter(stage => stage.request)) expect(nodes(stage).find(node => node.k === "tabs")?.p).toMatchObject({ active: "t0" });
		expect(data.sessions.some(session => session.text.includes('"name":"headline","question":"Release note headline","answer":"Release fixture headline"'))).toBe(true);
	});

	it("records a tall scroll-container form and a start-positioned prefill", () => {
		const opened = capture("ask-tall-form").stages[0]!;
		const all = nodes(opened);
		const root = all.find(node => node.p?.role === "omp.editor.ask")!;
		expect(root.c?.some(node => node.k === "list" && node.p?.role === "omp.ask.options" && node.c?.some(child => child.p?.role === "omp.ask.form"))).toBe(true);
		expect(all.filter(node => node.p?.role === "omp.ask.text")).toHaveLength(90);
		expect(all.find(node => node.k === "input")?.p).toMatchObject({ text: "Handoffs are easier to follow", cursor: 0 });
		expect(all.some(node => node.k === "button" && node.p?.actions?.click === "submit")).toBe(true);
	});
});
