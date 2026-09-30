import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfigDocument } from "../../services/omp-config";
import {
	allSkillsOverlay,
	analyzeSkillFile,
	applySkillSettingsToDocument,
	disabledReason,
	needsScriptApproval,
	parseRegistryOutput,
	parseSkillConfig,
	parseSkillList,
	parseSkillPackage,
	parseSkillSearch,
	parseSkillVersion,
	registryFailure,
	registryFromPath,
	type SkillConfig,
	type SourceContext,
	setSkillEnabledInDocument,
	sourceEnabled,
	splitSource,
	toggleDisabledExtensions,
} from "./parse";

/**
 * Real omp v18.4.4 output captured against a temp HOME / PI_CODING_AGENT_DIR with test skills, and a local
 * Skillshare registry serving `@vomp/hello` (1.0.0, 1.1.0) and `@vomp/scripted` (ships scripts).
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const config = parseSkillConfig(fixture("config-list.json"));
const context = (patch: Partial<SkillConfig["skills"]> = {}, rest: Partial<SkillConfig> = {}): SourceContext => ({
	config: { ...config, ...rest, skills: { ...config.skills, ...patch } },
	inClaudeTree: false,
	claudeConfigDirSet: false,
});

describe("parseSkillConfig", () => {
	it("separates skill disables from other disabled extensions", () => {
		expect(config.disabledExtensions).toEqual(["skill:delta", "ext:other"]);
		expect(config.skills.disabledSkills).toEqual(["delta"]);
		expect(config.skills.ignoredSkills).toEqual(["gam*"]);
		expect(config.skills.registryUrl).toBe("http://127.0.0.1:47811");
	});

	it("keeps non-skill disables in the all-skills overlay and clears every filter", () => {
		const overlay = JSON.parse(allSkillsOverlay(config));
		expect(overlay.disabledExtensions).toEqual(["ext:other"]);
		expect(overlay.skills).toMatchObject({ ignoredSkills: [], includeSkills: [], enableCodexUser: true, enabled: true });
		expect(overlay.enabledProviders).toEqual(["*"]);
	});
});

describe("disabled attribution over real listings", () => {
	const effective = parseSkillList(fixture("list-effective.json"));
	const all = parseSkillList(fixture("list-all.json"));
	const loaded = new Set(effective.skills.map(s => s.filePath));
	const missing = all.skills.filter(s => !loaded.has(s.filePath));
	const reasonOf = (name: string, ctx: SourceContext) => {
		const skill = missing.find(s => s.name === name);
		if (!skill) throw new Error(`${name} not missing`);
		return disabledReason({ name, ...splitSource(skill.source) }, ctx);
	};

	it("finds exactly the skills the effective listing omits", () => {
		expect(missing.map(s => s.name).sort()).toEqual(["delta", "gamma"]);
	});

	it("attributes a disabledExtensions entry, returning it as the toggle name", () => {
		expect(reasonOf("delta", context())).toEqual({ reason: "disabled", toggleName: "delta" });
	});

	it("checks the source toggle before ignore globs, like omp", () => {
		expect(reasonOf("gamma", context()).reason).toBe("sourceDisabled");
		expect(reasonOf("gamma", context({ enableCodexUser: true })).reason).toBe("ignored");
		expect(reasonOf("gamma", context({ ignoredSkills: [] }, { enabledProviders: ["codex"] })).reason).toBe("duplicate");
	});

	it("reports skillsOff for everything when skills are disabled", () => {
		expect(reasonOf("gamma", context({ enabled: false })).reason).toBe("skillsOff");
	});
});

describe("disabledReason edge cases", () => {
	it("matches disables and ignores against the raw name of a namespaced skill", () => {
		const skill = { name: "agents/alpha", provider: "agents", level: "user" as const };
		expect(disabledReason(skill, context({ disabledSkills: ["alpha"] }))).toEqual({ reason: "disabled", toggleName: "alpha" });
		expect(disabledReason(skill, context({ ignoredSkills: ["alp*"] })).reason).toBe("ignored");
	});

	it("applies include globs to the final name; `*` does not cross the namespace slash", () => {
		const skill = { name: "agents/alpha", provider: "agents", level: "user" as const };
		expect(disabledReason(skill, context({ includeSkills: ["a*"] })).reason).toBe("notIncluded");
		expect(disabledReason(skill, context({ includeSkills: ["agents/*"] })).reason).toBe("duplicate");
	});
});

describe("sourceEnabled", () => {
	it("keeps foreign user providers opt-in but project levels on", () => {
		expect(sourceEnabled("opencode", "user", context())).toBe(false);
		expect(sourceEnabled("opencode", "user", context({}, { enabledProviders: ["*"] }))).toBe(true);
		expect(sourceEnabled("opencode", "project", context())).toBe(true);
	});

	it("only gates claude-plugins skills that live in Claude Code's own tree", () => {
		expect(sourceEnabled("claude-plugins", "user", context())).toBe(true);
		expect(sourceEnabled("claude-plugins", "user", { ...context(), inClaudeTree: true })).toBe(false);
		expect(sourceEnabled("claude-plugins", "user", { ...context({}, { enabledProviders: ["claude"] }), inClaudeTree: true })).toBe(true);
	});

	it("lets disabledProviders switch off even default-on providers", () => {
		expect(sourceEnabled("agents", "project", context({}, { disabledProviders: ["agents"] }))).toBe(false);
		expect(sourceEnabled("omp-managed", "user", context({}, { disabledProviders: ["omp-managed"] }))).toBe(true);
	});
});

it("toggleDisabledExtensions adds once and removes only the skill entry", () => {
	expect(toggleDisabledExtensions(["ext:x", "skill:a"], "a", false)).toEqual(["ext:x", "skill:a"]);
	expect(toggleDisabledExtensions(["ext:x", "skill:a"], "a", true)).toEqual(["ext:x"]);
	expect(toggleDisabledExtensions(["ext:x"], "b", false)).toEqual(["ext:x", "skill:b"]);
});

it("registryFromPath reads id and version from a real Skillshare store path", () => {
	const [skill] = parseSkillList(fixture("list-skillshare.json")).skills;
	expect(splitSource(skill?.source ?? "")).toEqual({ provider: "skillshare", level: "project" });
	expect(registryFromPath(skill?.filePath ?? "")).toEqual({ id: "@vomp/hello", version: "1.1.0" });
	expect(registryFromPath("/home/u/.agents/skills/x/SKILL.md")).toBeNull();
});

describe("config.yml document edits", () => {
	const USER_YAML = [
		"# my omp config",
		"disabledExtensions:",
		"  - ext:other # keep this one",
		"skills:",
		"  # hide noisy skills",
		"  ignoredSkills:",
		"    - gam*",
		"theme: dark",
		"",
	].join("\n");

	it("toggles a skill without touching comments or other entries", () => {
		const doc = parseConfigDocument(USER_YAML);
		setSkillEnabledInDocument(doc, "delta", false);
		const text = doc.toString();
		expect(text).toContain("# my omp config");
		expect(text).toContain("- ext:other # keep this one");
		expect(text).toContain("# hide noisy skills");
		expect(doc.toJS().disabledExtensions).toEqual(["ext:other", "skill:delta"]);
		setSkillEnabledInDocument(doc, "delta", true);
		expect(doc.toJS().disabledExtensions).toEqual(["ext:other"]);
	});

	it("removes keys set back to omp's default, pruning sections left empty", () => {
		const doc = parseConfigDocument(USER_YAML);
		applySkillSettingsToDocument(doc, { ignoredSkills: [], enableCodexUser: true });
		expect(doc.toJS().skills).toEqual({ enableCodexUser: true });
		applySkillSettingsToDocument(doc, { enableCodexUser: false, listInSystemPrompt: false });
		// The emptied `skills:` section still carries the user's comment, so the shared editor keeps it.
		expect(doc.toJS()).toEqual({ disabledExtensions: ["ext:other"], skills: {}, theme: "dark", skillful: false });
		const plain = parseConfigDocument("skills:\n  enableCodexUser: true\ntheme: dark\n");
		applySkillSettingsToDocument(plain, { enableCodexUser: false, registryUrl: "https://skills.omp.sh" });
		expect(plain.toJS()).toEqual({ theme: "dark" });
	});

	it("replaces only skill entries when setting disabledSkills, deleting an emptied list", () => {
		const doc = parseConfigDocument("disabledExtensions:\n  - skill:a\n  - ext:x\n");
		applySkillSettingsToDocument(doc, { disabledSkills: ["b", "c"] });
		expect(doc.toJS().disabledExtensions).toEqual(["ext:x", "skill:b", "skill:c"]);
		const onlySkills = parseConfigDocument("disabledExtensions:\n  - skill:a\n");
		applySkillSettingsToDocument(onlySkills, { disabledSkills: [] });
		expect(onlySkills.toJS()).toEqual({});
	});

	it("refuses to rewrite a disabledExtensions value that is not a list", () => {
		expect(() => setSkillEnabledInDocument(parseConfigDocument("disabledExtensions: nope\n"), "a", false)).toThrow(
			/not a list/,
		);
	});
});

describe("analyzeSkillFile", () => {
	const codes = (content: string, provider?: string) => analyzeSkillFile(content, "dir", provider).issues.map(i => [i.code, i.severity]);

	it("accepts what omp's lenient repair accepts", () => {
		const result = analyzeSkillFile("---\r\nname: x\r\ndescription: Use when: testing\r\n---\r\nBody\r\n", "dir");
		expect(result.issues).toEqual([]);
		expect(result.frontmatter).toEqual({ name: "x", description: "Use when: testing" });
		expect(result.body).toBe("Body");
	});

	it("reports unrecoverable YAML and reads the key/value fallback", () => {
		const result = analyzeSkillFile(fixture("broken-skill.md"), "broken");
		expect(result.issues.map(i => i.code)).toEqual(["yamlError"]);
		expect(result.frontmatter).toMatchObject({ name: "broken", description: "[unclosed" });
	});

	it("makes a missing description fatal only for loaders that require one", () => {
		expect(codes("---\nname: x\n---\n", "native")).toEqual([["missingDescription", "error"]]);
		expect(codes("---\nname: x\n---\n", "agents")).toEqual([["missingDescription", "warning"]]);
		expect(codes("just text", "claude")).toEqual([
			["noFrontmatter", "warning"],
			["missingDescription", "warning"],
		]);
	});

	it("flags names with separators, frontmatter disables and empty files", () => {
		expect(codes("---\nname: a/b\ndescription: d\n---\n")).toEqual([["invalidName", "error"]]);
		expect(codes("---\ndescription: d\nenabled: false\n---\n")).toEqual([["disabledInFrontmatter", "error"]]);
		expect(codes("")).toEqual([["empty", "error"]]);
	});
});

describe("registry JSON", () => {
	it("parses search hits with ids, and the real (empty) registry response", () => {
		const result = parseSkillSearch(fixture("search.json"));
		expect(result.hits.map(h => [h.id, h.version, h.deprecated])).toEqual([["@vomp/hello", "1.1.0", null]]);
		expect(parseSkillSearch(fixture("search-real-empty.json"))).toEqual({ total: 0, page: 1, perPage: 20, hits: [] });
	});

	it("orders packument versions newest first", () => {
		const info = parseSkillPackage(fixture("info.json"));
		expect(info.id).toBe("@vomp/hello");
		expect(info.versions.map(v => v.version)).toEqual(["1.1.0", "1.0.0"]);
		expect(info.distTags).toEqual({ latest: "1.1.0" });
		expect(info.repository).toBeNull();
	});

	it("parses a resolved version manifest", () => {
		const version = parseSkillVersion(fixture("info-version.json"));
		expect(version).toMatchObject({ id: "@vomp/hello", version: "1.1.0", hasScripts: false, compatibility: null });
		expect(version.files.map(f => f.path)).toEqual(["SKILL.md"]);
	});
});

describe("registry text output", () => {
	it("parses install, range update, restore and uninstall lines", () => {
		expect(parseRegistryOutput(fixture("install.stdout.txt"), "").changes).toEqual([
			{ id: "@vomp/hello", from: null, to: "1.0.0", kind: "added" },
		]);
		expect(parseRegistryOutput(fixture("install-update.stdout.txt"), "").changes).toEqual([
			{ id: "@vomp/hello", from: "1.0.0", to: "1.1.0", kind: "updated" },
		]);
		expect(parseRegistryOutput(fixture("install-restore.stdout.txt"), "").changes).toEqual([
			{ id: "@vomp/hello", from: "1.1.0", to: "1.1.0", kind: "restored" },
		]);
		expect(parseRegistryOutput(fixture("uninstall.stdout.txt"), "").removed).toEqual(["@vomp/hello"]);
	});

	it("parses range-only edits and warn lines", () => {
		const output = parseRegistryOutput("✓ @a/b@1.2.0 (^1.2.0)\n", "warn @a/b@1.2.0 is deprecated: use c\n");
		expect(output.changes).toEqual([{ id: "@a/b", from: "1.2.0", to: "1.2.0", kind: "range" }]);
		expect(output.warnings).toEqual(["@a/b@1.2.0 is deprecated: use c"]);
	});

	it("detects the scripts refusal and cleans omp's error prefix", () => {
		const stderr = fixture("install-scripts.stderr.txt");
		expect(needsScriptApproval(stderr)).toBe(true);
		expect(registryFailure("", stderr, "x").startsWith("@vomp/scripted@1.0.0 ships scripts:")).toBe(true);
		expect(registryFailure("", fixture("uninstall-missing.stderr.txt"), "x")).toMatch(/^@vomp\/hello is not installed/);
		expect(needsScriptApproval(fixture("uninstall-missing.stderr.txt"))).toBe(false);
	});
});
