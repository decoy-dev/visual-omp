import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TspEvent } from "../../../shared/tsp";
import { TspSession } from "./session";
import { TspStream } from "./stream";

interface RecordedMessage { verb: string; body: unknown }
const modelPicker = readFileSync(new URL("./fixtures/18.15.0/model-picker.messages.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line) as RecordedMessage);

describe("TSP restart preparation", () => {
	it("closes the recorded model menu through its declared action before submitting /restart", async () => {
		const events: TspEvent[] = [];
		const parser = new TspStream({ onData: () => {}, onMessage: message => {
			if (message.verb !== "e") return;
			const event = JSON.parse(message.body) as TspEvent;
			if (event.ev === "ack") return;
			events.push(event);
			if (event.ev === "action" && event.act === "close") {
				const closed = modelPicker[5]!;
				session.receive({ verb: closed.verb, body: JSON.stringify(closed.body), params: {} });
			}
		} });
		const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => parser.push(Buffer.from(data)) });
		for (const message of modelPicker.slice(0, 5)) session.receive({ verb: message.verb, body: JSON.stringify(message.body), params: {} });
		expect(session.availability().available).toBe(false);
		expect(await session.prepareRestart(() => {})).toBe(true);
		expect(session.availability().available).toBe(true);
		await session.submit("/restart");
		expect(events).toEqual([
			{ ev: "action", sf: "s:1", id: "k", act: "close" },
			{ ev: "send", sf: "s:1", id: "g.line/input", text: "/restart" },
		]);
	});
});
