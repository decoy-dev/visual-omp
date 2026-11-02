import { expect, it } from "vitest";
import { loadFixtureRecording, parseFixtureInputs } from "./documents";

it("keeps application focus, actions and raw keys while excluding only named protocol housekeeping", () => {
	const focus = { verb: "e", body: { ev: "focus", sf: "s:1", id: "field" }, afterMessage: 3 };
	const close = { verb: "e", body: { ev: "action", sf: "s:1", id: "picker", act: "close" }, afterMessage: 4 };
	const key = { keys: "\r", afterMessage: 5 };
	const text = [
		{ verb: "r", body: { r: "hello", v: 1 } },
		...(["ack", "resize", "theme", "motion"].map(ev => ({ verb: "e", body: { ev } }))),
		focus, close, key,
	].map(record => JSON.stringify(record)).join("\n");
	expect(parseFixtureInputs(text)).toEqual([focus, close, key]);
});

it.each([
	{ ev: "future-input", sf: "s:1", id: "picker" },
	{ ev: "constructor" },
	{ ev: "action", sf: "s:1", id: "picker" },
	{ ev: "toString" },
	{ ev: "activate", sf: "s:1", id: "picker" },
	{ ev: "focus", sf: "s:1" },
	{ ev: "action", sf: "s:1", id: "picker", act: "close", unexpected: true },
])("rejects an unsupported or malformed application input instead of dropping it: %j", body => {
	const valid = { verb: "e", body: { ev: "select", sf: "s:1", id: "picker", item: "row" }, afterMessage: 3 };
	const text = [valid, { verb: "e", body, afterMessage: 4 }].map(record => JSON.stringify(record)).join("\n");
	expect(() => parseFixtureInputs(text)).toThrow();
});

it("rejects unknown client verbs and ambiguous key/message records", () => {
	expect(() => parseFixtureInputs(JSON.stringify({ verb: "future", body: {} }))).toThrow("Unsupported recorded client verb");
	expect(() => parseFixtureInputs(JSON.stringify({ verb: "e", keys: "\r", body: { ev: "focus", sf: "s:1", id: "field" } }))).toThrow("cannot also carry");
});

it("loads the recorded extension selection and Close without losing either application input", () => {
	const inputs = loadFixtureRecording("extensions").inputs.filter(input => !("keys" in input) && input.body.ev !== "send");
	expect(inputs.map(input => "keys" in input ? input.keys : input.body.ev)).toEqual(["select", "action"]);
	const last = inputs.at(-1);
	expect(last && !("keys" in last) && last.body.ev === "action" ? last.body.act : null).toBe("close");
});
