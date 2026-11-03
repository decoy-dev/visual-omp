import { describe, expect, it } from "vitest";
import type { TspNode } from "../../shared/tsp";
import type { TspSurfaceSnapshot } from "../../shared/tsp-host";
import { TSP_ROLES } from "../../shared/tsp/roles";
import { classicPromptRejections, semanticPromptRejections, type PromptRejection } from "./prompt-rejection";

// agent-session prompt preflight and TranscriptNotice.line producer strings, omp 18.15/18.16.
const guidance = "Use /login, set an API key environment variable, or create ";
const model = (path = "/tmp/agent/agent.db") => `No model selected.\n\n${guidance}${path}\n\nThen use /model to select a model.`;
const key = (provider = "openai-codex", path = "/tmp/agent/agent.db") => `No API key found for ${provider}.\n\n${guidance}${path}`;
const notice = (text: string, id = "error", role: string = TSP_ROLES.noticeError): TspNode => ({
	id, k: "row", p: { role }, c: [
		{ id: `${id}.icon`, k: "icon", p: { name: "error", aria: "Error" } },
		{ id: `${id}.text`, k: "text", p: { spans: [{ t: text }], wrap: "word" } },
	],
});
function surface(nodes: TspNode[], id = "s:1"): TspSurfaceSnapshot {
	return { open: { id, mode: "inline", role: TSP_ROLES.session }, sequence: 1, closed: false, suspended: false, settled: [], focus: null, document: { id, k: "col", c: nodes } };
}
function box(width = 80, draft = ""): string[] {
	const status = "╭── π ▶ ⬢ Model ▶";
	const input = `╰─ ${draft}`;
	return [status + "─".repeat(width - status.length - 1) + "╮", input + " ".repeat(Math.max(1, width - input.length - 2)) + "─╯"];
}
function painted(text: string): string[] {
	return ["", ...`Error: ${text}`.split("\n").map(row => row ? ` ${row}` : ""), "", ...box()];
}
const texts = (result: PromptRejection[]) => result.map(({ text }) => text);

describe("semantic prompt rejection diagnostics", () => {
	it("preserves the full missing-model and missing-key guidance, paragraphs and styled path", () => {
		const full = model(`/Users/a directory/${"long-path/".repeat(160)}agent.db`);
		const first = notice(full);
		const body = first.c![1]!;
		if (body.k !== "text") throw new Error("The diagnostic fixture requires a text body.");
		body.p!.spans = [{ t: "No model selected.\n\n" }, { t: full.slice("No model selected.\n\n".length), s: "mono" }, { t: "hidden presentation", s: "hide" }];
		expect(semanticPromptRejections([surface([first, notice(key(), "credential")])])).toMatchObject([
			{ text: full, kind: "preflight" }, { text: key(), kind: "preflight" },
		]);
	});

	it.each(["Nothing to resume", "Nothing to resume."])("recognizes the exact resume diagnostic %j", text => {
		expect(semanticPromptRejections([surface([notice(text)])])).toMatchObject([{ text, kind: "resume" }]);
	});

	it("reads only error notice roles, never transcript, warning, toast or editor text", () => {
		const roles = [TSP_ROLES.user, TSP_ROLES.assistant, TSP_ROLES.thinking, TSP_ROLES.tool, TSP_ROLES.userShell, TSP_ROLES.userPython, TSP_ROLES.noticeWarning, TSP_ROLES.toastStatus, TSP_ROLES.editor];
		expect(semanticPromptRejections([surface(roles.map((role, index) => notice(model(), `quoted-${index}`, role)))])).toEqual([]);
	});

	it("ignores hidden nodes and closed or suspended surfaces", () => {
		const hidden = notice(model()); hidden.p!.hidden = true;
		const ancestor: TspNode = { id: "hidden-parent", k: "col", p: { hidden: true }, c: [notice(key(), "child")] };
		expect(semanticPromptRejections([
			surface([hidden, ancestor]), { ...surface([notice(model())], "closed"), closed: true },
			{ ...surface([notice(key())], "suspended"), suspended: true },
		])).toEqual([]);
	});

	it.each([
		"No model selected.", "No API key found for openai-codex.", "Nothing to resume. Try again.",
		`A tool printed: ${model()}`, `No model selected.\n\nUse a different model.`,
		`${model()}\n\nAnother message`, `No API key found for openai-codex.\n\n${guidance}`,
		`No API key found for openai-codex.\n\n${guidance}/tmp/agent.db\nprivate transcript`,
		"Request failed with status 401.",
	])("ignores unrelated or incomplete notice text %j", text => {
		expect(semanticPromptRejections([surface([notice(text)])])).toEqual([]);
	});

	it("supplies stable before signatures, with node, surface and message identity", () => {
		const before = semanticPromptRejections([surface([notice(model())])]);
		expect(semanticPromptRejections([surface([notice(model())])])).toEqual(before);
		const previous = new Set(before.map(item => item.key));
		const after = semanticPromptRejections([surface([notice(model()), notice(model(), "new-error")]), surface([notice(model())], "s:2")]);
		expect(after.filter(item => !previous.has(item.key))).toHaveLength(2);
		expect(semanticPromptRejections([surface([notice(key())])])[0]!.key).not.toBe(before[0]!.key);
	});
});

