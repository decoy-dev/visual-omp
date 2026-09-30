import { describe, expect, it } from "vitest";
import { formatWebLink, parseRoomLink } from "./links";

const ROOM = "AbCdEfGhIjKlMnOpQrStUv";
const KEY = Buffer.alloc(32, 7);
const TOKEN = Buffer.alloc(16, 9);
const CONTROL_SECRET = Buffer.concat([KEY, TOKEN]).toString("base64url");
const VIEW_SECRET = KEY.toString("base64url");

describe("collab links", () => {
	it("turns a loopback control link into omp's public control and view links", () => {
		// `omp collab link` prints the browser form, with the direct relay link in the fragment.
		const room = parseRoomLink(`http://localhost:51234/#ws://localhost:51234/r/${ROOM}.${CONTROL_SECRET}`);
		expect(room.origin).toBe("ws://localhost:51234");
		expect(room.roomId).toBe(ROOM);
		expect(formatWebLink("wss://my.omp.sh", room.roomId, room.key, room.writeToken)).toBe(
			`https://my.omp.sh/#${ROOM}.${CONTROL_SECRET}`,
		);
		expect(formatWebLink("wss://my.omp.sh", room.roomId, room.key, null)).toBe(`https://my.omp.sh/#${ROOM}.${VIEW_SECRET}`);
	});

	it("keeps the relay host in the fragment for a custom relay and honours collab.webUrl", () => {
		expect(formatWebLink("https://relay.example.com:8443", ROOM, KEY, null)).toBe(
			`https://relay.example.com:8443/#relay.example.com:8443/r/${ROOM}.${VIEW_SECRET}`,
		);
		expect(formatWebLink("wss://relay.example.com", ROOM, KEY, TOKEN, "https://watch.example.com/app/")).toBe(
			`https://watch.example.com/app/#relay.example.com/r/${ROOM}.${CONTROL_SECRET}`,
		);
	});

	it("refuses plain ws to a remote relay and malformed keys", () => {
		expect(() => formatWebLink("ws://relay.example.com", ROOM, KEY, null)).toThrow(/wss/);
		expect(() => parseRoomLink(`ws://localhost:1/r/${ROOM}.${Buffer.alloc(20).toString("base64url")}`)).toThrow(/32/);
		expect(parseRoomLink(`ws://localhost:1/r/${ROOM}#${VIEW_SECRET}`).writeToken).toBeNull();
	});
});
