import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeTspJson, encodeTspMessage } from "./encode";
import { TspStream, type TspMessage } from "./stream";

function collect() {
	const messages: TspMessage[] = [];
	const data: Buffer[] = [];
	const stream = new TspStream({ onMessage: message => messages.push(message), onData: bytes => data.push(bytes) });
	return { stream, messages, passthrough: () => Buffer.concat(data) };
}

describe("TSP byte stream", () => {
	it("handles every two-piece boundary, including split ESC, terminator and UTF-8", () => {
		const bytes = Buffer.from(`before${encodeTspJson("q", { q: "hello", text: "café 🐢" })}after`);
		for (let cut = 0; cut <= bytes.length; cut++) {
			const { stream, messages, passthrough } = collect();
			stream.push(bytes.subarray(0, cut));
			stream.push(bytes.subarray(cut));
			stream.end();
			expect(messages).toEqual([{ verb: "q", params: {}, body: JSON.stringify({ q: "hello", text: "café 🐢" }) }]);
			expect(passthrough().toString()).toBe("beforeafter");
		}
	});

	it("passes interleaved OSC, unrelated APC and all non-TSP bytes in order", () => {
		const osc = "\x1b]7501;{\"state\":\"working\"}\x07";
		const other = "\x1b_other;payload\x1b\\";
		const bytes = Buffer.from(`é${osc}${encodeTspJson("o", { id: "s:1", mode: "inline" })}${other}🐢\x1b[c`);
		const { stream, messages, passthrough } = collect();
		for (const byte of bytes) stream.push(Buffer.from([byte]));
		stream.end();
		expect(messages.map(message => message.verb)).toEqual(["o"]);
		expect(passthrough()).toEqual(Buffer.from(`é${osc}${other}🐢\x1b[c`));
	});

	it("retains first-chunk parameters, supports interleaved chunks and decodes only after joining", () => {
		const { stream, messages, passthrough } = collect();
		const turtle = Buffer.from("🐢");
		stream.push(Buffer.concat([Buffer.from('\x1b_tsp;f;sf=s:1;c=a;m=1;{"text":"'), turtle.subarray(0, 2), Buffer.from("\x1b\\")]));
		stream.push(Buffer.from("ordinary\x1b_tsp;b;id=image;c=b;m=1;YW\x1b\\"));
		stream.push(Buffer.concat([Buffer.from("\x1b_tsp;f;c=a;"), turtle.subarray(2), Buffer.from('"}\x1b\\')]));
		stream.push(Buffer.from("\x1b_tsp;b;c=b;Jj\x1b\\"));
		expect(messages).toEqual([
			{ verb: "f", params: { sf: "s:1" }, body: '{"text":"🐢"}' },
			{ verb: "b", params: { id: "image" }, body: "YWJj" },
		]);
		expect(passthrough().toString()).toBe("ordinary");
	});

	it("reassembles the upstream encoder's safe chunks, including parameter-shaped text", () => {
		const body = JSON.stringify({ text: "é🐢 key=value; ".repeat(20) });
		const encoded = Buffer.from(encodeTspMessage("f", body, { sf: "s:1" }, 13));
		const { stream, messages } = collect();
		for (let i = 0; i < encoded.length; i += 3) stream.push(encoded.subarray(i, i + 3));
		expect(messages).toEqual([{ verb: "f", params: { sf: "s:1" }, body }]);
	});

	it("flushes unfinished prefixes and APC messages unchanged at exit", () => {
		for (const text of ["output\x1b", "output\x1b_t", "output\x1b_tsp;f;unfinished", "\x1b_tsp;;bad\x1b\\"]) {
			const { stream, messages, passthrough } = collect();
			stream.push(Buffer.from(text));
			stream.end();
			expect(passthrough().toString()).toBe(text);
			expect(messages).toEqual([]);
		}
	});

	it("replays the omp 18.14 capture identically at arbitrary read sizes", () => {
		const raw = readFileSync(new URL("./fixtures/omp-18.14.bin", import.meta.url));
		const whole = collect();
		whole.stream.push(raw);
		whole.stream.end();
		expect(whole.messages).toHaveLength(9);
		expect(whole.messages[0]).toMatchObject({ verb: "q" });
		expect(whole.messages.some(message => message.body.includes("omp.overlay.btwHistory"))).toBe(true);
		for (const size of [1, 2, 7, 31, 1024]) {
			const replay = collect();
			for (let i = 0; i < raw.length; i += size) replay.stream.push(raw.subarray(i, i + size));
			replay.stream.end();
			expect(replay.messages).toEqual(whole.messages);
			expect(replay.passthrough()).toEqual(whole.passthrough());
		}
	});
});
