import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	deleteDocumentPath,
	documentJson,
	ompErrorMessage,
	parseCfgLeaf,
	parseCfgTree,
	parseConfigDocument,
	parseConfigList,
	parseModels,
	setDocumentPath,
	splitRoleValue,
	valueProblem,
} from "./omp-config";

/** Captured from omp 18.4.4 with an isolated PI_CODING_AGENT_DIR (see the config in the test names). */
const fixture = (name: string) => readFileSync(join(__dirname, "__fixtures__", name), "utf8");

describe("omp config list --json", () => {
	const listed = parseConfigList(JSON.parse(fixture("config-list.json")));

	it("withholds configured credentials and reports unset values as null", () => {
		expect(listed.get("auth.broker.token")).toMatchObject({ type: "string", value: null, redacted: true });
		expect(listed.get("auth.broker.url")).toMatchObject({ value: null, redacted: false });
		expect(listed.get("tools.approval")).toMatchObject({ type: "record", value: { bash: "prompt" } });
	});
});

describe("omp read cfg:// tree", () => {
	const listed = parseConfigList(JSON.parse(fixture("config-list.json")));
	const tree = parseCfgTree(fixture("cfg-tree.txt"), listed);

	it("recovers enum values and a default that differs from the value", () => {
		expect(tree.get("advisor.syncBacklog")).toEqual({ enumValues: ["off", "1", "3", "5"], defaultValue: "off" });
		expect(tree.get("tools.approvalMode")).toEqual({ enumValues: ["always-ask", "write", "yolo"], defaultValue: "yolo" });
	});

	it("treats a missing default part as value == default", () => {
		expect(tree.get("defaultThinkingLevel")?.defaultValue).toBe("high");
		expect(tree.get("presencePenalty")?.defaultValue).toBe(-1);
		expect(tree.get("cycleOrder")?.defaultValue).toEqual(["smol", "default", "slow"]);
		expect(tree.get("bashInterceptor.patterns")?.defaultValue).toEqual(listed.get("bashInterceptor.patterns")?.value);
	});

	it("keeps `#` inside string values and nested namespaces apart", () => {
		expect(tree.get("theme.dark")?.defaultValue).toBe("titanium");
		expect(tree.get("auth.broker.token")?.defaultValue).toBeNull();
		expect(tree.get("tools.approval")?.defaultValue).toEqual({});
		expect(tree.get("compaction.enabled")?.defaultValue).toBe(true);
		expect(tree.size).toBe(listed.size);
	});

	it("does not mistake a description starting with 'default' or a value containing '  # ' for comment parts", () => {
		const known = new Map([
			["a.b", { type: "string" as const, description: "default model for things. More text." }],
			["a.c", { type: "enum" as const, description: "" }],
		]);
		const parsed = parseCfgTree('a:\n  b: "x  # y"  # default model for things.\n  c: "on"  # on|off · default "off"\n', known);
		expect(parsed.get("a.b")).toEqual({ enumValues: null, defaultValue: "x  # y" });
		expect(parsed.get("a.c")).toEqual({ enumValues: ["on", "off"], defaultValue: "off" });
	});
});

describe("omp read cfg://<key>", () => {
	it("parses an enum leaf with its source layer", () => {
		expect(parseCfgLeaf(fixture("cfg-leaf-enum.txt"))).toMatchObject({
			key: "tools.approvalMode",
			type: "enum",
			value: "write",
			defaultValue: "yolo",
			source: "global",
			enumValues: ["always-ask", "write", "yolo"],
		});
	});

	it("parses a redacted credential leaf", () => {
		expect(parseCfgLeaf(fixture("cfg-leaf-credential.txt"))).toMatchObject({
			key: "auth.broker.token",
			value: null,
			redacted: true,
			defaultValue: null,
			source: "global",
			enumValues: null,
			description: "",
		});
	});
});

