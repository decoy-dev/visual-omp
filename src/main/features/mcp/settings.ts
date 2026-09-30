import { z } from "zod";
import type { McpDiscoverySettings } from "@shared/contracts/mcp";

const ConfigList = z.record(z.string(), z.looseObject({ value: z.unknown().optional() }));
const Flag = (fallback: boolean) => z.boolean().catch(fallback);
const Names = z.array(z.string()).catch([]);

export const DEFAULT_MCP_DISCOVERY_SETTINGS: McpDiscoverySettings = {
	enableProjectConfig: true,
	browserEnabled: true,
	enabledProviders: [],
	disabledProviders: [],
	disabledExtensions: [],
};

/** Parse `omp config list --json` entries used to shape MCP discovery. */
export function parseMcpDiscoverySettings(value: unknown): McpDiscoverySettings {
	const list = ConfigList.parse(value);
	return {
		enableProjectConfig: Flag(true).parse(list["mcp.enableProjectConfig"]?.value),
		browserEnabled: Flag(true).parse(list["browser.enabled"]?.value),
		enabledProviders: Names.parse(list.enabledProviders?.value),
		disabledProviders: Names.parse(list.disabledProviders?.value),
		disabledExtensions: Names.parse(list.disabledExtensions?.value),
	};
}
