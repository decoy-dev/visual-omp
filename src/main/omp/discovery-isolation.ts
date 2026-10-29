/** All MCP capability provider IDs registered by omp 18.14's discovery modules. */
export const OMP_MCP_DISCOVERY_PROVIDERS = [
	"native", "claude", "codex", "gemini", "opencode", "cursor", "windsurf", "vscode", "mcp-json",
	"omp-plugins", "claude-plugins", "agent-plugins",
] as const;

/** Append this process-only overlay last, after all other config layers. No wildcard is supported. */
export const OMP_DISCOVERY_ISOLATION = {
	disabledProviders: OMP_MCP_DISCOVERY_PROVIDERS,
	mcp: { enableProjectConfig: false },
} as const;
