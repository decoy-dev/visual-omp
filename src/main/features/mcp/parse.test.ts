import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpDiscoverySettings } from "@shared/contracts/mcp";
import { SseParser, splitLines } from "./client";
import { expandEnvVars, parseEntry } from "./config";
import { type DiscoveredRow, resolveEntries } from "./discovery";
import { addServer, parseDocument, serializeDocument, setListMember, updateServer } from "./document";
import { MCP_PRESETS, buildPresetConfig } from "./presets";
import { buildOpenCodeServer, mergeRecords, parseCodexToml, parseMcpServersJson, parseOpenCodeLayer, parseVscodeJson, stripJsonc } from "./sources";

const fixture = (name: string): string => readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("omp-native mcp.json documents", () => {
	it("re-serializes an omp-written file byte-identically", () => {
		const text = fixture("user-mcp.json");
		expect(serializeDocument(parseDocument(text))).toBe(text);
	});

	it("keeps unknown top-level keys, unknown server fields and order; inserts $schema first", () => {
		const doc = parseDocument(JSON.stringify({ custom: 1, mcpServers: { a: { command: "x", extra: { deep: true } } } }));
		const out = JSON.parse(serializeDocument(addServer(doc, "b", { type: "http", url: "https://e.x/mcp", note: "kept" }, "f")));
		expect(Object.keys(out)).toEqual(["$schema", "custom", "mcpServers"]);
		expect(out.mcpServers).toEqual({ a: { command: "x", extra: { deep: true } }, b: { type: "http", url: "https://e.x/mcp", note: "kept" } });
	});

	it("rejects duplicates, bad names and configs omp rejects", () => {
		const doc = parseDocument(fixture("user-mcp.json"));
		expect(() => addServer(doc, "storeleads", { command: "x" }, "f")).toThrow(/already exists/);
		expect(() => addServer(doc, "two  spaces", { command: "x" }, "f")).toThrow(/single spaces/);
		expect(() => addServer(doc, "ns:name", { command: "x", url: "https://x" }, "f")).toThrow(/both "command" and "url"/);
		expect(() => addServer(doc, "remote", { type: "sse" }, "f")).toThrow(/sse server requires "url"/);
	});

	it("renames in place and refuses to clobber another server", () => {
		const doc = parseDocument(fixture("user-mcp.json"));
		const renamed = updateServer(doc, "storeleads", { type: "http", url: "https://s/mcp" }, "f", "leads");
		expect(Object.keys(renamed.mcpServers as object)).toEqual(["leads", "instantly"]);
		expect(() => updateServer(doc, "storeleads", { command: "x" }, "f", "instantly")).toThrow(/already exists/);
	});

	it("keeps override lists sorted and drops them when empty", () => {
		let doc = setListMember({ mcpServers: {} }, "disabledServers", "zeta", true);
		doc = setListMember(doc, "disabledServers", "alpha", true);
		expect(doc.disabledServers).toEqual(["alpha", "zeta"]);
		doc = setListMember(setListMember(doc, "disabledServers", "alpha", false), "disabledServers", "zeta", false);
		expect("disabledServers" in doc).toBe(false);
	});
});

describe("entry normalization and ${VAR} expansion", () => {
	it("applies the native provider's coercions and reports ignored fields", () => {
		const parsed = parseEntry("s", { command: "npx", enabled: "False", timeout: "1500", args: "nope", custom: 1 }, "native", {});
		expect(parsed.config).toEqual({ command: "npx", enabled: false, timeout: 1500, custom: 1 });
		expect(parsed.errors).toEqual(['"args" must be an array of strings; ignored']);
		expect(parseEntry("s", { command: "x", enabled: "false" }, "mcp-json", {}).config.enabled).toBeUndefined();
	});

	it("follows omp's ${VAR} / ${VAR:-default} rules", () => {
		const unresolved = new Set<string>();
		const env = { EMPTY: "", SET: "v" };
		expect(expandEnvVars("${SET}|${EMPTY}|${EMPTY:-d}|${UNSET:-u}|${UNSET}", env, unresolved)).toBe("v||d|u|${UNSET}");
		expect([...unresolved]).toEqual(["UNSET"]);
	});

	it("keeps the as-written form for omp-owned files and expands foreign ones", () => {
		const text = JSON.stringify({ mcpServers: { g: { type: "http", url: "https://h/${ID}", cwd: "/ignored" } } });
		const native = parseMcpServersJson(text, "native", { ID: "7" }).servers[0];
		expect(native?.config.url).toBe("https://h/${ID}");
		expect(native?.effective.url).toBe("https://h/7");
		const claude = parseMcpServersJson(text, "foreign", { ID: "7" }).servers[0];
		expect(claude?.config).toEqual({ type: "http", url: "https://h/7" });
	});
});

