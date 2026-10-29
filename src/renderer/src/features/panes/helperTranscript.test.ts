import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { type HelperTranscriptItem, helperTranscript } from "./helperTranscript";

let seq = 0;
function user(text: string): SessionEntry {
	seq++;
	return { type: "message", id: `u${seq}`, parentId: null, timestamp: "2026-10-14T16:20:32.144Z", message: { role: "user", content: text, timestamp: 0 } } as SessionEntry;
}

function custom(customType: string, content: string, display: boolean): SessionEntry {
	seq++;
	return { type: "custom_message", id: `c${seq}`, parentId: null, timestamp: "2026-10-14T16:20:32.144Z", customType, content, display } as SessionEntry;
}

const strip = (items: HelperTranscriptItem[]) => items.map(({ id: _id, ...rest }) => rest);

describe("helperTranscript", () => {
	it("keeps narration and ordinary reply text in block order while omitting unmarked thinking", () => {
		const entry = {
			type: "message", id: "narrated", parentId: null, timestamp: "",
			message: {
				role: "assistant", model: "claude-opus-5-5", timestamp: 0, stopReason: "toolUse",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				content: [
					{ type: "text", text: "First reply.\n\n" },
					{ type: "thinking", thinking: "Unmarked reasoning." },
					{ type: "thinking", thinking: "Narrated reply.\n\n", narration: true },
					{ type: "toolCall", id: "read", name: "read", arguments: {}, intent: "Reading project files" },
					{ type: "text", text: "Last reply." },
				],
			},
		} as SessionEntry;
		expect(helperTranscript([entry])).toEqual([{ kind: "reply", id: "narrated", text: "First reply.\n\nNarrated reply.\n\nLast reply.", tools: ["Reading project files"] }]);
	});

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

	it("passes displayed custom messages through and drops hidden ones", () => {
		const shown = custom("irc:incoming", "<irc>\nIncoming IRC message from agent `Notices`:\n\nHello\n</irc>", true);
		const items = helperTranscript([user("Complete assignment thoroughly:\n\nDo it."), shown, custom("mid-run-todo-nudge", "<system-reminder>x</system-reminder>", false)]);
		expect(items.map(item => item.kind)).toEqual(["assignment", "custom"]);
		expect(items[1]).toMatchObject({ kind: "custom", entry: shown });
	});
});