describe("classic prompt rejection diagnostics", () => {
	it.each([model(), key(), "Nothing to resume", "Nothing to resume."])("preserves the complete omp diagnostic %j", text => {
		expect(classicPromptRejections(painted(text))).toMatchObject([{ text, kind: text.startsWith("Nothing") ? "resume" : "preflight" }]);
	});

	it("joins word-wrapped guidance while preserving paragraph boundaries", () => {
		const lines = [
			"", " Error: No model selected.", "",
			" Use /login, set an API key environment", " variable, or create /tmp/agent/agent.db", "",
			" Then use /model to select a model.", "", ...box(),
		];
		expect(texts(classicPromptRejections(lines))).toEqual([model()]);
	});

	it("joins a hard-wrapped path without adding spaces or truncating the guidance", () => {
		const width = 80;
		const path = `C:\\Users\\${"long-directory\\".repeat(120)}agent.db`;
		const chunks = path.match(/.{1,78}/g)!;
		const lines = ["", " Error: No model selected.", "", ` ${guidance.trimEnd()}`, ...chunks.map(chunk => ` ${chunk}`), "", " Then use /model to select a model.", ...box(width)];
		expect(texts(classicPromptRejections(lines))).toEqual([model(path)]);
	});

	it("keeps path spaces when the screen wraps between words rather than inside a long token", () => {
		const lines = ["", " Error: No API key found for anthropic.", "", ` ${guidance}/Users/a`, " directory/agent/agent.db", "", ...box()];
		expect(texts(classicPromptRejections(lines))).toEqual([key("anthropic", "/Users/a directory/agent/agent.db")]);
	});

	it.each([
		[" π ▶ ⬢ Model ▶─0.3%─────────┃1M─", "╰─ input"],
		[" π > [M] Model >-0.3%------┃1M-", "╰─ input"],
		[" π \ue0b0 \uec19 Model \ue0b0─0.3%─────┃1M─", "╰─ input"],
		[" 🗑 …tools ▶──────╎┃", "╰─"],
	])("stops at verified band status chrome %j", (status, input) => {
		expect(texts(classicPromptRejections(["", " Error: Nothing to resume", "", status, input]))).toEqual(["Nothing to resume"]);
	});

	it("stops before boxed multiline editor rows, including diagnostic-looking drafts", () => {
		const [status, bottom] = box();
		expect(texts(classicPromptRejections(["", " Error: Nothing to resume", "", status!, "│ Error: No model selected. │", "│ private newer draft █", bottom!]))).toEqual(["Nothing to resume"]);
		expect(classicPromptRejections([status!, ...painted(model()).slice(1, -2).map(row => `│ ${row} │`), bottom!])).toEqual([]);
	});

	it("ignores stale transcript diagnostics when newer output separates them from the composer", () => {
		const older = painted(model()).slice(0, -2);
		expect(classicPromptRejections([...older, " Assistant answered normally.", "", ...box()])).toEqual([]);
		expect(classicPromptRejections([...older, " Error: Request failed with status 401.", "", ...box()])).toEqual([]);
		expect(classicPromptRejections([...older, " Warning: model changed", "", ...box()])).toEqual([]);
	});

	it("returns only the bottommost recognized error rather than transcript history", () => {
		const lines = [...painted(model()).slice(0, -2), ...painted(key())];
		expect(texts(classicPromptRejections(lines))).toEqual([key()]);
	});

	it("keeps classic signatures stable for stale and identical repeated errors", () => {
		const before = classicPromptRejections(painted(model()));
		expect(classicPromptRejections([" Earlier transcript", ...painted(model())])).toEqual(before);
		expect(classicPromptRejections([...painted(model()).slice(0, -2), ...painted(model())])).toEqual(before);
		expect(classicPromptRejections(painted(key()))[0]!.key).not.toBe(before[0]!.key);
	});

	it("looks through only the observed submission's numbered image previews", () => {
		const previews = [1, 2].flatMap(index => [`╭── IMAGE #${index} ───╮`, "│ preview │", "╰─ 200x200 ──╯", ""]);
		const lines = [...painted(model()).slice(0, -2), ...previews, ...box()];
		expect(classicPromptRejections(lines)).toEqual([]);
		expect(texts(classicPromptRejections(lines, { symbol: "IMAGE", count: 2 }))).toEqual([model()]);
		expect(classicPromptRejections(lines, { symbol: "OTHER", count: 2 })).toEqual([]);
		expect(classicPromptRejections(lines, { symbol: "IMAGE", count: 1 })).toEqual([]);
		expect(classicPromptRejections(lines, { symbol: "IMAGE", count: 3 })).toEqual([]);
	});

	it.each([
		["│ Error: Nothing to resume │"], ["> Error: Nothing to resume"], ["  Error: Nothing to resume"],
		[" Tool output: Error: Nothing to resume"], ["```text", "", " Error: Nothing to resume"],
		["~~~", "", " Error: Nothing to resume"], [" Error: Nothing to resume", " tool output continues"],
		[" Error: No model selected.", "", " guidance from a tool"],
	])("ignores transcript, quoted tool and unrelated error lookalikes %j", (...rows) => {
		expect(classicPromptRejections(["", ...rows, "", ...box()])).toEqual([]);
	});

	it("accepts a real diagnostic after a closed code fence", () => {
		expect(texts(classicPromptRejections(["```", "tool text", "```", ...painted(model())]))).toEqual([model()]);
	});

	it.each([
		[], ["╭─ Generic dialog ─╮", "│ value │", "╰────────╯"],
		["╭── π ▶ ⬢ Model ──╮", "ordinary transcript output", "╰─ quoted input ─╯"],
		[" π ▶ ⬢ Model ▶─0.3%─", "ordinary transcript output"],
		["╭── π ▶ ⬢ Model ──╮"],
	])("requires adjacent editor context rather than a quoted border %j", (...chrome) => {
		expect(classicPromptRejections(["", " Error: Nothing to resume", "", ...chrome])).toEqual([]);
	});
});
