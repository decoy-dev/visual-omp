import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { type HelperTranscriptItem, helperTranscript } from "./helperTranscript";

let seq = 0;
function user(text: string): SessionEntry {
	seq++;
	return { type: "message", id: `u${seq}`, parentId: null, timestamp: "2026-10-14T16:20:32.144Z", message: { role: "user", content: text, timestamp: 0 } } as SessionEntry;
}


const strip = (items: HelperTranscriptItem[]) => items.map(({ id: _id, ...rest }) => rest);

describe("helperTranscript", () => {

	it("shows the first user message as the assignment without omp's preamble", () => {
		const items = helperTranscript([user("Complete assignment thoroughly:\n\n# Target\nHelper transcript dialog.")]);
		expect(strip(items)).toEqual([{ kind: "assignment", text: "# Target\nHelper transcript dialog." }]);
	});

	it("shows an IRC message that ended a wait as a message from its agent", () => {
		const items = helperTranscript([
			user("Complete assignment thoroughly:\n\nDo it."),
			user('[Wait interrupted by message]\n<irc from="parent" agent="Main">\nOne more item in **your** files.\n</irc>'),
			user('<irc from="parent">\nNo agent name here.\n</irc>'),
		]);
		expect(strip(items).slice(1)).toEqual([
			{ kind: "message", from: "Main", text: "One more item in **your** files.", interrupted: true },
			{ kind: "message", from: "parent", text: "No agent name here.", interrupted: false },
		]);
	});

	it("reads omp's older interrupted-wait wording", () => {
		const items = helperTranscript([
			user("Complete assignment thoroughly:\n\nDo it."),
			user("Current interruptible wait interrupted: IRC message from parent agent `Main`.\n\nParent IRC message:\n\nKeep all builds deferred."),
		]);
		expect(strip(items)[1]).toEqual({ kind: "message", from: "Main", text: "Keep all builds deferred.", interrupted: true });
	});

	it("turns harness notices into one line of text and keeps plain later messages", () => {
		const items = helperTranscript([
			user("Complete assignment thoroughly:\n\nDo it."),
			user("<system-reminder>\n8 todo items still open.\nKeep working.\n</system-reminder>"),
			user("[budget notice] You have used 200 requests in this run (soft budget: 200)."),
			user("### Session update\n\nNo markup."),
		]);
		expect(strip(items).slice(1)).toEqual([
			{ kind: "notice", text: "8 todo items still open. Keep working." },
			{ kind: "notice", text: "You have used 200 requests in this run (soft budget: 200)." },
			{ kind: "prompt", text: "### Session update\n\nNo markup." },
		]);
	});

	it("leaves custom notices to the shared transcript renderer", () => {
		const shown = { type: "custom_message", id: "notice", customType: "irc:incoming", content: "Hello", display: true } as SessionEntry;
		expect(helperTranscript([shown])).toEqual([]);
	});
});

