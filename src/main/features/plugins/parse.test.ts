import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	failureMessage,
	parseDiscover,
	parseDoctor,
	parseFeatureState,
	parseInstalledPlugin,
	parseMarketplaceInstall,
	parseMarketplaceList,
	parsePluginConfig,
	parsePluginList,
	parseUpgrades,
} from "./parse";

/** Real `omp plugin …` output (v18.4.4) captured against a temp HOME with a local plugin and marketplace. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parsePluginList", () => {
	const listing = parsePluginList(fixture("list.json"));

	it("resolves effective feature state from an explicit list", () => {
		const [plugin] = listing.npm;
		expect(plugin?.enabledFeatures).toEqual(["beta"]);
		expect(plugin?.features).toEqual([
			{ name: "alpha", description: "Alpha feature", default: true, enabled: false },
			{ name: "beta", description: "Beta feature", default: false, enabled: true },
		]);
	});

	it("maps the settings schema with nulls for absent constraints", () => {
		const settings = listing.npm[0]?.settings ?? [];
		expect(settings.find(s => s.key === "apiKey")).toMatchObject({ secret: true, env: "DEMO_KEY", default: null });
		expect(settings.find(s => s.key === "level")).toMatchObject({ type: "enum", values: ["low", "high"], default: "low" });
		expect(settings.find(s => s.key === "count")).toMatchObject({ min: 1, max: 5, step: null });
	});

	it("splits marketplace ids and reads per-scope enabled state", () => {
		const byId = Object.fromEntries(listing.marketplace.map(p => [p.id, p]));
		expect(byId["hello@vomp-mp"]).toMatchObject({ name: "hello", marketplace: "vomp-mp", scope: "user", enabled: false });
		expect(byId["other@vomp-mp"]).toMatchObject({ scope: "project", enabled: true, version: "0.0.0" });
		expect(byId["hello@vomp-mp"]?.installs[0]?.gitCommitSha).toBeNull();
	});
});

describe("npm install / features JSON", () => {
	it("uses manifest defaults when enabledFeatures is null", () => {
		const plugin = parseInstalledPlugin(fixture("install-local.json"));
		expect(plugin.enabledFeatures).toBeNull();
		expect(plugin.features.map(f => [f.name, f.enabled])).toEqual([
			["alpha", true],
			["beta", false],
		]);
	});

	it("skips the confirmation line printed before the JSON", () => {
		expect(parseFeatureState(fixture("features-updated.txt"))).toEqual({
			plugin: "vomp-demo-plugin",
			enabledFeatures: ["beta"],
			availableFeatures: ["alpha", "beta"],
		});
	});

	it("reads stored config values next to the schema", () => {
		const config = parsePluginConfig("vomp-demo-plugin", fixture("config-list.json"));
		expect(config.values).toEqual({ level: "high" });
		expect(config.schema.map(s => s.key)).toEqual(["apiKey", "level", "count"]);
	});
});

describe("doctor", () => {
	it("is healthy with warnings only", () => {
		const report = parseDoctor(fixture("doctor.json"));
		expect(report.healthy).toBe(true);
		expect(report.checks.find(c => c.name === "package_manifest")).toMatchObject({ status: "warning", fixed: false });
	});

	it("is unhealthy with an unfixed error but not with a fixed one", () => {
		const check = (fixed: boolean) => JSON.stringify([{ name: "node_modules", status: "error", message: "Missing", fixed }]);
		expect(parseDoctor(check(false)).healthy).toBe(false);
		expect(parseDoctor(check(true)).healthy).toBe(true);
	});
});

describe("text output", () => {
	it("parses marketplace rows with LF or CRLF line endings", () => {
		const output = fixture("marketplace-list.txt");
		const expected = [{ name: "vomp-mp", sourceUri: "/tmp/vomp-fixt/mp" }];
		expect(parseMarketplaceList(output)).toEqual(expected);
		expect(parseMarketplaceList(output.replace(/\n/g, "\r\n"))).toEqual(expected);
		expect(parseMarketplaceList("No marketplaces configured\n\nAdd one with: omp plugin marketplace add <source>\n")).toEqual([]);
	});

	it("keeps multi-line descriptions and versionless entries with LF or CRLF", () => {
		const output = fixture("discover.txt");
		const installed = new Map([["other@vomp-mp", ["project" as const]]]);
		const expected = [
			{
				id: "hello@vomp-mp",
				name: "hello",
				marketplace: "vomp-mp",
				version: "0.1.0",
				description: "Hello plugin\nsecond line",
				installedScopes: [],
			},
			{ id: "other@vomp-mp", name: "other", marketplace: "vomp-mp", version: null, description: null, installedScopes: ["project"] },
		];
		expect(parseDiscover(output, "vomp-mp", installed)).toEqual(expected);
		expect(parseDiscover(output.replace(/\n/g, "\r\n"), "vomp-mp", installed)).toEqual(expected);
	});

	it("parses the marketplace install confirmation", () => {
		expect(parseMarketplaceInstall(fixture("install-marketplace.txt"))).toEqual({
			name: "hello",
			marketplace: "vomp-mp",
			version: "0.1.0",
		});
	});

	it("parses bulk and single upgrade lines", () => {
		expect(parseUpgrades(fixture("upgrade-all.txt"))).toEqual([{ id: "hello@vomp-mp", scope: "user", from: "0.1.0", to: "0.2.0" }]);
		expect(parseUpgrades(fixture("upgrade-one.txt"))).toEqual([{ id: "hello@vomp-mp", scope: "user", from: null, to: "0.3.0" }]);
		expect(parseUpgrades("All marketplace plugins are up to date.\n")).toEqual([]);
	});

	it("parses the npm in-place upgrade JSON and ignores no-op upgrades", () => {
		const json = (changed: boolean) => JSON.stringify({ upgraded: "pkg", from: "1.0.0", to: "1.1.0", changed });
		expect(parseUpgrades(json(true))).toEqual([{ id: "pkg", scope: null, from: "1.0.0", to: "1.1.0" }]);
		expect(parseUpgrades(json(false))).toEqual([]);
	});
});

describe("failureMessage", () => {
	it("reduces an uncaught exception trace to its message", () => {
		expect(failureMessage("", fixture("features-crash.stderr.txt"), "x")).toBe(
			'Unknown feature "zzz" in vomp-demo-plugin. Available: alpha, beta',
		);
	});

	it("strips status glyphs and falls back when there is no output", () => {
		expect(failureMessage("", "✘ nope is not installed\n", "x")).toBe("nope is not installed");
		expect(failureMessage("", "", "fallback")).toBe("fallback");
	});
});
