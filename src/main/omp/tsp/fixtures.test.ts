import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TspSession } from "./session";
import { TspStream } from "./stream";
import { TSP_ROLES, TSP_STATUS } from "../../../shared/tsp/roles";
import { walkNodes } from "../../../shared/tsp/view-state";

const scenarios = ["hotkeys", "jobs", "usage", "session", "changelog", "tools", "model-picker", "settings-screen", "exit", "exit-with-overlay"];
const fixture = (name: string, extension: string) => readFileSync(new URL(`./fixtures/18.14.0/${name}.${extension}`, import.meta.url));

describe("omp 18.14.0 no-model recordings", () => {
	it.each(scenarios)("replays %s without rejected operations and retains exact decoded messages", async name => {
		const errors: Error[] = [];
		const messages: object[] = [];
		const kinds = new Set<string>();
		const roles = new Set<string>();
		let closing = false;
		let screen = false;
		const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: () => {}, onError: error => errors.push(error), onUpdate: () => {
			for (const surface of session.snapshot().surfaces) {
				screen ||= surface.open.mode === "screen";
				for (const node of walkNodes(surface.document)) {
					kinds.add(node.k);
					if (node.p?.role) roles.add(node.p.role);
					closing ||= node.k === "toast" && node.p?.role === TSP_ROLES.toastStatus && node.p.text === TSP_STATUS.closing;
				}
			}
		} });
		const stream = new TspStream({ onData: () => {}, onMessage: message => {
			messages.push({ verb: message.verb, body: JSON.parse(message.body) });
			session.receive(message);
		} });
		const raw = fixture(name, "raw.bin");
		for (let offset = 0; offset < raw.length; offset += 13) stream.push(raw.subarray(offset, offset + 13));
		stream.end(); await session.drain();
		expect(errors).toEqual([]);
		expect(messages).toEqual(fixture(name, "messages.jsonl").toString().trim().split("\n").map(line => JSON.parse(line)));
		expect(session.snapshot().surfaces.every(surface => surface.closed)).toBe(true);
		expect(closing).toBe(true);
		const journal = fixture(name, "jsonl").toString().trim().split("\n").map(line => JSON.parse(line));
		expect(journal.length).toBeGreaterThan(0);
		const events = fixture(name, "events.jsonl").toString().trim().split("\n").map(line => JSON.parse(line));
		expect(events.filter(event => event.body?.ev === "send").at(-1)?.body.text).toBe("/exit");
		if (name === "model-picker") expect(kinds.has("picker")).toBe(true);
		if (name === "settings-screen") { expect(screen).toBe(true); expect(kinds.has("prefs")).toBe(true); }
		if (name === "usage") expect(roles.has(TSP_ROLES.noticeWarning)).toBe(true);
		if (name === "exit-with-overlay") {
			const escape = events.findIndex(event => event.keys === "\x1b");
			const exit = events.findIndex(event => event.body?.ev === "send" && event.body.text === "/exit");
			expect(escape).toBeGreaterThan(0);
			expect(exit).toBeGreaterThan(escape);
		}
	});
});
