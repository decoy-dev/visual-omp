import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import stepPrompts from "./fixtures/step-prompts-18.19.0.json";
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


// Each message omp 18.19.0 sends a stepped helper, rendered by omp's own template engine (utils/src/prompt.ts) with
// renderStepPrompts and renderSubagentUserPrompt from coding-agent/src/task; checked against a live 18.19.0 helper.
const rendered: { name: string; steps: string[]; messages: string[] }[] = stepPrompts;

describe("helperTranscript step prompts (omp 18.19.0)", () => {
	it.each(rendered.filter(sample => !sample.name.startsWith("ambiguous")).map(sample => [sample.name, sample] as const))("shows every step of %s without omp's closing instruction", (_name, sample) => {
		const items = strip(helperTranscript(sample.messages.map(user)));
		expect(items.every(item => item.kind === "step")).toBe(true);
		const steps = items.flatMap(item => item.kind === "step" ? item.steps : []);
		expect(steps).toEqual(sample.steps.map((text, index) => ({ number: index + 1, total: sample.steps.length, text: text.trim() })));
	});
	it.each(["ambiguous-grouped-yield", "ambiguous-grouped-message"])("keeps a grouped prompt whose step text repeats the next heading whole (%s)", name => {
		const sample = rendered.find(entry => entry.name === name)!;
		const items = strip(helperTranscript(sample.messages.map(user)));
		expect(items[0]).toEqual({ kind: "assignment", text: sample.messages[0]!.replace("Complete assignment thoroughly:\n\n", "") });
		expect(items.slice(1).flatMap(item => item.kind === "step" ? item.steps.map(step => step.number) : [])).toEqual([3, 4, 5]);
	});
	it.each([
		["a step number of zero", "# Step 0 of 0\nWork.\n\nLast step: your terminal `yield` is the result of the whole assignment and MUST cover every step."],
		["a grouping omp never sends", "# Step 1 of 3\nOne.\n\n# Step 2 of 3\nTwo.\n\nDo ONLY these steps, then report with a terminal `yield`. Step 3 arrives after; NEVER start it early."],
		["a closing line naming the wrong next step", "# Step 1 of 2\nOne.\n\nDo ONLY this step, then report with a terminal `yield`. Step 3 arrives after; NEVER start it early."],
		["a final closing line before the last step", "# Step 1 of 2\nOne.\n\nLast step: your final message is the result of the whole assignment and MUST cover every step."],
		["a reworded closing line", "# Step 1 of 2\nOne.\n\nDo ONLY this step, then report as your final message. Step 2 arrives after; start it early."],
		["no blank line before the closing line", "# Step 2 of 2\nTwo.\nLast step: your final message is the result of the whole assignment and MUST cover every step."],
		["ordinary prose", "Please also check the Windows build."],
	])("keeps %s as a plain prompt", (_name, text) => {
		const items = strip(helperTranscript([user("Complete assignment thoroughly:\n\nBegin."), user(text)]));
		expect(items[1]).toEqual({ kind: "prompt", text });
	});
});
