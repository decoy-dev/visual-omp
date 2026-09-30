import type { ModelInfo, ModelRoleInfo, SettingInfo } from "@shared/contracts/config";
import { describe, expect, it } from "vitest";
import type { GuestSnapshot } from "@/collab/lib/client";
import { copyName, runningAgentChats } from "./agents/agentsModel";
import { changedRoleIds, modelValueStatus, orderRoles, thinkingChoices } from "./roles/rolesModel";
import { buildAdvancedRows, parseSettingInput } from "./settings/advancedModel";

function setting(key: string, patch: Partial<SettingInfo> = {}): SettingInfo {
	const dot = key.lastIndexOf(".");
	return {
		key,
		namespace: dot > 0 ? key.slice(0, dot) : null,
		type: "boolean",
		description: "",
		enumValues: null,
		defaultValue: false,
		value: false,
		redacted: false,
		modified: false,
		source: "default",
		globalValue: null,
		projectValue: null,
		...patch,
	};
}

function model(selector: string, patch: Partial<ModelInfo> = {}): ModelInfo {
	const [provider = "", id = ""] = selector.split("/");
	return {
		selector,
		provider,
		id,
		name: id,
		kind: "chat",
		contextWindow: 200_000,
		maxOutputTokens: null,
		reasoning: true,
		thinkingLevels: ["low", "high"],
		vision: false,
		cost: null,
		...patch,
	};
}

function role(id: string, patch: Partial<ModelRoleInfo> = {}): ModelRoleInfo {
	return {
		id,
		name: id,
		builtIn: true,
		section: "chat",
		acceptsKinds: ["chat"],
		color: null,
		hidden: false,
		inCycle: false,
		value: null,
		model: null,
		thinking: null,
		source: "default",
		globalValue: null,
		projectValue: null,
		...patch,
	};
}

describe("advanced settings list", () => {
	const settings = [
		setting("tui.mouse", { description: "Mouse support" }),
		setting("personality", { type: "enum", description: "Tone" }),
		setting("compaction.enabled", { description: "Automatically compact context", modified: true }),
		setting("compaction.idleEnabled"),
	];

	it("groups by first key segment with top-level keys under general first", () => {
		const rows = buildAdvancedRows(settings, "");
		expect(rows.filter(row => row.kind === "group").map(row => row.kind === "group" && [row.domain, row.count])).toEqual([
			["general", 1],
			["compaction", 2],
			["tui", 1],
		]);
		expect(rows[1]).toMatchObject({ kind: "setting", setting: { key: "personality" } });
	});

	it("matches every search word against key and description, dropping empty groups", () => {
		const rows = buildAdvancedRows(settings, "compact  AUTOMATICALLY");
		expect(rows.map(row => (row.kind === "group" ? `#${row.domain}` : row.setting.key))).toEqual(["#compaction", "compaction.enabled"]);
	});

	it("can show only changed settings", () => {
		const rows = buildAdvancedRows(settings, "", true);
		expect(rows.flatMap(row => (row.kind === "setting" ? [row.setting.key] : []))).toEqual(["compaction.enabled"]);
	});
});

describe("setting input parsing", () => {
	it("parses numbers and rejects non-numbers and blanks", () => {
		expect(parseSettingInput("number", " 42.5 ")).toEqual({ ok: true, value: 42.5 });
		expect(parseSettingInput("number", "abc")).toEqual({ ok: false, error: "number" });
		expect(parseSettingInput("number", "")).toEqual({ ok: false, error: "number" });
	});

	it("requires the right JSON shape for lists and records", () => {
		expect(parseSettingInput("array", '["a","b"]')).toEqual({ ok: true, value: ["a", "b"] });
		expect(parseSettingInput("array", '{"a":1}')).toEqual({ ok: false, error: "array" });
		expect(parseSettingInput("record", "[1]")).toEqual({ ok: false, error: "record" });
		expect(parseSettingInput("record", "{oops")).toEqual({ ok: false, error: "json" });
	});

	it("keeps strings verbatim", () => {
		expect(parseSettingInput("string", "  spaced  ")).toEqual({ ok: true, value: "  spaced  " });
	});
});

describe("model roles", () => {
	const models = [model("anthropic/opus"), model("local/tiny-1", { reasoning: false, thinkingLevels: [] })];

	it("orders built-in roles by the design order and keeps custom roles after them", () => {
		const ordered = orderRoles([role("smol"), role("designer", { builtIn: false }), role("plan"), role("default")]);
		expect(ordered.map(entry => entry.id)).toEqual(["default", "plan", "smol", "designer"]);
	});

	it("classifies stored values against usable models", () => {
		expect(modelValueStatus(null, models)).toBe("auto");
		expect(modelValueStatus("@slow", models)).toBe("alias");
		expect(modelValueStatus("anthropic/opus", models)).toBe("available");
		expect(modelValueStatus("opus", models)).toBe("available");
		expect(modelValueStatus("openai/gone", models)).toBe("missing");
	});

	it("offers only the thinking levels a known model supports", () => {
		expect(thinkingChoices(models[0] ?? null, true)).toEqual(["inherit", "off", "low", "high", "auto"]);
		expect(thinkingChoices(models[1] ?? null, true)).toEqual(["inherit"]);
		expect(thinkingChoices(null, false)).toContain("max");
	});

	it("reports roles whose draft differs, ignoring thinking on cleared roles", () => {
		const roles = [role("default", { model: "anthropic/opus", thinking: "high" }), role("smol")];
		expect(changedRoleIds(roles, { default: { model: "anthropic/opus", thinking: "high" } })).toEqual([]);
		expect(changedRoleIds(roles, { default: { model: "anthropic/opus", thinking: "low" } })).toEqual(["default"]);
		expect(changedRoleIds(roles, { smol: { model: null, thinking: "low" } })).toEqual([]);
		expect(changedRoleIds(roles, { smol: { model: "local/tiny-1", thinking: null } })).toEqual(["smol"]);
	});
});

describe("helpers hub", () => {
	function guest(progress: [string, string, string][], lifecycle: [string, string, string][] = []): GuestSnapshot {
		return {
			progress: new Map(progress.map(([id, agent, status]) => [id, { progress: { id, agent, status } }])),
			lifecycle: new Map(lifecycle.map(([id, agent, status]) => [id, { id, agent, status }])),
		} as unknown as GuestSnapshot;
	}

	it("lists chats where a helper type is running, including just-started ones", () => {
		const running = runningAgentChats([
			{ title: "Fix checkout", guest: guest([["1", "reviewer", "running"], ["2", "scout", "completed"]]) },
			{ title: "Docs", guest: guest([], [["9", "reviewer", "started"], ["8", "task", "completed"]]) },
			{ title: "Idle", guest: null },
		]);
		expect(Object.fromEntries(running)).toEqual({ reviewer: ["Fix checkout", "Docs"] });
	});

	it("trusts progress over a stale started lifecycle event", () => {
		const running = runningAgentChats([{ title: "A", guest: guest([["1", "scout", "completed"]], [["1", "scout", "started"]]) }]);
		expect(running.size).toBe(0);
	});

	it("picks the first free copy name", () => {
		expect(copyName("reviewer", new Set(["reviewer"]))).toBe("reviewer-copy");
		expect(copyName("reviewer", new Set(["reviewer-copy", "reviewer-copy-2"]))).toBe("reviewer-copy-3");
	});
});