describe("foreign sources", () => {
	it("translates Codex config.toml like omp", () => {
		const parsed = parseCodexToml(fixture("codex-config.toml"), "/home/u/.codex/config.toml", {});
		expect(parsed.error).toBeNull();
		expect(parsed.servers.map(server => [server.name, server.config])).toEqual([
			["shadcnio", { url: "https://www.shadcn.io/api/mcp?token=REDACTED", type: "http" }],
			["magicui", { command: "npx", args: ["-y", "@magicuidesign/mcp@latest"], type: "stdio" }],
		]);
		const extra = parseCodexToml(
			'[mcp_servers.x]\ncommand = "./bin/srv"\ncwd = "server"\nenv_vars = ["TOKEN"]\nbearer_token_env_var = "TOKEN"\ntool_timeout_sec = 2\nenabled = false\n',
			"/p/.codex/config.toml",
			{ TOKEN: "t" },
		).servers[0];
		expect(extra?.config).toEqual({
			enabled: false,
			command: "/p/.codex/server/bin/srv",
			cwd: "/p/.codex/server",
			env: { TOKEN: "t" },
			headers: { Authorization: "Bearer t" },
			type: "stdio",
			timeout: 2000,
		});
		expect(parseCodexToml("[mcp_servers", "/c", {}).error).toMatch(/Invalid TOML/);
	});

	it("reads OpenCode JSONC layers and merges them", () => {
		const jsonc = `{
			// comment with "quotes"
			"mcp": {
				"local": { "type": "local", "command": ["npx", "-y", "pkg"], "environment": { "URL": "http://a//b" }, }, /* block */
				"remote": { "type": "remote", "url": "https://r/mcp" },
			},
		}`;
		expect(JSON.parse(stripJsonc(jsonc)).mcp.local.environment.URL).toBe("http://a//b");
		const base = parseOpenCodeLayer(jsonc).mcp;
		const override = parseOpenCodeLayer('{ "mcp": { "remote": { "enabled": false } } }').mcp;
		const merged = mergeRecords(base, override);
		expect(buildOpenCodeServer("local", merged.local as Record<string, unknown>).config).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "pkg"],
			env: { URL: "http://a//b" },
		});
		expect(buildOpenCodeServer("remote", merged.remote as Record<string, unknown>).config).toEqual({
			type: "http",
			url: "https://r/mcp",
			enabled: false,
		});
	});

	it("reads VS Code's mcp.servers with the transport key", () => {
		const parsed = parseVscodeJson(JSON.stringify({ mcp: { servers: { v: { transport: "sse", url: "https://v/sse" } } } }), {});
		expect(parsed.servers[0]?.config).toEqual({ type: "sse", url: "https://v/sse" });
		expect(parseVscodeJson(JSON.stringify({ servers: { v: { command: "x" } } }), {}).servers).toEqual([]);
	});

	it("reports Cursor files without mcpServers", () => {
		expect(parseMcpServersJson("{}", "foreign", {}, { requireKey: true }).error).toBe("Missing 'mcpServers' key");
		expect(parseMcpServersJson("{", "native", {}).error).toMatch(/Invalid JSON/);
	});
});

