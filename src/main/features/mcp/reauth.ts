import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { McpReauthOptions, McpServerConfig } from "@shared/contracts/mcp";
import { userEnv } from "../../env";
import { runOmp, runOmpJson } from "../../omp/cli";
import { NEUTRAL_CWD } from "../../omp/config-file";
import { OMP_DISCOVERY_ISOLATION } from "../../omp/discovery-isolation";
import { agentDir } from "../../omp/paths";
import { JsonRecord, validateServerName } from "./config";
import { readDocument } from "./store";
import { parseMcpDiscoverySettings } from "./settings";
import { confirmServerExecution } from "./trust";

const REAUTH_TIMEOUT_MS = 6 * 60_000;

/** Authorize exactly one saved native entry, preserving omp's own credential writes. */
export async function reauthorizeServer(name: string, options: McpReauthOptions): Promise<void> {
	const problem = validateServerName(name);
	if (problem) throw new Error(problem);
	if (options.scope !== "user" && options.scope !== "project") throw new Error("Choose the saved server's scope before signing in.");
	if (options.scope === "project" && !options.cwd) throw new Error("Choose a project folder before signing in.");
	const cwd = options.cwd ?? NEUTRAL_CWD;
	const file = options.scope === "project" ? join(cwd, ".omp", "mcp.json") : join(agentDir(await userEnv()), "mcp.json");
	const doc = await readDocument(file);
	const servers = JsonRecord.safeParse(doc.mcpServers);
	const selected = JsonRecord.safeParse(servers.success ? servers.data[name] : undefined);
	if (!selected.success) throw new Error(`Server "${name}" was not found in the selected scope. Save it there before signing in.`);
	const config = selected.data as McpServerConfig;
	if (config.type !== "http" && config.type !== "sse") throw new Error("Browser sign-in requires an HTTP or SSE server.");
	// Reading the selected JSON definition is inert. Permission precedes project settings reads,
	// environment/file substitutions, and every omp process launched for this invocation.
	await confirmServerExecution(name, config, cwd, options.scope, "sign-in");
	const fresh = await readDocument(file);
	const freshServers = JsonRecord.safeParse(fresh.mcpServers);
	if (!freshServers.success || !isDeepStrictEqual(freshServers.data[name], config)) throw new Error("This server's configuration changed. Review it before signing in again.");
	if (options.scope === "project") {
		const settings = parseMcpDiscoverySettings(await runOmpJson(["config", "list", "--json"], { cwd, timeoutMs: 20_000 }));
		if (!settings.enableProjectConfig) throw new Error("Project MCP servers are turned off in omp settings. Turn on mcp.enableProjectConfig before signing in.");
	}
	const privateDir = await mkdtemp(join(tmpdir(), "visual-omp-mcp-auth-"));
	try {
		const overlay = join(privateDir, "config.json");
		// disabledProviders belongs at the registry root, not under mcp. Direct native reauth lookup
		// ignores discovery providers, so only the selected entry contacts a server or writes auth.
		await writeFile(overlay, JSON.stringify({ ...OMP_DISCOVERY_ISOLATION, mcp: { enableProjectConfig: options.scope === "project" } }), { mode: 0o600 });
		const argv = ["--no-session", "--no-title", "--no-extensions", "--no-tools", "--no-lsp", "--no-skills", "--no-rules", "--no-context-files", "--config", overlay, "-p", `/mcp reauth ${name}`];
		const result = await runOmp(argv, { cwd, timeoutMs: REAUTH_TIMEOUT_MS });
		if (result.code !== 0) {
			const output = result.stderr.trim() || result.stdout.trim();
			throw new Error(`omp MCP sign-in exited with ${result.code}.${output ? `\n${output}` : ""}`);
		}
	} finally {
		await rm(privateDir, { recursive: true, force: true });
	}
}