describe("omp models --json", () => {
	const models = parseModels(JSON.parse(fixture("models.json")));

	it("maps capabilities, limits and pricing", () => {
		const fable = models.find(model => model.selector === "anthropic/claude-fable-5");
		expect(fable).toMatchObject({ kind: "chat", reasoning: true, vision: true, contextWindow: 1_000_000 });
		expect(fable?.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
		const tts = models.find(model => model.kind === "tts");
		expect(tts).toMatchObject({ contextWindow: null, maxOutputTokens: null, thinkingLevels: [], vision: false });
		const long = models.find(model => model.cost?.longContext);
		expect(long?.cost?.longContext?.inputThreshold).toBeGreaterThan(0);
	});

	it("drops models of kinds this app does not know instead of failing the list", () => {
		const raw = JSON.parse(fixture("models.json"));
		raw.models.push({ ...raw.models[0], kind: "hologram", selector: "x/y", id: "y" });
		expect(parseModels(raw).some(model => model.selector === "x/y")).toBe(false);
	});
});

describe("role values", () => {
	it("splits a trailing thinking level like omp", () => {
		expect(splitRoleValue("anthropic/claude-opus-5-5:xhigh")).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "xhigh" });
		expect(splitRoleValue("openai/gpt:auto")).toEqual({ model: "openai/gpt", thinking: "auto" });
		expect(splitRoleValue("ollama/llama3:8b")).toEqual({ model: "ollama/llama3:8b", thinking: null });
		expect(splitRoleValue("@slow")).toEqual({ model: "@slow", thinking: null });
	});

	it("keeps a real model id ending in :max literal", () => {
		expect(splitRoleValue("zai/glm-4.7:max", new Set(["zai/glm-4.7:max"]))).toEqual({ model: "zai/glm-4.7:max", thinking: null });
		expect(splitRoleValue("zai/glm-4.7:max", new Set())).toEqual({ model: "zai/glm-4.7", thinking: "max" });
	});
});

describe("config.yml edits", () => {
	it("keeps comments and writes block style into an empty file", () => {
		const doc = parseConfigDocument("");
		setDocumentPath(doc, ["task", "disabledAgents"], ["task"]);
		expect(doc.toString()).toBe("task:\n  disabledAgents:\n    - task\n");

		const commented = parseConfigDocument("# notes\ntheme:\n  dark: titanium # fav\n");
		setDocumentPath(commented, ["theme", "dark"], "abyss");
		setDocumentPath(commented, ["tools", "approval", "bash"], "prompt");
		expect(commented.toString()).toBe("# notes\ntheme:\n  dark: abyss # fav\ntools:\n  approval:\n    bash: prompt\n");
	});

	it("prunes mappings a removal empties, but keeps siblings", () => {
		const doc = parseConfigDocument("tools:\n  approval:\n    bash: prompt\n  approvalMode: write\n");
		expect(deleteDocumentPath(doc, ["tools", "approval", "bash"])).toBe(true);
		expect(documentJson(doc)).toEqual({ tools: { approvalMode: "write" } });
		expect(deleteDocumentPath(doc, ["tools", "approvalMode"])).toBe(true);
		expect(documentJson(doc)).toEqual({});
		expect(deleteDocumentPath(doc, ["tools", "approvalMode"])).toBe(false);
	});

	it("turns a file left as `{}` back into block style on the next write", () => {
		const doc = parseConfigDocument("{}\n");
		setDocumentPath(doc, ["modelRoles", "smol"], "local/gemma-3-1b");
		expect(doc.toString()).toBe("modelRoles:\n  smol: local/gemma-3-1b\n");
	});

	it("replaces a null intermediate node and refuses unparseable YAML", () => {
		const doc = parseConfigDocument("tools:\n");
		setDocumentPath(doc, ["tools", "approvalMode"], "yolo");
		expect(documentJson(doc)).toEqual({ tools: { approvalMode: "yolo" } });
		expect(() => parseConfigDocument("foo: [\n")).toThrow(/Invalid YAML/);
		expect(() => parseConfigDocument("- a\n")).toThrow(/mapping/);
	});
});

describe("values and errors", () => {
	it("rejects values omp would silently ignore", () => {
		expect(valueProblem("enum", ["always-ask", "write", "yolo"], "bogus")).toMatch(/always-ask/);
		expect(valueProblem("number", null, Number.NaN)).not.toBeNull();
		expect(valueProblem("record", null, [])).not.toBeNull();
		expect(valueProblem("boolean", null, false)).toBeNull();
	});

	it("extracts the message from omp's uncaught-error output", () => {
		const stderr = `666311 |         throw new Error(\`bad\`);\n                       ^\nerror: Provider request limits must be positive numbers: anthropic\n      at X2 (/$bunfs/root/omp:1:1)\n`;
		expect(ompErrorMessage(stderr, "fallback")).toBe("Provider request limits must be positive numbers: anthropic");
		expect(ompErrorMessage("Unknown setting: nope\n", "fallback")).toBe("Unknown setting: nope");
	});
});