describe("status resolution", () => {
	const settings: McpDiscoverySettings = {
		enableProjectConfig: true,
		browserEnabled: true,
		enabledProviders: [],
		disabledProviders: [],
		disabledExtensions: ["mcp:ext"],
	};
	const row = (name: string, config: Record<string, unknown>, provider: DiscoveredRow["provider"], level: DiscoveredRow["level"] = "user"): DiscoveredRow => ({
		server: parseEntry(name, config, provider === "native" ? "native" : "foreign", {}),
		provider,
		providerName: provider,
		path: `/${provider}/${level}.json`,
		level,
	});

	it("mirrors omp's suppression, dedupe, validation and filters", () => {
		const rows = [
			row("off", { command: "a", enabled: false }, "native", "project"),
			row("off", { command: "b" }, "native"),
			row("denied", { command: "c" }, "native"),
			row("forced", { command: "d", enabled: false }, "claude"),
			row("dup", { command: "e" }, "native"),
			row("alias", { command: "e" }, "cursor"),
			row("broken", { args: ["x"] }, "native"),
			row("exa", { type: "http", url: "https://mcp.exa.ai/mcp" }, "native"),
			row("pw", { command: "npx", args: ["@playwright/mcp"] }, "native"),
			row("ext", { command: "f" }, "native"),
			row("ext", { command: "g" }, "cursor"),
		];
		const entries = resolveEntries(rows, {
			settings,
			disabledServers: ["denied"],
			enabledServers: ["forced"],
			editablePaths: ["/native/user.json"],
		});
		expect(entries.map(entry => [entry.name, entry.provider, entry.status])).toEqual([
			["off", "native", "disabled"],
			["off", "native", "shadowed"],
			["denied", "native", "denied"],
			["forced", "claude", "active"],
			["dup", "native", "active"],
			["alias", "cursor", "shadowed"],
			["broken", "native", "invalid"],
			["exa", "native", "exa-filtered"],
			["pw", "native", "browser-filtered"],
			["ext", "native", "extension-disabled"],
			["ext", "cursor", "extension-disabled"],
		]);
		expect(entries[5]?.shadowedBy).toEqual({ name: "dup", path: "/native/user.json" });
		expect(entries[1]?.editable).toBe(true);
		const excluded = resolveEntries([row("p", { command: "x" }, "native", "project")], {
			settings: { ...settings, enableProjectConfig: false },
			disabledServers: [],
			enabledServers: [],
			editablePaths: [],
		});
		expect(excluded[0]?.status).toBe("excluded");
	});
});

describe("wire framing", () => {
	it("parses SSE across arbitrary chunk boundaries, including split CRLF", () => {
		const parser = new SseParser();
		const stream = ": ping\r\nevent: endpoint\r\ndata: /messages?s=1\r\n\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n";
		const events = [...stream].flatMap(char => parser.push(char));
		expect(events).toEqual([
			{ event: "endpoint", data: "/messages?s=1", id: null },
			{ event: "message", data: '{"a":\n1}', id: null },
		]);
	});

	it("splits newline-delimited JSON keeping the partial tail", () => {
		expect(splitLines('{"a":1}\r\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' });
	});
});

describe("presets", () => {
	const preset = (id: string) => {
		const found = MCP_PRESETS.find(item => item.id === id);
		if (!found) throw new Error(id);
		return found;
	};

	it("expands path lists, drops empty optional values and enforces required fields", () => {
		expect(buildPresetConfig(preset("filesystem"), { directories: ["/a", " /b "] }).args).toEqual([
			"-y",
			"@modelcontextprotocol/server-filesystem",
			"/a",
			"/b",
		]);
		expect(buildPresetConfig(preset("context7"), {})).toEqual({ command: "npx", args: ["-y", "@upstash/context7-mcp"] });
		expect(buildPresetConfig(preset("github"), { token: "${GITHUB_TOKEN}" }).headers).toEqual({
			Authorization: "Bearer ${GITHUB_TOKEN}",
		});
		expect(() => buildPresetConfig(preset("brave-search"), { apiKey: "  " })).toThrow(/API key is required/);
	});

	it("only ships templates omp would accept once filled", () => {
		for (const item of MCP_PRESETS) {
			const values = Object.fromEntries(item.fields.map(field => [field.id, field.kind === "paths" ? ["/x"] : "v"]));
			const config = buildPresetConfig(item, values);
			expect(JSON.stringify(config)).not.toContain("{{");
			expect(config.command ?? config.url).toBeTruthy();
		}
	});
});
