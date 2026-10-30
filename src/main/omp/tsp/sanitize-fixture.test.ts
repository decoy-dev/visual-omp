import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodedOscPayloads, sanitizeFixtureBytes, sanitizeFixtureText } from "./sanitize-fixture";
import { TspStream } from "./stream";

const forbidden = /\.local\/|\/Users\/|\/var\/folders\/|MacBook|readycloud/i;
const root = new URL("./fixtures/", import.meta.url);
function* fixtureFiles(directory: string): Generator<string> {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* fixtureFiles(path);
		else yield path;
	}
}

describe("TSP fixture privacy", () => {
	it("checks every fixture file and decoded base64 OSC payload for private machine data", () => {
		const files = [...fixtureFiles(root.pathname)];
		expect(files.length).toBeGreaterThan(40);
		for (const file of files) {
			const text = readFileSync(file).toString("utf8");
			expect(text, file).not.toMatch(forbidden);
			for (const decoded of decodedOscPayloads(text)) expect(decoded, `${file}: decoded OSC`).not.toMatch(forbidden);
		}
	});

	it("sanitizes encoded OSC paths and hosts while preserving APC, Unicode and unrelated bytes", () => {
		const path = "/private/var/folders/ab/fixture/T/vomp-tsp-record-test/sessions/session.jsonl";
		const apc = '\x1b_tsp;f;{"sf":"s:1","s":1,"ops":[["text","message","append","café"]]}\x1b\\';
		const raw = Buffer.from(`\x1b]1337;SetUserVar=OMP_SESSION=${Buffer.from(path).toString("base64")}\x07\x1b]7;file://ReadyCloud-MacBook.local${path}\x1b\\${apc}`);
		const clean = sanitizeFixtureBytes(raw);
		expect(clean.toString()).not.toMatch(forbidden);
		expect(decodedOscPayloads(clean.toString())).toContain("/tmp/vomp-fixture/sessions/session.jsonl");
		expect(clean.includes(Buffer.from(apc))).toBe(true);
		const messages: unknown[] = [];
		const stream = new TspStream({ onData: () => {}, onMessage: message => messages.push(JSON.parse(message.body)) });
		stream.push(clean); stream.end();
		expect(messages).toEqual([{ sf: "s:1", s: 1, ops: [["text", "message", "append", "café"]] }]);
		expect(sanitizeFixtureText("/Users/someone/.omp /tmp/tsp-study/repo /tmp/vomp-tsp-record-abcd/home")).toBe("/tmp/vomp-fixture/.omp /tmp/vomp-fixture/repo /tmp/vomp-fixture/home");
		expect(sanitizeFixtureBytes(clean)).toEqual(clean);
	});
});
