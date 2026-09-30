/**
 * Curated MCP servers. Package names verified on the npm / PyPI registries and endpoints against their hosts
 * (2026-09). Templates use `{{fieldId}}` tokens filled by {@link buildPresetConfig}.
 */
import type { McpPreset, McpPresetField, McpServerConfig } from "@shared/contracts/mcp";

function field(
	id: string,
	label: string,
	kind: McpPresetField["kind"],
	target: McpPresetField["target"],
	required: boolean,
	description: string,
	placeholder: string | null = null,
): McpPresetField {
	return { id, label, kind, target, required, description, placeholder };
}

const BROWSER_NOTE =
	"omp hides browser-automation MCP servers while its built-in browser is enabled; set browser.enabled: false in omp settings to use this one.";
const OAUTH_NOTE = "Signs in with OAuth: after adding it, run /mcp reauth <name> inside omp.";

export const MCP_PRESETS: McpPreset[] = [
	{
		id: "filesystem",
		label: "Filesystem",
		description: "Read, write, search and move files inside the directories you allow.",
		category: "reference",
		homepage: "https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem",
		suggestedName: "filesystem",
		transport: "stdio",
		template: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "{{directories}}"] },
		fields: [field("directories", "Allowed directories", "paths", "arg", true, "Absolute paths the server may access.", "/Users/me/projects")],
		requires: ["npx"],
		oauth: false,
		note: null,
	},
	{
		id: "memory",
		label: "Memory",
		description: "A persistent knowledge-graph memory the agent can read and update across sessions.",
		category: "reference",
		homepage: "https://www.npmjs.com/package/@modelcontextprotocol/server-memory",
		suggestedName: "memory",
		transport: "stdio",
		template: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { MEMORY_FILE_PATH: "{{memoryFile}}" } },
		fields: [
			field("memoryFile", "Memory file", "path", "env", false, "Where the graph is stored (default: next to the package).", "/Users/me/.mcp-memory.json"),
		],
		requires: ["npx"],
		oauth: false,
		note: null,
	},
	{
		id: "sequential-thinking",
		label: "Sequential Thinking",
		description: "Structured, revisable step-by-step reasoning tool.",
		category: "reference",
		homepage: "https://www.npmjs.com/package/@modelcontextprotocol/server-sequential-thinking",
		suggestedName: "sequential-thinking",
		transport: "stdio",
		template: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
		fields: [],
		requires: ["npx"],
		oauth: false,
		note: null,
	},
	{
		id: "everything",
		label: "Everything (test server)",
		description: "The MCP reference test server exercising tools, prompts and resources — handy to check a setup.",
		category: "reference",
		homepage: "https://www.npmjs.com/package/@modelcontextprotocol/server-everything",
		suggestedName: "everything",
		transport: "stdio",
		template: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
		fields: [],
		requires: ["npx"],
		oauth: false,
		note: null,
	},
	{
		id: "fetch",
		label: "Fetch",
		description: "Fetch web pages and convert them to Markdown.",
		category: "web",
		homepage: "https://pypi.org/project/mcp-server-fetch/",
		suggestedName: "fetch",
		transport: "stdio",
		template: { command: "uvx", args: ["mcp-server-fetch"] },
		fields: [],
		requires: ["uvx"],
		oauth: false,
		note: null,
	},
	{
		id: "git",
		label: "Git",
		description: "Inspect and operate on a local Git repository (status, diff, log, commit, branches).",
		category: "developer",
		homepage: "https://pypi.org/project/mcp-server-git/",
		suggestedName: "git",
		transport: "stdio",
		template: { command: "uvx", args: ["mcp-server-git", "--repository", "{{repository}}"] },
		fields: [field("repository", "Repository", "path", "arg", true, "Path of the Git repository.", "/Users/me/projects/app")],
		requires: ["uvx"],
		oauth: false,
		note: null,
	},
	{
		id: "time",
		label: "Time",
		description: "Current time and time-zone conversions.",
		category: "reference",
		homepage: "https://pypi.org/project/mcp-server-time/",
		suggestedName: "time",
		transport: "stdio",
		template: { command: "uvx", args: ["mcp-server-time"] },
		fields: [],
		requires: ["uvx"],
		oauth: false,
		note: null,
	},
	{
		id: "context7",
		label: "Context7",
		description: "Up-to-date, version-specific library documentation and code examples.",
		category: "knowledge",
		homepage: "https://www.npmjs.com/package/@upstash/context7-mcp",
		suggestedName: "context7",
		transport: "stdio",
		template: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { CONTEXT7_API_KEY: "{{apiKey}}" } },
		fields: [field("apiKey", "API key", "secret", "env", false, "Optional; raises rate limits (context7.com/dashboard).", "ctx7sk-…")],
		requires: ["npx"],
		oauth: false,
		note: null,
	},
	{
		id: "github",
		label: "GitHub",
		description: "GitHub's hosted MCP server: repositories, issues, pull requests, Actions.",
		category: "developer",
		homepage: "https://github.com/github/github-mcp-server",
		suggestedName: "github",
		transport: "http",
		template: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer {{token}}" } },
		fields: [
			field(
				"token",
				"Personal access token",
				"secret",
				"header",
				true,
				"A GitHub PAT. Tip: enter an env var reference like ${GITHUB_TOKEN} to keep it out of the file.",
				"github_pat_…",
			),
		],
		requires: [],
		oauth: false,
		note: null,
	},
	{
		id: "github-docker",
		label: "GitHub (local Docker)",
		description: "GitHub's official MCP server running locally in Docker.",
		category: "developer",
		homepage: "https://github.com/github/github-mcp-server",
		suggestedName: "github",
		transport: "stdio",
		template: {
			command: "docker",
			args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{token}}" },
		},
		fields: [
			field(
				"token",
				"Personal access token",
				"secret",
				"env",
				true,
				"A GitHub PAT, or the name of an environment variable holding it (omp resolves env var names).",
				"GITHUB_PERSONAL_ACCESS_TOKEN",
			),
		],
		requires: ["docker"],
		oauth: false,
		note: null,
	},
	{
		id: "playwright",
		label: "Playwright",
		description: "Drive a real browser through Playwright's accessibility snapshots.",
		category: "web",
		homepage: "https://www.npmjs.com/package/@playwright/mcp",
		suggestedName: "playwright",
		transport: "stdio",
		template: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
		fields: [],
		requires: ["npx"],
		oauth: false,
		note: BROWSER_NOTE,
	},
	{
		id: "chrome-devtools",
		label: "Chrome DevTools",
		description: "Inspect, debug and profile a live Chrome instance via DevTools.",
		category: "web",
		homepage: "https://www.npmjs.com/package/chrome-devtools-mcp",
		suggestedName: "chrome-devtools",
		transport: "stdio",
		template: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
		fields: [],
		requires: ["npx"],
		oauth: false,
		note: null,
	},
	{
		id: "brave-search",
		label: "Brave Search",
		description: "Web, news, image and local search via the Brave Search API.",
		category: "web",
		homepage: "https://www.npmjs.com/package/@brave/brave-search-mcp-server",
		suggestedName: "brave-search",
		transport: "stdio",
		template: { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "{{apiKey}}" } },
		fields: [field("apiKey", "API key", "secret", "env", true, "Brave Search API key (api-dashboard.search.brave.com).", "BSA…")],
		requires: ["npx"],
		oauth: false,
		note: null,
	},
	{
		id: "notion",
		label: "Notion",
		description: "Notion's hosted MCP server: search, read and edit pages and databases.",
		category: "productivity",
		homepage: "https://developers.notion.com/docs/mcp",
		suggestedName: "notion",
		transport: "http",
		template: { type: "http", url: "https://mcp.notion.com/mcp" },
		fields: [],
		requires: [],
		oauth: true,
		note: OAUTH_NOTE,
	},
	{
		id: "notion-local",
		label: "Notion (integration token)",
		description: "Notion's open-source MCP server using an internal integration token.",
		category: "productivity",
		homepage: "https://www.npmjs.com/package/@notionhq/notion-mcp-server",
		suggestedName: "notion",
		transport: "stdio",
		template: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: "{{token}}" } },
		fields: [field("token", "Integration token", "secret", "env", true, "Internal integration secret from notion.so/profile/integrations.", "ntn_…")],
		requires: ["npx"],
		oauth: false,
		note: null,
	},
	{
		id: "linear",
		label: "Linear",
		description: "Linear's hosted MCP server: issues, projects and comments.",
		category: "productivity",
		homepage: "https://linear.app/docs/mcp",
		suggestedName: "linear",
		transport: "http",
		template: { type: "http", url: "https://mcp.linear.app/mcp" },
		fields: [],
		requires: [],
		oauth: true,
		note: OAUTH_NOTE,
	},
	{
		id: "sentry",
		label: "Sentry",
		description: "Sentry's hosted MCP server: issues, events, releases and Seer analysis.",
		category: "developer",
		homepage: "https://docs.sentry.io/product/sentry-mcp/",
		suggestedName: "sentry",
		transport: "http",
		template: { type: "http", url: "https://mcp.sentry.dev/mcp" },
		fields: [],
		requires: [],
		oauth: true,
		note: OAUTH_NOTE,
	},
];

