import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_DISCOVERY_SETTINGS, parseMcpDiscoverySettings } from "./settings";

describe("MCP discovery settings", () => {
	it("uses omp defaults when unset config entries omit their value field", () => {
		expect(
			parseMcpDiscoverySettings({
				"mcp.enableProjectConfig": {},
				"browser.enabled": {},
				enabledProviders: {},
				disabledProviders: {},
				disabledExtensions: {},
			}),
		).toEqual(DEFAULT_MCP_DISCOVERY_SETTINGS);
	});

	it("preserves configured flags and provider filters", () => {
		expect(
			parseMcpDiscoverySettings({
				"mcp.enableProjectConfig": { value: false },
				"browser.enabled": { value: true },
				enabledProviders: { value: ["npm", "local"] },
				disabledProviders: { value: ["legacy"] },
			}),
		).toEqual({
			enableProjectConfig: false,
			browserEnabled: true,
			enabledProviders: ["npm", "local"],
			disabledProviders: ["legacy"],
			disabledExtensions: [],
		});
	});
});
