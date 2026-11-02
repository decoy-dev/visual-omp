import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TspNode } from "../../../shared/tsp";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import { TSP_ROLES, TSP_STATUS } from "../../../shared/tsp/roles";
import { openOverlay, screenSurface, walkNodes } from "../../../shared/tsp/view-state";
import { decodedOscPayloads } from "./sanitize-fixture";

const hookScenarios = ["hook-select", "hook-input", "hook-editor", "hook-confirm", "extension-rows"]
	.flatMap(name => [`${name}-open`, name, `${name}-cancel`]);
const scenarios = ["hotkeys", "jobs", "usage", "session", "changelog", "tools", "model-picker", "settings-screen", "extensions", "import-claude", "startup-no-model", "notice-error", "exit", "exit-with-overlay", "restart", "new", "resume", "sibling-continuation", "hook-collab-aware", ...hookScenarios, "tree-open", "tree-confirm"];
scenarios.push("btw-history", "model-switch", "thinking-cycle", "switch-typed", "model-switch-compact", "model-switch-compact-error");
const fixture = (name: string, extension: string) => readFileSync(new URL(`./fixtures/18.15.0/${name}.${extension}`, import.meta.url));

describe("omp 18.15.0 semantic recordings", () => {
	it("records missing resume as a pre-TUI failure without a hello, journal or emitted input", () => {
		const raw = fixture("startup-missing-resume", "raw.bin");
		expect(raw.toString()).toContain('Error: Session "/tmp/vomp-fixture/missing-session.jsonl" not found.');
		for (let split = 0; split <= raw.length; split++) {
			const messages: unknown[] = [];
			const data: Buffer[] = [];
			const stream = new TspStream({ onData: bytes => data.push(bytes), onMessage: message => messages.push(message) });
			stream.push(raw.subarray(0, split)); stream.push(raw.subarray(split)); stream.end();
			expect(messages).toEqual([]);
			expect(Buffer.concat(data)).toEqual(raw);
		}
		for (const extension of ["jsonl", "messages.jsonl", "events.jsonl"]) expect(fixture("startup-missing-resume", extension).toString().trim()).toBe("");
	});
	it.each(scenarios)("replays %s without rejected operations and retains exact decoded messages", async name => {
		const errors: Error[] = [];
		const messages: object[] = [];
		const kinds = new Set<string>();
		const nodes = new Map<string, TspNode>();
		let inputDefault = false;
		const notices = new Set<string>();
		const events = fixture(name, "events.jsonl").toString().trim().split("\n").map(line => JSON.parse(line));
		const applicationEvents = events.filter(event => event.keys !== undefined || (event.verb === "e" && event.body.ev !== "ack"));
		let escapePending = false;
		let checkedEvents = 0;
		const roles = new Set<string>();
		let closing = false;
		let screen = false;
		const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: () => {}, onError: error => errors.push(error), onUpdate: () => {
			for (const surface of session.snapshot().surfaces) {
				screen ||= surface.open.mode === "screen";
				for (const node of walkNodes(surface.document)) {
					kinds.add(node.k);
					nodes.set(`${node.k}:${node.id}`, node);
					if (node.k === "toast" && typeof node.p?.text === "string") notices.add(node.p.text);
					inputDefault ||= node.k === "input" && node.p?.text === "Fixture default value";
					if (node.p?.role) roles.add(node.p.role);
					closing ||= node.k === "toast" && node.p?.role === TSP_ROLES.toastStatus && node.p.text === TSP_STATUS.closing;
				}
			}
		} });
		const stream = new TspStream({ onData: () => {}, onMessage: message => {
			messages.push({ verb: message.verb, body: JSON.parse(message.body) });
			session.receive(message);
			for (const event of applicationEvents.filter(event => event.afterMessage === messages.length)) {
				checkedEvents++;
				if (event.keys !== undefined) {
					const surfaces = session.snapshot().surfaces;
					const rows = surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.k === "rows"));
					if (event.keys === "\r") expect(rows, `${name}: Enter requires a rows fallback`).toBe(true);
					else {
						expect(event.keys).toBe("\x1b");
						expect(!!openOverlay(surfaces) || !!screenSurface(surfaces) || rows).toBe(true);
						escapePending = true;
					}
					continue;
				}
				const body = event.body;
				const surface = session.snapshot().surfaces.find(surface => surface.open.id === body.sf);
				expect(surface, `${name}: event surface`).toBeDefined();
				const target = [...walkNodes(surface!.document)].find(node => node.id === body.id);
				expect(target, `${name}: event target ${body.id}`).toBeDefined();
				if (!target) continue;
				if (body.ev === "send") {
					if (escapePending) {
						expect(openOverlay(session.snapshot().surfaces), `${name}: Escape dismissed the overlay`).toBeNull();
						expect(screenSurface(session.snapshot().surfaces), `${name}: Escape dismissed the screen`).toBeNull();
						expect(session.availability().available, `${name}: Escape restored the composer`).toBe(true);
						escapePending = false;
					}
					expect(target.k).toBe("editor");
					if (target.k === "editor") expect(target.p?.sendable).toBe(true);
				} else if (body.ev === "edit") {
					expect(["input", "editor"]).toContain(target.k);
					if (target.k === "input" || target.k === "editor") {
						expect(body).toMatchObject({ from: 0, to: target.p?.text?.length ?? 0, len: target.p?.text?.length ?? 0, cursor: body.text.length });
					}
				} else if (body.ev === "activate" || body.ev === "select") {
					expect(target.k).toBe("picker");
					if (target.k === "picker") expect(target.p?.items?.some(item => item.id === body.item)).toBe(true);
				} else if (body.ev === "action") {
					if (target.k === "picker") expect(target.p?.actions?.some(action => action.id === body.act)).toBe(true);
					else expect(target.p?.actions?.click).toBe(body.act);
				} else throw new Error(`Unexpected application event: ${body.ev}`);
			}
		} });
		const raw = fixture(name, "raw.bin");
		for (let offset = 0; offset < raw.length; offset += 13) stream.push(raw.subarray(offset, offset + 13));
		stream.end(); await session.drain();
		expect(errors).toEqual([]);
		expect(messages).toEqual(fixture(name, "messages.jsonl").toString().trim().split("\n").map(line => JSON.parse(line)));
		expect(session.snapshot().surfaces.every(surface => surface.closed)).toBe(true);
		const openedOnly = name.endsWith("-open") || name === "hook-collab-aware";
		expect(closing).toBe(!openedOnly);
		const journal = fixture(name, "jsonl").toString().trim().split("\n").map(line => JSON.parse(line));
		expect(journal.length).toBeGreaterThan(0);
		expect(checkedEvents).toBe(applicationEvents.length);
		for (const event of applicationEvents) expect(event.afterMessage).toBeGreaterThan(0);
		const sends = events.filter(event => event.body?.ev === "send");
		if (openedOnly) expect(sends.some(event => event.body.text === "/exit")).toBe(false);
		else expect(sends.at(-1)?.body.text).toBe("/exit");
		expect(escapePending, `${name}: captured Escape completion`).toBe(false);
		if (name.startsWith("hook-select") || name.startsWith("hook-confirm")) {
			const picker = [...nodes.values()].find(node => node.k === "picker" && node.p?.noun === "options");
			expect(picker?.p?.role).toBeUndefined();
			if (picker?.k === "picker") {
				expect(picker.p?.items?.map(item => item.id)).toEqual(name.startsWith("hook-confirm") ? ["0", "1"] : ["0", "1", "2", "3"]);
				expect(picker.p?.actions?.map(action => action.id)).toEqual(["confirm", "close"]);
				if (name.startsWith("hook-select")) expect(String(picker.p?.items?.[2]?.label).length).toBeGreaterThan(100);
			}
		}
		if (name.startsWith("hook-input")) {
			expect(roles.has(TSP_ROLES.hookInput)).toBe(true);
			expect(inputDefault).toBe(true);
		}
		if (name.startsWith("hook-editor")) expect(roles.has(TSP_ROLES.hookEditor)).toBe(true);
		if (name.startsWith("extension-rows")) expect(kinds.has("rows")).toBe(true);
		if (name === "tree-open") {
			const picker = [...nodes.values()].find(node => node.k === "picker" && node.p?.layout === "tree");
			expect(picker?.k).toBe("picker");
			if (picker?.k === "picker") {
				expect(picker.p?.items).toHaveLength(6);
				expect(picker.p?.selected).toBe("00000006");
				expect(picker.p?.actions?.map(action => action.id)).toEqual(["switch", "summarize", "label", "filter", "close"]);
			}
			expect(applicationEvents.map(event => event.body.ev)).toEqual(["send"]);
		}
		if (hookScenarios.includes(name) && !openedOnly) {
			const type = name.startsWith("extension") ? "rows" : name.split("-")[1]!;
			const cancelled = name.endsWith("-cancel");
			const answers: Record<string, unknown> = { select: "Second option", input: "Recorded fixture answer", editor: "Updated fixture line\nSecond edited line\nThird edited line", confirm: true, rows: "completed" };
			const answer = cancelled ? (type === "confirm" ? false : type === "rows" ? "cancelled" : null) : answers[type];
			expect(notices.has(`Fixture ${type} answer: ${JSON.stringify(answer)}`)).toBe(true);
			const interactions = applicationEvents.filter(event => event.body?.ev !== "send").map(event => event.keys !== undefined ? { keys: event.keys } : event.body);
			if (type === "select" || type === "confirm") {
				expect(interactions).toEqual([cancelled
					? { ev: "action", sf: "s:1", id: "k.^picker", act: "close" }
					: { ev: "activate", sf: "s:1", id: "k.^picker", item: type === "confirm" ? "0" : "1" }]);
			} else if (type === "rows") expect(interactions).toEqual([{ keys: cancelled ? "\x1b" : "\r" }]);
			else {
				const field = type === "input" ? "n" : "l.input";
				const initial = type === "input" ? "Fixture default value" : "First fixture line\nSecond fixture line";
				const edits = type === "input" ? [{ ev: "edit", sf: "s:1", id: field, from: 0, to: 0, text: initial, cursor: initial.length, len: 0 }] : [];
				if (!cancelled) edits.push({ ev: "edit", sf: "s:1", id: field, from: 0, to: initial.length, text: answers[type] as string, cursor: (answers[type] as string).length, len: initial.length });
				expect(interactions).toEqual([...edits, { ev: "action", sf: "s:1", id: `k.actions/${cancelled ? "cancel" : "submit"}`, act: cancelled ? "cancel" : "submit" }]);
			}
		}
		if (name === "model-picker") expect(kinds.has("picker")).toBe(true);
		if (name === "settings-screen") { expect(screen).toBe(true); expect(kinds.has("prefs")).toBe(true); }
		if (name === "usage") expect(roles.has(TSP_ROLES.noticeWarning)).toBe(true);
		if (name === "restart") expect(messages.filter(message => "verb" in message && message.verb === "q")).toHaveLength(2);
		if (name === "new" || name === "resume" || name === "sibling-continuation") expect(messages.filter(message => "verb" in message && message.verb === "q")).toHaveLength(1);
		if (name === "sibling-continuation") {
			const paths = decodedOscPayloads(raw.toString()).filter(path => path.startsWith("/tmp/vomp-fixture/") && path.endsWith(".jsonl"));
			expect(paths).toContain("/tmp/vomp-fixture/tree-session.jsonl");
			expect(paths.some(path => path !== "/tmp/vomp-fixture/tree-session.jsonl")).toBe(true);
			expect([...nodes.values()].some(node => node.k === "text" && JSON.stringify(node.p?.spans ?? "").includes("open for writing in another omp process"))).toBe(true);
		}
		if (name === "exit-with-overlay") {
			const escape = events.findIndex(event => event.keys === "\x1b");
			const exit = events.findIndex(event => event.body?.ev === "send" && event.body.text === "/exit");
			expect(escape).toBeGreaterThan(0);
			expect(exit).toBeGreaterThan(escape);
		}
	});
});