const TOKEN = /\{\{(\w+)\}\}/g;

function fill(text: string, values: Record<string, string>): string {
	return text.replace(TOKEN, (_match, id: string) => values[id] ?? "");
}

function tokensOf(text: string): string[] {
	return [...text.matchAll(TOKEN)].flatMap(match => (match[1] ? [match[1]] : []));
}

/**
 * Fill a preset's template. A `paths` field expands its whole-token arg into one arg per path; an optional field
 * left empty drops the env/header entry or arg that references it. Throws on a missing required field.
 */
export function buildPresetConfig(preset: McpPreset, values: Record<string, string | string[]>): McpServerConfig {
	const scalar: Record<string, string> = {};
	const lists: Record<string, string[]> = {};
	const empty = new Set<string>();
	for (const item of preset.fields) {
		const value = values[item.id];
		const list = (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(entry => entry.trim()).filter(Boolean);
		if (list.length === 0) {
			if (item.required) throw new Error(`${item.label} is required`);
			empty.add(item.id);
		}
		lists[item.id] = list;
		scalar[item.id] = list.join(" ");
	}
	const usesEmpty = (text: string): boolean => tokensOf(text).some(id => empty.has(id));
	const config: McpServerConfig = { ...preset.template };
	const templateArgs = preset.template.args;
	if (templateArgs) {
		config.args = templateArgs.flatMap(arg => {
			const whole = /^\{\{(\w+)\}\}$/.exec(arg)?.[1];
			if (whole && preset.fields.some(item => item.id === whole && item.kind === "paths")) return lists[whole] ?? [];
			return usesEmpty(arg) ? [] : [fill(arg, scalar)];
		});
	}
	for (const key of ["env", "headers"] as const) {
		const record = preset.template[key];
		if (!record) continue;
		const filled: Record<string, string> = {};
		for (const [name, value] of Object.entries(record)) if (!usesEmpty(value)) filled[name] = fill(value, scalar);
		if (Object.keys(filled).length > 0) config[key] = filled;
		else delete config[key];
	}
	if (preset.template.url) config.url = fill(preset.template.url, scalar);
	return config;
}
